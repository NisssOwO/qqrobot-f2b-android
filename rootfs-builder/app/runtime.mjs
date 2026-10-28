import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as sdk from '@acidify/core';
import { QuietHours, parseHm } from './src/quiet-hours.mjs';
import { TextBridge, atomicJson, validatePolicy } from './src/gateway/text-bridge.mjs';
import { makeSdkFixture } from './src/gateway/acidify-message.mjs';
import { normalizeOneBotMessage } from './src/gateway/onebot-message.mjs';
import { OneBotTextPort } from './src/gateway/onebot-port.mjs';
import { createConversation } from './src/conversation.mjs';
import { createModelPreview } from './src/model-preview.mjs';
import { serviceCommand } from './service.mjs';
import { createBackup, listBackups, readBackup, stageRestore, MAX_BACKUP_BYTES } from './src/data-backup.mjs';
import { selectData, listRestores } from './src/data-selection.mjs';

// Explicit local OneBot gateway contract. The gateway is enabled only when the
// config carries an authenticated local account, never through remote control.
function gatewayConfig(raw, selfId) {
  const value = raw?.gateway;
  if (value == null || value.enabled === false || value.type == null) return null;
  if (value.enabled !== true || value.type !== 'onebot') throw new Error('网关仅支持本机 OneBot');
  if (typeof value.url !== 'string' || typeof value.token !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(value.token)) throw new Error('OneBot 网关需配置本地地址与访问令牌');
  const endpoint = new URL(value.url);
  if (endpoint.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname) || !endpoint.port || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw new Error('OneBot 网关仅接受本机正向 WebSocket');
  return Object.freeze({ type: 'onebot', enabled: true, url: endpoint.href, token: value.token, selfId: String(selfId) });
}

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Role cards (人格卡) live on the data volume so edits survive a container
// rebuild; the copy inside the image is only the first-boot seed. The directory
// is resolved per call so the acceptance harness, which has no /data, keeps
// reading the seed copy.
const PROMPTS_DIR = process.env.QQROBOT_PROMPTS_DIR || '/data/prompts';
const SEED_PROMPTS_DIR = path.join(ROOT, 'resources/prompts');
const ROLE_LIMITS = Object.freeze({ nameMax: 40, contentMaxBytes: 65536, injectMaxChars: 8000 });
// text-chat.md is the agent preset prompt, not a persona.
const NOT_A_ROLE = new Set(['text-chat']);

function promptDir() {
  try { fs.accessSync(PROMPTS_DIR, fs.constants.W_OK); return PROMPTS_DIR; } catch { return SEED_PROMPTS_DIR; }
}

// The display name is the first line of the card ("# 角色卡：七草日花（七草にちか）").
// The seed cards are checked out with CRLF on Windows, and `.` never matches a
// line terminator, so the trailing \r has to go before the heading is matched.
function roleTitle(id) {
  try {
    const head = fs.readFileSync(path.join(promptDir(), id + '.md'), 'utf8').split('\n', 1)[0].replace(/\r$/, '');
    const match = /^#\s*角色卡[：:]\s*(.+)$/.exec(head);
    if (match) return match[1].replace(/[（(][^）)]*[）)]\s*$/, '').trim() || id;
  } catch {}
  return id;
}

// A role id becomes a file name, so it must not carry separators or control
// characters (and it has to stay inside the prompts directory).
function safeRoleId(id) {
  return typeof id === 'string' && id.length >= 1 && id.length <= ROLE_LIMITS.nameMax
    && !/[/\\\x00-\x1f]/.test(id) && id !== '.' && id !== '..';
}

function scanRoles() {
  let names;
  try { names = fs.readdirSync(promptDir()); } catch { return []; }
  return names
    .filter(name => name.endsWith('.md'))
    .map(name => name.slice(0, -3))
    .filter(id => safeRoleId(id) && !NOT_A_ROLE.has(id))
    .sort()
    .map(id => ({ id, name: roleTitle(id), file: id + '.md' }));
}

const PACK_LIMITS = Object.freeze({ aliases: 32, aliasMax: 40, worldMax: 120 });

function packFile(id) { return path.join(promptDir(), id + '.pack.json'); }

// A role pack is optional metadata that lives beside the card. Anything malformed
// in a hand-edited file falls back to empty values instead of breaking the panel.
// voiceId/dictionary are preserved for shape compatibility with the desktop
// edition; this build has no TTS, so they stay empty unless someone fills them.
function readPack(id) {
  try {
    const raw = JSON.parse(fs.readFileSync(packFile(id), 'utf8'));
    const aliases = Array.isArray(raw.aliases)
      ? [...new Set(raw.aliases.filter(a => typeof a === 'string').map(a => a.trim()).filter(Boolean))].slice(0, PACK_LIMITS.aliases)
      : [];
    return {
      aliases,
      worldName: typeof raw.worldName === 'string' ? raw.worldName.trim().slice(0, PACK_LIMITS.worldMax) : '',
      voiceId: typeof raw.voiceId === 'string' ? raw.voiceId : '',
      dictionary: raw.dictionary && typeof raw.dictionary === 'object' && !Array.isArray(raw.dictionary) ? raw.dictionary : {},
    };
  } catch { return { aliases: [], worldName: '', voiceId: '', dictionary: {} }; }
}

function writePack(id, patch) {
  const previous = readPack(id);
  const next = {
    role: roleTitle(id),
    roleFile: id + '.md',
    voiceId: previous.voiceId,
    dictionary: previous.dictionary,
    aliases: patch.aliases,
    worldName: patch.worldName,
  };
  fs.mkdirSync(promptDir(), { recursive: true });
  atomicJson(packFile(id), next);
  return next;
}

function roleStats(content) {
  // The browser normalises textarea values to LF, so count the same way the
  // editor does; otherwise a CRLF card reports a size the user cannot see.
  const text = String(content ?? '').replace(/\r\n/g, '\n');
  return {
    chars: text.length,
    bytes: Buffer.byteLength(text, 'utf8'),
    lines: text.split('\n').length,
    truncated: text.length > ROLE_LIMITS.injectMaxChars,
    excerpt: text.split('\n').find(line => line.trim() && !line.trim().startsWith('#'))?.trim().slice(0, 80) ?? '',
  };
}

export let roles = scanRoles();
const appVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
// The QQ process and its NapCat payload only exist inside the container image.
// Both are resolved at request time from the environment so the same build runs
// on a device (where the paths exist) and under the acceptance harness (where
// they do not — the login panel then simply reports "no QR code yet").
const QQ_BIN_PATH = process.env.QQ_BIN || '/root/Napcat/opt/QQ/qq';
const NAPCAT_QR_PATH = process.env.NAPCAT_QR_PATH || path.join(path.dirname(QQ_BIN_PATH), 'resources/app/app_launcher/napcat/cache/qrcode.png');
// QQ keeps its credential store here (symlinked to the data volume); the
// per-account nt_qq_* directories are what make a silent re-login possible.
const QQ_USER_DATA_DIR = process.env.QQ_USER_DATA || '/data/qq-user-data';
// pgrep is unreliable inside a proot container (it needs /proc metadata the
// emulation does not expose), so question /proc directly — under udocker the
// container's /proc is the host's, which is exactly what we want to know.
function qqPids() {
  const pids = [];
  let entries;
  try { entries = fs.readdirSync('/proc'); } catch { return pids; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
      if (cmdline.split(' ')[0] === QQ_BIN_PATH) pids.push(Number(entry));
    } catch { /* process vanished or is not ours */ }
  }
  return pids;
}
function loginState() {
  let qr = null;
  try {
    const stat = fs.statSync(NAPCAT_QR_PATH);
    qr = { ageSec: Math.max(0, Math.round((Date.now() - stat.mtimeMs) / 1000)), bytes: stat.size, generatedAt: stat.mtime.toISOString() };
  } catch { qr = null; }
  return { qqAlive: qqPids().length > 0, qr };
}
function validQuiet(raw) {
  if (typeof raw?.enabled !== 'boolean') throw new Error('静默配置无效');
  const weekdays = raw.workday?.weekdays;
  if (!Array.isArray(weekdays) || !weekdays.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) throw new Error('工作日无效');
  for (const section of ['workday', 'offday']) {
    const windows = raw[section]?.windows;
    if (!Array.isArray(windows) || windows.length > 12 || windows.some(w => !Array.isArray(w) || w.length !== 2 || parseHm(w[0]) === null || parseHm(w[1]) === null || parseHm(w[0]) >= parseHm(w[1]))) throw new Error('静默窗口无效；暂不支持跨午夜或24:00');
  }
  return { enabled: raw.enabled, holidays: 'none', workday: { weekdays, windows: raw.workday.windows }, offday: { windows: raw.offday.windows } };
}
// 连发速率配置（对齐 Windows 版 send.maxSendPerMinute=4 / maxSendPerHour=36）。
// 仅透传正整数字段，缺省由 TextBridge 使用默认值。
function validSendRate(raw) {
  if (raw == null) return null;
  const maxSendPerMinute = raw.maxSendPerMinute;
  const maxSendPerHour = raw.maxSendPerHour;
  if (![maxSendPerMinute, maxSendPerHour].every(v => v === undefined || (Number.isInteger(v) && v > 0))) throw new Error('连发速率配置无效');
  const next = {};
  if (Number.isInteger(maxSendPerMinute)) next.maxSendPerMinute = maxSendPerMinute;
  if (Number.isInteger(maxSendPerHour)) next.maxSendPerHour = maxSendPerHour;
  return Object.keys(next).length ? Object.freeze(next) : null;
}
export async function createApplication({ dataDir = path.join(ROOT, 'data'), serviceDataDir, port = 0, bind = '127.0.0.1', password = '', allowedHosts, now = Date.now, fixtureModel, previewChatFactory } = {}) {
  dataDir = path.resolve(dataDir); fs.mkdirSync(dataDir, { recursive: true });
  serviceDataDir = path.resolve(serviceDataDir ?? dataDir);
  const configFile = path.join(dataDir, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(fs.existsSync(configFile) ? configFile : path.join(ROOT, 'config.example.json'), 'utf8'));
  if (cfg.backend !== 'standalone' || cfg.mode !== 'simulation') throw new Error('真实网关尚未开放；仅支持 standalone + simulation');
  cfg.policy = validatePolicy(cfg.policy, roles.map(r => r.id)); cfg.quietHours = validQuiet(cfg.quietHours); const sendRate = cfg.sendRate ? validSendRate(cfg.sendRate) : null; if (sendRate) cfg.sendRate = sendRate; atomicJson(configFile, cfg);
  const gateway = gatewayConfig(cfg, cfg.policy.selfId);
  if (gateway) atomicJson(configFile, { ...cfg, gateway });
  const quiet = new QuietHours({ config: cfg.quietHours, stateDir: dataDir });
  const preview = createModelPreview({ root: ROOT, dataDir, roleIds: roles.map(r => r.id), chatFactory: previewChatFactory, onChange: cfg => applyReplyModel(cfg), promptFor: () => ({ promptDir: promptDir(), injectMaxChars: ROLE_LIMITS.injectMaxChars }) });
  // The page token only guards same-origin form posts. Keep it on disk so that a
  // backend restart (for example when the gateway reconnects) does not invalidate
  // every panel already open in a browser.
  const tokenFile = path.join(dataDir, '.runtime', 'panel-token');
  let token = '';
  try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch {}
  if (!/^[0-9a-f]{64}$/.test(token)) {
    token = randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  }
  let origin, chat, bridge, onebotPort = null, receiptCounter = 0, switching = false;

  // Editing a role card writes the file that every reply re-reads, so an edit is
  // live without restarting a session. The policy layer caches the accepted ids
  // at construction time though, so hand it the fresh list after a change.
  function reloadRoles() {
    roles = scanRoles();
    if (bridge) bridge.roleIds = roles.map(r => r.id);
    return roles;
  }
  const modelRequests = [];
  function json(res, status, data) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); }

  // --- LAN exposure (opt-in) -------------------------------------------
  // When bind is 0.0.0.0 the panel is reachable from other devices, so the
  // loopback-only Host check is replaced by a whitelist and a password gate
  // is enforced. The loopback-only default keeps the original behaviour.
  const exposed = bind === '0.0.0.0';
  const hostAllow = new Set((allowedHosts || []).map(h => String(h).toLowerCase()));
  function hostAllowed(hostHeader) {
    if (!hostHeader) return false;
    const host = hostHeader.toLowerCase();
    if (!exposed) return host === `127.0.0.1:${server.address()?.port ?? port}`;
    if (hostAllow.has(host)) return true;
    const bare = host.replace(/:\d+$/, '');
    if (['127.0.0.1', 'localhost', '[::1]'].includes(bare)) return true;
    // RFC1918 / CGNAT / link-local v4 — private LAN ranges only, never public IPs.
    return /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})(:\d+)?$/.test(host);
  }
  const PASSWORD = exposed ? String(password) : '';
  function passwordOk(req) {
    if (!PASSWORD) return true;
    const raw = req.headers.authorization || '';
    if (!raw.startsWith('Basic ')) return false;
    let decoded = '';
    try { decoded = Buffer.from(raw.slice(6), 'base64').toString('utf8'); } catch { return false; }
    const pass = decoded.slice(decoded.indexOf(':') + 1);
    const a = Buffer.from(pass), b = Buffer.from(PASSWORD);
    // timingSafeEqual throws on length mismatch — guard first, then compare.
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
  function cors(req, res) {
    const origin = req.headers.origin;
    if (!origin) return;
    const u = new URL(origin);
    if (hostAllowed(u.host)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-credentials', 'true');
      res.setHeader('vary', 'Origin');
    }
  }
  async function body(req, max = 65536) { let size = 0; const chunks = []; for await (const chunk of req) { size += chunk.length; if (size > max) throw new Error('请求过大'); chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  function gatewayStatus() { return gateway && onebotPort ? { ...onebotPort.status(), type: 'onebot', selfId: gateway.selfId, url: gateway.url } : null; }
  const status = () => ({ ...bridge.status(), backend: 'standalone', model: 'local-fixture', modelPreview: preview.status(), roles, quietHours: cfg.quietHours, quiet: quiet.state(now()).state, conversation: chat.status(), gateway: gatewayStatus(), sendRate: sendRate ?? { maxSendPerMinute: 4, maxSendPerHour: 36 } });
  const configurePolicy = raw => {
    const next = validatePolicy(raw, roles.map(r => r.id));
    if (next.selfId !== cfg.policy.selfId) throw new Error('更换身份需停止后修改配置并重启');
    atomicJson(configFile, { ...cfg, policy: next }); cfg.policy = next; bridge.updatePolicy(next); return status();
  };
  const configureQuiet = raw => { const next = validQuiet(raw); atomicJson(configFile, { ...cfg, quietHours: next }); cfg.quietHours = next; quiet.configure(next); return status(); };
  const receiveFixture = input => bridge.receiveSdk(makeSdkFixture(input, sdk, cfg.policy.selfId));
  const server = http.createServer(async (req, res) => {
    try {
      cors(req, res);
      if (req.method === 'OPTIONS' && exposed) {
        res.writeHead(204, { 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'authorization,content-type,x-lab-token' });
        return res.end();
      }
      if (!hostAllowed(req.headers.host)) return json(res, 403, { error: 'Host 不匹配' });
      // The internal fixture endpoint is machine-to-machine (the console model call),
      // guarded by the per-process Bearer token below, so it must not require the
      // human login password. Every other route still needs it.
      const internalFixture = req.url.startsWith('/fixture/');
      if (!internalFixture && !passwordOk(req)) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="QQRobot", charset="UTF-8"', 'content-type': 'text/plain; charset=utf-8' });
        return res.end('需要登录口令');
      }
      const url = new URL(req.url, origin);
      if (req.method !== 'GET' && switching) return json(res, 409, { error: '正在切换数据，请等待重启并刷新页面' });
      if (req.method === 'POST' && url.pathname === '/fixture/v1/chat/completions' && req.headers.authorization === `Bearer ${token}`) {
        const input = await body(req, 2097152); modelRequests.push(input); if (modelRequests.length > 12) modelRequests.shift();
        if (fixtureModel) return json(res, 200, await fixtureModel(input));
        const system = input.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
        // Match on the head of the card: the injected prompt is LF-normalised and
        // possibly truncated, so comparing the whole raw file never matches.
        const role = roles.find(r => {
          try {
            const card = fs.readFileSync(path.join(promptDir(), r.id + '.md'), 'utf8').replace(/\r\n/g, '\n').trim();
            return card.length > 0 && typeof system === 'string' && system.includes(card.slice(0, 200));
          } catch { return false; }
        })?.name || '未识别角色';
        const users = input.messages.filter(m => m.role === 'user');
        return json(res, 200, { choices: [{ message: { role: 'assistant', content: `【模拟·${role}】第${users.length}轮：${users.at(-1).content}；首条：${users[0].content}` } }] });
      }
      if (req.method !== 'GET' && (req.headers['x-lab-token'] !== token || (req.headers.origin && req.headers.origin !== origin))) return json(res, 403, { error: '页面凭据失效，请刷新' });
      if (url.pathname.startsWith('/api/backup') && (req.headers['x-lab-token'] !== token || (req.headers.origin && req.headers.origin !== origin))) return json(res, 403, { error: '备份操作需要当前管理页面凭据' });
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'", 'x-frame-options': 'DENY' });
        return res.end(fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').replace('__TOKEN__', token));
      }
      if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, status());
      // Login panel: the QR code lives in NapCat's cache, the refresh action asks
      // the start script's watchdog to relaunch QQ by killing it (the watchdog
      // owns the relaunch, so there is exactly one place that starts QQ).
      if (req.method === 'GET' && url.pathname === '/api/login/state') return json(res, 200, { ...loginState(), gateway: gatewayStatus() });
      if (req.method === 'GET' && url.pathname === '/api/login/qrcode.png') {
        try {
          const png = fs.readFileSync(NAPCAT_QR_PATH);
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
          return res.end(png);
        } catch { return json(res, 404, { error: '还没有二维码，请先启动 QQ' }); }
      }
      if (req.method === 'POST' && url.pathname === '/api/login/refresh') {
        const pids = qqPids();
        if (pids.length === 0) return json(res, 409, { error: 'QQ 没有在运行，无法刷新二维码' });
        // SIGTERM, not SIGKILL: QQ has to flush its own state, and the start
        // script's watchdog is what relaunches it (single owner of that job).
        let signalled = 0;
        for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); signalled += 1; } catch { /* already gone */ } }
        if (signalled === 0) return json(res, 500, { error: '结束 QQ 进程失败' });
        return json(res, 202, { accepted: true, killed: signalled, note: 'QQ 正在重启，约 30-60 秒后生成新二维码；期间请勿关闭容器' });
      }
      if (req.method === 'POST' && url.pathname === '/api/login/logout') {
        const pids = qqPids();
        if (pids.length === 0) return json(res, 409, { error: 'QQ 没有在运行，无需退出登录' });
        let signalled = 0;
        for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); signalled += 1; } catch { /* already gone */ } }
        if (signalled === 0) return json(res, 500, { error: '结束 QQ 进程失败' });
        // Give QQ a moment to flush and exit before deleting its credential
        // store, so we do not leave a half-written profile behind.
        await new Promise(resolve => setTimeout(resolve, 3000));
        let removed = 0;
        try {
          for (const name of fs.readdirSync(QQ_USER_DATA_DIR)) {
            if (!name.startsWith('nt_qq_')) continue;
            try { fs.rmSync(path.join(QQ_USER_DATA_DIR, name), { recursive: true, force: true }); removed += 1; } catch { /* locked file */ }
          }
        } catch { /* no store yet */ }
        return json(res, 202, {
          accepted: true,
          killed: signalled,
          removed,
          note: removed
            ? `已退出登录（清除 ${removed} 个账号数据）；QQ 正在重启，请重新扫码`
            : 'QQ 已停止；没有找到已保存的登录态，重启后会直接给出二维码',
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/roles') {
        // Rescan on every read: a card may have been edited, added or removed
        // on the data volume by hand, and the cached list would hide that.
        reloadRoles();
        return json(res, 200, { roles: roles.map(role => ({ ...role, ...roleStats(fs.readFileSync(path.join(promptDir(), role.file), 'utf8')) })), current: cfg.policy.defaultRole, limits: ROLE_LIMITS });
      }
      if (req.method === 'GET' && url.pathname === '/api/roles/content') {
        const roleId = url.searchParams.get('id') || '';
        if (!safeRoleId(roleId)) return json(res, 400, { error: '角色 id 不合法' });
        let content;
        try { content = fs.readFileSync(path.join(promptDir(), roleId + '.md'), 'utf8'); }
        catch { return json(res, 404, { error: `人格「${roleId}」不存在` }); }
        return json(res, 200, { id: roleId, name: roleTitle(roleId), content, ...roleStats(content), limits: ROLE_LIMITS, pack: readPack(roleId) });
      }
      if (req.method === 'POST' && url.pathname === '/api/roles/pack') {
        const input = await body(req);
        const roleId = String(input.id ?? '').trim();
        if (!safeRoleId(roleId)) return json(res, 400, { error: '角色 id 不合法' });
        if (!fs.existsSync(path.join(promptDir(), roleId + '.md'))) return json(res, 404, { error: `人格「${roleId}」不存在` });
        const raw = Array.isArray(input.aliases) ? input.aliases : String(input.aliases ?? '').split(/[,，、\n]/);
        const aliases = [...new Set(raw.map(a => String(a).trim()).filter(Boolean))];
        if (aliases.length > PACK_LIMITS.aliases) return json(res, 400, { error: `别名最多 ${PACK_LIMITS.aliases} 个` });
        if (aliases.some(a => a.length > PACK_LIMITS.aliasMax)) return json(res, 400, { error: `单个别名最多 ${PACK_LIMITS.aliasMax} 个字符` });
        const worldName = String(input.worldName ?? '').trim();
        if (worldName.length > PACK_LIMITS.worldMax) return json(res, 400, { error: `世界观名最多 ${PACK_LIMITS.worldMax} 个字符` });
        try { return json(res, 200, { ok: true, id: roleId, pack: writePack(roleId, { aliases, worldName }) }); }
        catch (error) { return json(res, 500, { error: `保存角色包失败：${error.message}` }); }
      }
      if (req.method === 'POST' && url.pathname === '/api/roles/save') {
        const input = await body(req);
        const current = String(input.id ?? '').trim();
        const name = String(input.name ?? '').trim();
        const content = String(input.content ?? '');
        const target = current || name;
        if (!safeRoleId(target)) return json(res, 400, { error: `人格名需为 1–${ROLE_LIMITS.nameMax} 个字符，且不能包含 / \\ 等路径字符` });
        if (Buffer.byteLength(content, 'utf8') > ROLE_LIMITS.contentMaxBytes) return json(res, 400, { error: '人格卡超过 64 KB 上限' });
        const file = path.join(promptDir(), target + '.md');
        if (!current && fs.existsSync(file)) return json(res, 409, { error: `人格「${target}」已存在` });
        try {
          fs.mkdirSync(promptDir(), { recursive: true });
          fs.writeFileSync(file, content, 'utf8');
        } catch (error) { return json(res, 500, { error: `保存失败：${error.message}` }); }
        reloadRoles();
        const warnings = content.length > ROLE_LIMITS.injectMaxChars
          ? [`超过注入上限 ${ROLE_LIMITS.injectMaxChars} 字符，超出部分不会发给模型`] : [];
        return json(res, 200, { ok: true, id: target, name: roleTitle(target), ...roleStats(content), warnings });
      }
      if (req.method === 'POST' && url.pathname === '/api/roles/rename') {
        const input = await body(req);
        const from = String(input.id ?? '').trim();
        const to = String(input.name ?? '').trim();
        if (!safeRoleId(from) || !safeRoleId(to)) return json(res, 400, { error: '人格名不合法' });
        const source = path.join(promptDir(), from + '.md');
        const destination = path.join(promptDir(), to + '.md');
        if (!fs.existsSync(source)) return json(res, 404, { error: `人格「${from}」不存在` });
        if (fs.existsSync(destination)) return json(res, 409, { error: `人格「${to}」已存在` });
        try { fs.renameSync(source, destination); try { fs.renameSync(packFile(from), packFile(to)); } catch {} } catch (error) { return json(res, 500, { error: `重命名失败：${error.message}` }); }
        reloadRoles();
        return json(res, 200, { ok: true, id: to, name: roleTitle(to) });
      }
      if (req.method === 'POST' && url.pathname === '/api/roles/delete') {
        const input = await body(req);
        const roleId = String(input.id ?? '').trim();
        if (!safeRoleId(roleId)) return json(res, 400, { error: '角色 id 不合法' });
        if (roleId === cfg.policy.defaultRole) return json(res, 409, { error: '不能删除正在使用的默认角色，请先切换默认角色' });
        const file = path.join(promptDir(), roleId + '.md');
        if (!fs.existsSync(file)) return json(res, 404, { error: `人格「${roleId}」不存在` });
        try { fs.unlinkSync(file); try { fs.unlinkSync(packFile(roleId)); } catch {} } catch (error) { return json(res, 500, { error: `删除失败：${error.message}` }); }
        reloadRoles();
        return json(res, 200, { ok: true, deleted: roleId });
      }
      if (req.method === 'GET' && url.pathname === '/api/backups') return json(res, 200, { backups: listBackups(dataDir) });
      if (url.pathname.startsWith('/api/restore') && (req.headers['x-lab-token'] !== token || (req.headers.origin && req.headers.origin !== origin))) return json(res, 403, { error: '恢复操作需要当前管理页面凭据' });
      if (req.method === 'GET' && url.pathname === '/api/restores') {
        let managed = false, activeId = 'original';
        try { const service = await serviceCommand('status', serviceDataDir); managed = service.childPid === process.pid; if (managed) activeId = service.activeDataId; } catch {}
        return json(res, 200, { managed, activeId, copies: listRestores(serviceDataDir) });
      }
      if (req.method === 'POST' && url.pathname === '/api/restore/activate') {
        if (bridge.closed || bridge.queued || preview.status().busy) return json(res, 409, { error: '请等待消息或试聊完成后再切换数据' });
        let service;
        try { service = await serviceCommand('status', serviceDataDir); } catch {}
        if (service?.childPid !== process.pid) return json(res, 409, { error: '需要先通过运行管理器启动，才能切换数据' });
        const input = await body(req);
        // Recheck after the asynchronous body read so no in-flight turn is lost.
        if (bridge.closed || bridge.queued || preview.status().busy) return json(res, 409, { error: '当前有消息或试聊正在处理' });
        const selected = selectData(serviceDataDir, input.id, { roleIds: roles.map(role => role.id) });
        switching = true;
        try { await serviceCommand('restart', serviceDataDir); }
        catch { return json(res, 503, { error: '重启结果尚未确认，请刷新页面检查；不要重复提交切换' }); }
        return json(res, 200, { accepted: true, selectedId: selected.selectedId, previousPid: process.pid, credentialsCopied: false });
      }
      if (req.method === 'GET' && url.pathname === '/api/backup/download') {
        const id = url.searchParams.get('id'); const backup = readBackup(dataDir, id);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-disposition': `attachment; filename="qqrobot-backup-${id}.json"` }); return res.end(backup);
      }
      if (req.method === 'POST' && ['/api/backup/create', '/api/backup/restore'].includes(url.pathname)) {
        const input = await body(req, url.pathname.endsWith('/restore') ? MAX_BACKUP_BYTES : 65536);
        if (bridge.closed || bridge.queued || preview.status().busy) return json(res, 409, { error: '请等待当前消息处理结束后再备份或恢复' });
        const options = { roleIds: roles.map(role => role.id), appVersion };
        return json(res, 200, url.pathname.endsWith('/create') ? createBackup(dataDir, options) : stageRestore(serviceDataDir, input, options));
      }
      if (req.method === 'GET' && url.pathname === '/api/runtime') {
        let service = null; try { service = await serviceCommand('status', serviceDataDir); } catch {}
        return json(res, 200, { pid: process.pid, uptimeSeconds: Math.floor(process.uptime()), modelRequestAttempts: globalThis[Symbol.for('qqrobot.termux.c.guard')]?.explicitModelFetches ?? null, managed: service?.childPid === process.pid,
          phase: service?.childPid === process.pid ? service.phase : 'direct', launches: service?.childPid === process.pid ? service.launches : null, activeDataId: service?.childPid === process.pid ? service.activeDataId : 'original' });
      }
      if (req.method === 'GET' && url.pathname === '/api/gateway') {
        const state = gatewayStatus();
        if (!state) return json(res, 200, { enabled: false });
        return json(res, 200, { enabled: true, type: 'onebot', state: state.state, pending: state.pending, counters: state.counters });
      }
      if (req.method === 'POST' && url.pathname === '/api/gateway/connect') {
        if (!gateway || !onebotPort) return json(res, 409, { error: '网关未配置' });
        if (bridge.closed || switching) return json(res, 409, { error: '当前状态不允许连接网关' });
        try { await onebotPort.connect({ enabled: true }); return json(res, 200, { accepted: true, ...gatewayStatus() }); }
        catch (error) { return json(res, 502, { error: 'OneBot 网关连接或身份验证失败' }); }
      }
      if (req.method === 'POST' && url.pathname === '/api/gateway/disconnect') {
        if (!gateway || !onebotPort || !['ready', 'connecting', 'checking', 'faulted'].includes(onebotPort.status().state)) return json(res, 409, { error: '网关未连接' });
        await onebotPort.close(); onebotPort = null;
        return json(res, 200, { accepted: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/fixture') return json(res, 200, await receiveFixture(await body(req)));
      if (req.method === 'POST' && url.pathname === '/api/model/config') return json(res, 200, await preview.configure(await body(req)));
      if (req.method === 'POST' && url.pathname === '/api/model/clear') return json(res, 200, await preview.clear());
      if (req.method === 'POST' && url.pathname === '/api/model/chat') return json(res, 200, await preview.reply(await body(req)));
      if (req.method === 'POST' && url.pathname === '/api/model/once') return json(res, 200, await preview.testOnce(await body(req)));
      if (req.method === 'POST' && url.pathname === '/api/policy') return json(res, 200, configurePolicy(await body(req)));
      if (req.method === 'POST' && url.pathname === '/api/quiet') return json(res, 200, configureQuiet(await body(req)));
      if (req.method === 'POST' && url.pathname === '/api/role') { const input = await body(req); bridge.setRole(input.scene, input.peerId, input.role); return json(res, 200, status()); }
      if (req.method === 'POST' && url.pathname === '/api/connect') return json(res, 409, { error: '匹配签名未验证，真实 QQ 连接入口关闭' });
      return json(res, 404, { error: '接口不存在' });
    } catch (e) { if (process.env.QQROBOT_DEBUG) console.error('REQ_ERROR', e && e.stack || e); if (!res.headersSent) json(res, 400, { error: '请求无效或本机处理失败，请核对输入和配置' }); else res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, bind, resolve); });
  const boundPort = server.address().port;
  // origin is only used for same-origin URL parsing and the internal fixture
  // baseUrl; keep it loopback so proxy/chat traffic never leaves the host.
  origin = `http://127.0.0.1:${boundPort}`;
  chat = createConversation({ root: ROOT, dataDir, baseUrl: origin + '/fixture/v1', apiKey: token, promptDir: promptDir(), injectMaxChars: ROLE_LIMITS.injectMaxChars });
  // The QQ reply path prefers the model configured in the panel and falls back
  // to the built-in fixture so the bot still answers when nothing is set. The
  // switch happens on configure/clear, never silently in the middle of a reply.
  let replyChat = chat;
  let replyModel = null;
  // Building a real conversation is deferred to the first reply: configuring a
  // model must not open upstream state before anyone actually talks to the bot.
  function applyReplyModel(cfg) {
    const previous = replyChat;
    replyModel = cfg || null;
    replyChat = cfg ? null : chat;
    if (previous && previous !== chat && previous !== replyChat) { try { previous.close().catch(() => {}); } catch {} }
  }
  function replyConversation() {
    if (!replyModel) return chat;
    replyChat ??= (previewChatFactory ?? createConversation)({ root: ROOT, dataDir, baseUrl: replyModel.baseUrl, apiKey: replyModel.apiKey, model: replyModel.model, timeoutMs: 60000, promptDir: promptDir(), injectMaxChars: ROLE_LIMITS.injectMaxChars });
    return replyChat;
  }
  applyReplyModel(preview.current());
  let gatewayBridge = null;
  if (gateway) {
    // Explicit, single-use local OneBot gateway. No automatic reconnects: a
    // transport failure faults the port and the managed service restarts it.
    gatewayBridge = new OneBotTextPort({ url: gateway.url, token: gateway.token, selfId: gateway.selfId, receive: () => {}, timeoutMs: 5000 });
    gatewayBridge.receive = event => bridge.receiveSdk(event);
    onebotPort = gatewayBridge;
  }
  bridge = new TextBridge({ sdk, dataDir, policy: cfg.policy, roleIds: roles.map(r => r.id), quiet, now, knownSecrets: [token], sendRate: sendRate ?? {}, gatewayBacked: !!gateway,
    normalizeMessage: gateway ? normalizeOneBotMessage : undefined,
    respond: event => replyConversation().reply(event),
    sendText: gateway ? req => gatewayBridge.sendText(req) : async () => `mock-${++receiptCounter}` });
  if (gateway) {
    try { await gatewayBridge.connect({ enabled: true }); }
    catch { // Port faults; the managed supervisor keeps the application alive.
    }
  }
  return { origin, bind, exposed, passwordRequired: !!PASSWORD, status, bridge, configurePolicy, configureQuiet, receiveFixture, modelRequests, gateway: gatewayStatus, gateways: () => gateway ? [gateway] : [],
    async close() { await bridge.close(); if (gatewayBridge) { try { await gatewayBridge.close(); } catch {} } await chat.close(); await preview.close(); await new Promise(resolve => server.close(resolve)); }
  };
}
