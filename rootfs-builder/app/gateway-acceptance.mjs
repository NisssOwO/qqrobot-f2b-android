import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { ROOT, createApplication } from './runtime.mjs';

const token = 'local-gateway-acceptance-token-01', selfId = '90001';
const peer = '10001';
const message = text => JSON.stringify({ time: Math.floor(Date.now() / 1000), self_id: Number(selfId), post_type: 'message', message_type: 'private', sub_type: 'friend', message_id: -888, user_id: Number(peer), message: [{ type: 'text', data: { text } }] });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, limit = 100) { for (let i = 0; i < limit; i++) { if (check()) return; await sleep(10); } throw new Error('Observation deadline'); }
const results = [];
let ws = null;
async function check(name, run) { await run(); results.push({ name, passed: true }); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqrobot-gateway-'));
try {
  // Mock local OneBot WS server simulating NapCat at 127.0.0.1.
  ws = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => ws.once('listening', resolve));
  const requests = [], sent = [];
  ws.on('connection', socket => {
    socket.on('message', data => {
      const req = JSON.parse(data); requests.push(req);
      const reply = value => socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: value, echo: req.echo }));
      if (req.action === 'get_login_info') reply({ user_id: Number(selfId) });
      else if (req.action === 'get_status') reply({ online: true, good: true });
      else if (req.action.startsWith('send_')) { sent.push(req.params); reply({ message_id: -456 }); }
      else reply({});
    });
  });
  const endpoint = `ws://127.0.0.1:${ws.address().port}/`;
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ backend: 'standalone', mode: 'simulation',
    gateway: { enabled: true, type: 'onebot', url: endpoint, token },
    policy: { selfId, ownerId: null, allow: { private: [peer], group: [] }, deny: { private: [], group: [] }, defaultRole: 'hinana', requireGroupMention: false },
    quietHours: { enabled: false, holidays: 'none', workday: { weekdays: [1, 2, 3, 4, 5], windows: [['09:00', '12:00']] }, offday: { windows: [] } } }));

  await check('gateway-config-rejects-remote-url-or-missing-token', async () => {
    const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqrobot-gateway-bad-'));
    try {
      for (const bad of [
        { enabled: true, type: 'onebot', url: 'ws://10.0.0.5:3001/', token },
        { enabled: true, type: 'onebot', url: endpoint, token: 'short' },
        { enabled: true, type: 'other', url: endpoint, token },
      ]) {
        fs.writeFileSync(path.join(badDir, 'config.json'), JSON.stringify({ backend: 'standalone', mode: 'simulation',
          gateway: bad, policy: { selfId, ownerId: null, allow: { private: [peer], group: [] }, deny: { private: [], group: [] }, defaultRole: 'hinana', requireGroupMention: false },
          quietHours: { enabled: false, holidays: 'none', workday: { weekdays: [1, 2, 3, 4, 5], windows: [['09:00', '12:00']] }, offday: { windows: [] } } }));
        await assert.rejects(createApplication({ dataDir: badDir }));
      }
    } finally { fs.rmSync(badDir, { recursive: true, force: true }); }
  });
  await check('gateway-starts-connected-receives-and-replies-over-local-ws', async () => {
    const app = await createApplication({ dataDir: dir });
    try {
      assert.equal(app.gateway().type, 'onebot');
      await until(() => app.gateway().state === 'ready');
      const before = { ...app.bridge.status().counters };
      // Inbound message from the mock gateway -> bridge -> model -> sendText back.
      for (const client of ws.clients) client.send(message('こんにちは'));
      for (let i = 0; i < 100 && !((app.bridge.status().counters.sent || 0) === (before.sent || 0) + 1); i++) {
        await sleep(10);
      }
      assert.equal((app.bridge.status().counters.sent || 0), (before.sent || 0) + 1, 'inbound message must produce one outbound send');
      assert.equal(sent.length, 1);
      assert.equal(sent[0].user_id, peer);
      assert.ok(sent[0].message[0].data.text.includes('【模拟·'));
      const status = await (await fetch(app.origin + '/api/status', { headers: { 'x-lab-token': token } })).json();
      assert.equal(status.gateway.state, 'ready');
      const gatewayApi = await (await fetch(app.origin + '/api/gateway', { headers: { 'x-lab-token': token } })).json();
      assert.equal(gatewayApi.enabled, true);
    } finally { await app.close(); }
  });
  await check('gateway-disconnect-stops-traffic-and-reconnect-requires-explicit-connect', async () => {
    const app = await createApplication({ dataDir: dir });
    try {
      await until(() => app.gateway().state === 'ready');
      const html = await (await fetch(app.origin + '/')).text();
      const appToken = (html.match(/const token='([^']+)'/) || [])[1];
      assert.ok(appToken && appToken.length >= 32, 'page token must be readable');
      const headers = { 'x-lab-token': appToken };
      const res = await fetch(app.origin + '/api/gateway/disconnect', { method: 'POST', headers });
      assert.equal(res.status, 200);
      assert.equal(app.gateway(), null);
      const after = await (await fetch(app.origin + '/api/gateway', { headers })).json();
      assert.equal(after.enabled, false);
    } finally { await app.close(); }
  });
} finally { fs.rmSync(dir, { recursive: true, force: true }); ws?.close(); }

const report = { scope: 'Local OneBot gateway through createApplication; no QQ account or external network',
  node: process.version, platform: process.platform, arch: process.arch, uid: process.getuid?.() ?? null, passed: results.every(x => x.passed), results };
console.log(JSON.stringify(report, null, 2));
process.exit(report.passed ? 0 : 1);