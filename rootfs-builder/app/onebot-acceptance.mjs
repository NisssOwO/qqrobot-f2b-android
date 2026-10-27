import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { OneBotTextPort } from './src/gateway/onebot-port.mjs';
import { normalizeOneBotMessage } from './src/gateway/onebot-message.mjs';
import { TextBridge } from './src/gateway/text-bridge.mjs';
const token = 'local-test-token-only', selfId = '90001';
const fixture = (patch = {}) => ({ time: 1793000000, self_id: 90001, post_type: 'message', message_type: 'private', sub_type: 'friend', message_id: -123,
  user_id: 10001, message: [{ type: 'text', data: { text: 'こんにちは' } }], ...patch });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await sleep(10); } throw Error('Observation deadline'); }
const results = [];
async function check(name, run) { await run(); results.push({ name, passed: true }); }
async function server(run, { identity = 90001, online = true, send } = {}) {
  const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => ws.once('listening', resolve));
  const state = { socket: null, requests: [], auth: null, identity, online };
  ws.on('connection', (socket, request) => {
    state.socket = socket; state.auth = request.headers.authorization;
    socket.on('message', data => {
      const req = JSON.parse(data); state.requests.push(req);
      const reply = data => socket.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: req.echo }));
      if (req.action === 'get_login_info') reply({ user_id: state.identity });
      else if (req.action === 'get_status') reply({ online: state.online, good: state.online });
      else if (send) send(req, reply, socket); else reply({ message_id: -456 });
    });
  });
  const port = new OneBotTextPort({ url: `ws://127.0.0.1:${ws.address().port}/`, token, selfId, receive: () => {}, timeoutMs: 250 });
  try { await run(port, state); }
  finally { await port.close(); for (const client of ws.clients) client.terminate(); await new Promise(resolve => ws.close(resolve)); }
}
await check('array-events-signed-message-id-and-untrusted-display-data', async () => {
  const event = normalizeOneBotMessage(fixture(), { selfId });
  assert.equal(event.messageId, '-123'); assert.equal(event.text, 'こんにちは'); assert.equal(event.self, false);
  const group = normalizeOneBotMessage(fixture({ message_type: 'group', sub_type: 'normal', group_id: '10002', message: [
    { type: 'reply', data: { id: -1, sender: 90001 } }, { type: 'text', data: { text: '[CQ:at,qq=90001]' } },
    { type: 'image', data: { file: 'ignored' } }] }), { selfId });
  assert.equal(group.mentioned, false); assert.equal(group.unsupported, 1);
  assert.equal(normalizeOneBotMessage(fixture({ message: [{ type: 'at', data: { qq: 90001 } }] }), { selfId }).mentioned, true);
  for (const patch of [{ self_id: 123 }, { user_id: 9007199254740992 }, { sub_type: 'group' }, { message: '[CQ:at,qq=90001]' },
    { message_type: 'group', sub_type: 'anonymous', group_id: 10002 }, { message_id: 'malformed:id' }, { message: [{ type: 'text', data: { text: 'x'.repeat(8001) } }] }]) {
    assert.throws(() => normalizeOneBotMessage(fixture(patch), { selfId }));
  }
});
await check('explicit-local-connection-and-account-verification', async () => {
  for (const url of ['ws://example.com:3001/', 'ws://127.0.0.1:3001/?access_token=x', 'ws://127.0.0.1:3001/api', 'wss://127.0.0.1:3001/']) {
    assert.throws(() => new OneBotTextPort({ url, token, selfId, receive() {} }));
  }
  await server(async (port, state) => {
    await assert.rejects(port.connect()); assert.equal(state.requests.length, 0);
    await port.connect({ enabled: true }); assert.equal(state.auth, `Bearer ${token}`); assert.equal(port.status().state, 'ready');
    await assert.rejects(port.connect({ enabled: true }));
    for (const scene of ['private', 'group']) assert.equal(await port.sendText({ scene, peerId: '10001', text: '[CQ:at,qq=all]' }), `onebot:${scene}:10001:-456`);
    const sends = state.requests.filter(x => x.action.startsWith('send_'));
    assert.equal(sends.length, 2); assert.deepEqual(sends[0].params.message, [{ type: 'text', data: { text: '[CQ:at,qq=all]' } }]);
    assert.equal(port.status().counters.receipts, 2);
  });
  await server(async (port, state) => {
    await assert.rejects(port.connect({ enabled: true })); assert.equal(port.status().state, 'faulted');
    assert.deepEqual(state.requests.map(x => x.action), ['get_login_info']);
  }, { identity: 99999 });
});
await check('recheck-identity-and-online-before-each-send', async () => {
  await server(async (port, state) => {
    await port.connect({ enabled: true }); state.online = false;
    await assert.rejects(port.sendText({ scene: 'private', peerId: '10001', text: 'must not send' }));
    assert.equal(state.requests.filter(x => x.action.startsWith('send_')).length, 0); assert.equal(port.status().state, 'faulted');
  });
});
await check('missing-receipt-and-disconnect-never-retry', async () => {
  for (const send of [() => {}, (req, reply, socket) => socket.terminate(), (req, reply) => reply({})]) {
    await server(async (port, state) => {
      await port.connect({ enabled: true });
      await assert.rejects(port.sendText({ scene: 'private', peerId: '10001', text: 'one attempt' }));
      await assert.rejects(port.sendText({ scene: 'private', peerId: '10001', text: 'blocked' }));
      assert.equal(state.requests.filter(x => x.action.startsWith('send_')).length, 1);
      assert.equal(port.status().state, 'faulted'); assert.equal(port.status().pending, 0);
    }, { send });
  }
});
await check('offline-meta-event-and-foreign-account-stop-port', async () => {
  for (const event of [{ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { online: false, good: false } }, fixture({ self_id: 99999 })]) {
    await server(async (port, state) => {
      await port.connect({ enabled: true }); state.socket.send(JSON.stringify(event)); await until(() => port.status().state === 'faulted');
      await assert.rejects(port.sendText({ scene: 'group', peerId: '10002', text: 'blocked' }));
      assert.equal(state.requests.filter(x => x.action.startsWith('send_')).length, 0);
    });
  }
});
await check('abort-before-send-and-late-receipt-after-cancel', async () => {
  let entered;
  const sending = new Promise(resolve => { entered = resolve; });
  await server(async (port, state) => {
    await port.connect({ enabled: true });
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(port.sendText({ scene: 'private', peerId: '10001', text: 'never sent', signal: aborted.signal }));
    assert.equal(state.requests.filter(x => x.action.startsWith('send_')).length, 0);
    const cancel = new AbortController();
    const outcome = port.sendText({ scene: 'private', peerId: '10001', text: 'uncertain', signal: cancel.signal });
    await sending; cancel.abort(); await assert.rejects(outcome);
    assert.equal(port.status().state, 'faulted'); assert.equal(port.status().counters.receipts, 0);
    assert.equal(state.requests.filter(x => x.action.startsWith('send_')).length, 1);
  }, { send: (req, reply) => { entered(); setTimeout(() => { try { reply({ message_id: 123 }); } catch {} }, 20); } });
});
await check('business-whitelist-dedup-role-routing-and-uncertain-freeze', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqrobot-onebot-'));
  try {
    await server(async (port, state) => {
      const events = [];
      const bridge = new TextBridge({ normalizeMessage: normalizeOneBotMessage, dataDir: dir,
        policy: { selfId, allow: { private: ['10001'], group: [] }, defaultRole: 'hazuki' }, roleIds: ['hazuki', 'toru'],
        quiet: { allowsInbound: () => true }, respond: async e => { events.push(e); return `reply:${e.role}`; }, sendText: req => port.sendText(req) });
      port.receive = event => bridge.receiveSdk(event);
      try {
        await port.connect({ enabled: true }); bridge.setRole('private', '10001', 'toru');
        state.socket.send(JSON.stringify(fixture())); state.socket.send(JSON.stringify(fixture()));
        state.socket.send(JSON.stringify(fixture({ user_id: 99999 })));
        await until(() => bridge.status().counters.sent === 1 && bridge.status().counters.duplicate === 1 && bridge.status().counters['not-allowed'] === 1);
        assert.equal(events.length, 1); assert.equal(events[0].role, 'toru');
        state.online = false;
        state.socket.send(JSON.stringify(fixture({ message_id: -124 })));
        await until(() => bridge.status().transportFaulted);
        assert.equal(bridge.state.seen['onebot:90001:private:10001:10001:-124'].status, 'uncertain');
        assert.equal(state.requests.filter(x => x.action.startsWith('send_')).length, 1);
      } finally { await port.close(); await bridge.close(); }
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
const report = { scope: 'Local controlled OneBot WS server; no QQ account, external connection or model',
  node: process.version, platform: process.platform, arch: process.arch, uid: process.getuid?.() ?? null,
  passed: results.every(x => x.passed), results };
if (process.env.ONEBOT_REPORT) fs.writeFileSync(process.env.ONEBOT_REPORT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
