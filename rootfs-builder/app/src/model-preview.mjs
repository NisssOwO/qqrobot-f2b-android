import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { atomicJson } from './gateway/text-bridge.mjs';
import { createConversation } from './conversation.mjs';

export function validateModelConfig(raw, previous = null) {
  const url = new URL(raw.baseUrl);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname) || /(?:^|\.)(?:localhost|local|internal)$/i.test(url.hostname) || !/^\/[A-Za-z0-9/_-]*$/.test(url.pathname)) throw new TypeError('请输入无凭据、无查询参数的 HTTPS 模型地址，使用默认 443 端口');
  if (typeof raw.model !== 'string' || !/^[A-Za-z0-9_./:-]{1,128}$/.test(raw.model)) throw new TypeError('模型名称无效');
  const apiKey = raw.apiKey === '' && previous ? previous.apiKey : raw.apiKey;
  if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 8192 || /[\r\n\x00]/.test(apiKey)) throw new TypeError('请填写模型密钥');
  if (previous && raw.apiKey === '' && url.href.replace(/\/$/, '') !== previous.baseUrl) throw new TypeError('更换地址时必须重新填写密钥');
  return { baseUrl: url.href.replace(/\/$/, ''), model: raw.model, apiKey, revision: randomBytes(12).toString('hex') };
}
// promptFor() hands the caller a chance to point the preview at the editable
// role cards on the data volume instead of the ones baked into the image.
export function createModelPreview({ root, dataDir, roleIds, chatFactory = createConversation, onChange = null, promptFor = null }) {
  const roleOptions = () => (promptFor ? promptFor() : {});
  const file = path.join(dataDir, 'model-config.json');
  let config = null, chat = null, busy = false;
  const guard = globalThis[Symbol.for('qqrobot.termux.c.guard')];
  const egress = base => { if (!guard?.setModelEndpoint) throw new Error('Model network guard unavailable'); guard.setModelEndpoint(base); };
  if (fs.existsSync(file)) {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    const checked = validateModelConfig(stored);
    if (!/^[a-f0-9]{24}$/.test(stored.revision)) throw new Error('Invalid model configuration revision');
    config = { ...checked, revision: stored.revision };
    egress(config.baseUrl);
  }
  const status = () => ({ configured: !!config, busy, baseUrl: config?.baseUrl ?? '', model: config?.model ?? '', keyPresent: !!config?.apiKey, scope: 'local-preview-only' });
  return {
    status,
    current: () => config,
    async configure(input) {
      if (busy) throw new Error('试聊进行中，请稍后修改配置');
      const next = validateModelConfig(input, config);
      busy = true;
      try {
        // Persist first; a write failure must leave the prior usable config intact.
        atomicJson(file, next);
        await chat?.close(); chat = null; config = next; egress(next.baseUrl);
        if (onChange) await onChange(config);
      } finally { busy = false; }
      return status();
    },
    async clear() {
      if (busy) throw new Error('试聊进行中，请稍后清除配置');
      busy = true;
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file);
        await chat?.close(); chat = null; config = null; egress(null);
        if (onChange) await onChange(null);
      } finally { busy = false; }
      return status();
    },
    async reply({ text, role }) {
      if (!config) throw new Error('请先配置文字模型');
      if (busy) throw new Error('试聊正在进行，请勿重复提交');
      if (!roleIds.includes(role) || typeof text !== 'string' || !text.trim() || text.length > 8000) throw new Error('角色或文字无效');
      busy = true;
      try {
        chat ??= chatFactory({ root, dataDir: path.join(dataDir, 'model-preview', config.revision), baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model, timeoutMs: 60000, ...roleOptions() });
        const reply = await chat.reply({ scene: 'private', peerId: '1', senderId: '1', role, text });
        if (typeof reply !== 'string' || !reply.trim() || reply.length > 16000 || reply.includes(config.apiKey)) throw new Error('Invalid model reply');
        return { reply, role, scope: 'local-preview-only', qqSent: false };
      } catch { throw new Error('模型试聊失败；请检查地址、模型、密钥与网络，不会自动重试或发送 QQ'); }
      finally { busy = false; }
    },
    async testOnce(input) {
      if (busy) throw new Error('试聊进行中');
      const once = validateModelConfig(input);
      const { text, role } = input;
      if (!roleIds.includes(role) || typeof text !== 'string' || !text.trim() || text.length > 8000) throw new Error('角色或文字无效');
      busy = true; let temporary, onceChat;
      const attemptsBefore = guard?.explicitModelFetches ?? 0;
      try {
        fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        temporary = fs.mkdtempSync(path.join(dataDir, 'model-once-'));
        egress(once.baseUrl);
        onceChat = chatFactory({ root, dataDir: temporary, baseUrl: once.baseUrl, apiKey: once.apiKey, model: once.model, timeoutMs: 60000, ...roleOptions() });
        const reply = await onceChat.reply({ scene: 'private', peerId: '1', senderId: '1', role, text });
        if (typeof reply !== 'string' || !reply.trim() || reply.length > 16000 || reply.includes(once.apiKey)) throw new Error('Invalid model reply');
        return { reply, role, scope: 'one-shot-local-preview', qqSent: false, keySaved: false, upstreamRequests: (guard?.explicitModelFetches ?? 0) - attemptsBefore };
      } catch { throw new Error('单次模型试聊失败；不会自动重试或发送 QQ'); }
      finally {
        try { await onceChat?.close(); }
        finally {
          egress(config?.baseUrl ?? null); busy = false;
          if (temporary && path.dirname(path.resolve(temporary)) === path.resolve(dataDir) && path.basename(temporary).startsWith('model-once-')) fs.rmSync(temporary, { recursive: true, force: true });
        }
      }
    },
    async close() { await chat?.close(); chat = null; egress(null); }
  };
}
