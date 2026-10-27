import fs from 'node:fs';
import path from 'node:path';
import { createStandaloneBackend } from './backend/standalone.mjs';
import { unwrap } from './backend/rpc.mjs';
import { atomicJson } from './gateway/text-bridge.mjs';

const noTools = Object.freeze({ list: async () => [], call: async () => { throw new Error('Local tools disabled'); }, toOpenAiTool: () => { throw new Error('No tools'); }, dispose: async () => {} });
export function createConversation({ root, dataDir, baseUrl, apiKey, model = 'local-fixture', timeoutMs = 15000 }) {
  const mappingFile = path.join(dataDir, 'conversations.json');
  const mapping = fs.existsSync(mappingFile) ? JSON.parse(fs.readFileSync(mappingFile, 'utf8')) : {};
  const pending = new Map();
  const controller = new AbortController();
  let failed = false;
  const backend = createStandaloneBackend({ stateDir: dataDir, llm: { baseUrl, apiKey, model, timeoutMs: timeoutMs - 1000 } }, { tools: noTools, promptDir: path.join(root, 'resources/prompts') });
  const pump = (async () => {
    for await (const { payload } of backend.events.mux({ signal: controller.signal })) {
      if (payload.type !== 'session/event') continue;
      const p = pending.get(payload.sessionId); if (!p) continue;
      const event = payload.event;
      if (event.type === 'assistant/message') p.text += (event.data.message.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      if (event.type === 'turn/end') {
        clearTimeout(p.timer); pending.delete(payload.sessionId);
        if (event.data.reason.kind === 'failed') p.reject(new Error('Model turn failed')); else p.resolve(p.text);
      }
    }
  })();
  return {
    async reply(event) {
      if (failed) throw new Error('Conversation service needs restart after timeout');
      const key = `${event.scene}:${event.peerId}:${event.role}`;
      if (!mapping[key]) {
        if (Object.keys(mapping).length >= 64) throw new Error('Conversation limit reached');
        const { workspace } = unwrap(await backend.workspace.create({ path: dataDir }));
        const { sessionId } = unwrap(await backend.sessions.create({ workspaceId: workspace.workspaceId, agentPreset: 'text-chat' }));
        mapping[key] = sessionId; atomicJson(mappingFile, mapping);
      }
      const sessionId = mapping[key];
      const role = fs.readFileSync(path.join(root, 'resources/prompts', event.role + '.md'), 'utf8');
      backend.events.follow(sessionId);
      const answer = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          failed = true; pending.delete(sessionId); backend.stopSessionWork(sessionId).catch(() => {});
          reject(new Error('Model timed out; no automatic retry'));
        }, timeoutMs);
        pending.set(sessionId, { resolve, reject, timer, text: '' });
      });
      try {
        // 管理员标注（对齐 Windows 版 ownerTag 的【管理员·QQ 号】）：
        // 群主在模型侧要有可识别的身份，否则分不清「谁能改设置」。
        const ownerLabel = event.isOwner ? `\n【管理员·QQ ${event.senderId}】` : '';
        const text = `【来源：${event.scene}；会话：${event.peerId}；发言者：${event.senderId}】${ownerLabel}\n${event.text}`;
        unwrap(await backend.sessions.prompt({ sessionId, system: role, content: [{ type: 'text', text }] }));
      } catch (error) { const p = pending.get(sessionId); if (p) { clearTimeout(p.timer); pending.delete(sessionId); p.reject(error); } }
      return answer;
    },
    status: () => ({ sessions: Object.keys(mapping).length, failed }),
    async close() { controller.abort(); await pump; await backend.dispose(); }
  };
}
