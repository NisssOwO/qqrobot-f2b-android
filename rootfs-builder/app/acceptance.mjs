import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import * as sdk from '@acidify/core';
import { ROOT, createApplication } from './runtime.mjs';
import { TextBridge, atomicJson } from './src/gateway/text-bridge.mjs';
import { normalizeAcidifyMessage, makeSdkFixture } from './src/gateway/acidify-message.mjs';
import { QuietHours } from './src/quiet-hours.mjs';
import { runPortAcceptance } from './port-acceptance.mjs';
import { runModelPreviewAcceptance } from './model-preview-acceptance.mjs';
import { runBackupAcceptance } from './backup-acceptance.mjs';

const started = Date.now();
const testRoot = fs.mkdtempSync(path.join(ROOT, 'acceptance-data-'));
const report = { phase: 'F2-backup', startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, uid: process.getuid?.() ?? null, node: process.version, checks: [], realBotConstructed: false, realQqLogin: false, realQqMessagesSent: 0, sdkFixtureLimitation: 'Runtime SDK inbound constructors + JS array/collection facade; no authenticated live QQ event captured', dataDir: testRoot };
const roles = ['hinana', 'hazuki', 'toru'];
const basePolicy = { selfId: '90001', ownerId: '40001', allow: { private: ['10001', '10002'], group: ['20001'] }, deny: { private: [], group: [] }, defaultRole: 'hinana', requireGroupMention: true };
const clone = value => JSON.parse(JSON.stringify(value));
let sequence = 1000n;
function input(change = {}) { const id = String(++sequence); return { scene: 'private', peerId: '10001', senderId: '10001', sequence: id, messageUid: id, text: '测试文字', ...change }; }
const sdkMessage = value => makeSdkFixture(value, sdk, '90001');
const makeDir = name => { const dir = path.join(testRoot, name); fs.mkdirSync(dir); return dir; };
function makeBridge(name, options = {}) {
  const dataDir = options.dataDir || makeDir(name);
  return new TextBridge({ sdk, dataDir, policy: clone(basePolicy), roleIds: roles, respond: async event => '回复：' + event.text, sendText: async () => 'mock-receipt', quiet: new QuietHours({ config: { enabled: false, holidays: 'none' }, stateDir: dataDir }), ...options });
}
async function check(name, fn) { await fn(); report.checks.push({ name, ok: true }); console.log('PASS ' + name); }
let app;
try {
  await check('real-sdk-enum-text-mention-reply-and-collection-shapes', () => {
    const raw = sdkMessage(input({ scene: 'group', peerId: '20001', senderId: '30001', mentioned: true, text: 'こんにちは' }));
    assert.equal(raw.scene, sdk.MessageScene.GROUP);
    assert.ok(raw.segments[1] instanceof sdk.BotIncomingSegment.Text);
    const normalized = normalizeAcidifyMessage(raw, { sdk, selfId: '90001' });
    assert.equal(normalized.mentioned, true); assert.equal(normalized.text, 'こんにちは');
    raw.segments = { asJsReadonlyArrayView: () => [new sdk.BotIncomingSegment.Reply(10n, 90001n, null, 0n, []), new sdk.BotIncomingSegment.Text('引用回复')] };
    const reply = normalizeAcidifyMessage(raw, { sdk, selfId: '90001' });
    assert.equal(reply.replyTo.sequence, '10'); assert.equal(reply.mentioned, true); assert.equal(reply.text, '引用回复');
    assert.equal(sdkMessage(input()).scene.name, 'FRIEND');
  });
  await check('bigint-identifiers-preserved-and-unknown-scenes-rejected', () => {
    const raw = sdkMessage(input({ peerId: '9007199254740993', senderId: '9007199254740994', messageUid: '9007199254740995' }));
    const normalized = normalizeAcidifyMessage(raw, { sdk, selfId: '90001' });
    assert.equal(normalized.peerId, '9007199254740993'); assert.match(normalized.key, /9007199254740995$/);
    raw.peerUin = 9007199254740992; assert.throws(() => normalizeAcidifyMessage(raw, { sdk, selfId: '90001' }));
    raw.peerUin = 10001n; raw.scene = sdk.MessageScene.TEMP; assert.throws(() => normalizeAcidifyMessage(raw, { sdk, selfId: '90001' }));
  });
  await check('whitelist-deny-own-message-group-trigger-and-command-filter', async () => {
    let calls = 0; const bridge = makeBridge('filters', { respond: async () => { calls++; return 'ok'; } });
    assert.equal((await bridge.receiveSdk(sdkMessage(input({ peerId: '99999' })))).reason, 'not-allowed');
    assert.equal((await bridge.receiveSdk(sdkMessage(input({ senderId: '90001' })))).reason, 'own-message');
    assert.equal((await bridge.receiveSdk(sdkMessage(input({ scene: 'group', peerId: '20001' })))).reason, 'not-mentioned');
    assert.equal((await bridge.receiveSdk(sdkMessage(input({ mentioned: true, text: '/role hazuki' })))).reason, 'remote-command-disabled');
    const denied = clone(basePolicy); denied.deny.private = ['10001']; bridge.updatePolicy(denied);
    assert.equal((await bridge.receiveSdk(sdkMessage(input()))).reason, 'not-allowed');
    denied.allow.private = []; bridge.updatePolicy(denied);
    assert.equal((await bridge.receiveSdk(sdkMessage(input({ peerId: '10002' })))).reason, 'not-allowed');
    assert.equal(calls, 0); await bridge.close();
  });
  await check('duplicate-during-processing-and-after-disk-reload', async () => {
    const dataDir = makeDir('duplicates'); let sends = 0;
    let bridge = makeBridge('', { dataDir, sendText: async () => { sends++; return 'receipt'; } });
    const raw = sdkMessage(input());
    const results = await Promise.all([bridge.receiveSdk(raw), bridge.receiveSdk(raw)]);
    assert.equal(results[0].accepted, true); assert.equal(results[1].reason, 'duplicate');
    await bridge.close(); bridge = makeBridge('', { dataDir, sendText: async () => { sends++; return 'receipt'; } });
    assert.equal((await bridge.receiveSdk(raw)).reason, 'duplicate'); assert.equal(sends, 1); await bridge.close();
  });
  await check('send-failure-uncertain-no-auto-retry-and-crash-markers', async () => {
    const dataDir = makeDir('uncertain'); let sends = 0;
    let bridge = makeBridge('', { dataDir, sendText: async () => { sends++; throw new Error('synthetic transport failed'); } });
    const raw = sdkMessage(input()); assert.equal((await bridge.receiveSdk(raw)).reason, 'send-uncertain-no-retry');
    await bridge.close();
    const stateFile = path.join(dataDir, 'gateway-state.json'), state = JSON.parse(fs.readFileSync(stateFile));
    const crash = sdkMessage(input()), key = normalizeAcidifyMessage(crash, { sdk, selfId: '90001' }).key;
    state.seen[key] = { status: 'sending', at: Date.now() }; atomicJson(stateFile, state);
    bridge = makeBridge('', { dataDir, sendText: async () => { sends++; return 'receipt'; } });
    assert.equal((await bridge.receiveSdk(raw)).reason, 'duplicate');
    assert.equal((await bridge.receiveSdk(crash)).reason, 'duplicate'); assert.equal(sends, 1);
    assert.equal(bridge.state.seen[key].status, 'uncertain'); await bridge.close();
  });
  await check('global-order-and-policy-revocation-before-send', async () => {
    let release, entered; const started = new Promise(resolve => { entered = resolve; });
    const barrier = new Promise(resolve => { release = resolve; }); const order = []; let active = 0, peak = 0;
    const bridge = makeBridge('ordered', { respond: async event => { active++; peak = Math.max(peak, active); order.push(event.text); if (event.text === 'first') { entered(); await barrier; } active--; return event.text; } });
    const first = bridge.receiveSdk(sdkMessage(input({ text: 'first' }))); await started;
    const second = bridge.receiveSdk(sdkMessage(input({ text: 'second' })));
    const revoked = clone(basePolicy); revoked.allow.private = []; bridge.updatePolicy(revoked); release();
    assert.equal((await first).reason, 'revoked-before-send'); assert.equal((await second).reason, 'policy-or-quiet');
    assert.deepEqual(order, ['first']); assert.equal(peak, 1); assert.equal(bridge.state.outbox.length, 0); await bridge.close();
  });
  await check('quiet-hours-authenticated-owner-mention-only', async () => {
    const dataDir = makeDir('quiet'); const clock = () => Date.parse('2026-10-26T02:00:00Z');
    const quiet = new QuietHours({ stateDir: dataDir, config: { enabled: true, holidays: 'none', workday: { weekdays: [1], windows: [['09:00', '12:00']] }, offday: { windows: [] } } });
    const bridge = makeBridge('', { dataDir, quiet, now: clock });
    assert.equal((await bridge.receiveSdk(sdkMessage(input({ senderId: '10001', mentioned: true })))).reason, 'policy-or-quiet');
    assert.equal((await bridge.receiveSdk(sdkMessage(input({ senderId: '40001', mentioned: false })))).reason, 'policy-or-quiet');
    assert.equal((await bridge.receiveSdk(sdkMessage(input({ senderId: '40001', mentioned: true })))).accepted, true);
    assert.equal(bridge.state.outbox.length, 1); await bridge.close();
  });
  await check('successful-messages-preserve-global-send-order', async () => {
    let release, entered; const started = new Promise(resolve => { entered = resolve; });
    const barrier = new Promise(resolve => { release = resolve; }); let active = 0, peak = 0;
    const bridge = makeBridge('success-order', { respond: async event => { active++; peak = Math.max(peak, active); if (event.text === 'first') { entered(); await barrier; } active--; return event.text; } });
    const first = bridge.receiveSdk(sdkMessage(input({ text: 'first' }))); await started;
    const second = bridge.receiveSdk(sdkMessage(input({ text: 'second' })));
    release(); assert.equal((await first).accepted, true); assert.equal((await second).accepted, true);
    assert.equal(peak, 1); assert.deepEqual(bridge.state.outbox.map(record => record.text), ['first', 'second']); await bridge.close();
  });
  await check('role-change-during-generation-drops-stale-persona-reply', async () => {
    let release, entered; const started = new Promise(resolve => { entered = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    const bridge = makeBridge('role-revocation', { respond: async () => { entered(); await barrier; return 'old persona'; } });
    const pending = bridge.receiveSdk(sdkMessage(input())); await started;
    bridge.setRole('private', '10001', 'hazuki'); release();
    assert.equal((await pending).reason, 'role-changed-before-send'); assert.equal(bridge.state.outbox.length, 0); await bridge.close();
  });
  await check('transport-timeout-aborts-freezes-and-does-not-resend', async () => {
    let calls = 0, signal;
    const bridge = makeBridge('transport-timeout', { sendTimeoutMs: 15, sendText: async request => { calls++; signal = request.signal; return new Promise(() => {}); } });
    assert.equal((await bridge.receiveSdk(sdkMessage(input()))).reason, 'send-uncertain-no-retry');
    assert.equal(signal.aborted, true); assert.equal(bridge.status().transportFaulted, true);
    assert.equal((await bridge.receiveSdk(sdkMessage(input()))).reason, 'transport-needs-review'); assert.equal(calls, 1); await bridge.close();
  });
  await check('reply-audit-paths-known-secret-and-invalid-model-output', async () => {
    let response = ''; const bridge = makeBridge('audit', { knownSecrets: ['syntheticBareSessionCredential'], respond: async () => response });
    for (response of ['C:\\private\\file', '/home/test/file', '/data/data/com.termux/files/config.json', 'syntheticBareSessionCredential']) assert.equal((await bridge.receiveSdk(sdkMessage(input()))).reason, 'reply-audit');
    response = 'x'.repeat(2001); assert.equal((await bridge.receiveSdk(sdkMessage(input()))).reason, 'invalid-reply');
    response = '正常回复'; assert.equal((await bridge.receiveSdk(sdkMessage(input()))).accepted, true);
    assert.equal(bridge.state.outbox.length, 1); await bridge.close();
  });
  await check('bounded-dedup-keeps-current-duplicate-and-active-records', async () => {
    const bridge = makeBridge('bounded', { maxRecords: 1 }); const raw = sdkMessage(input());
    assert.equal((await bridge.receiveSdk(raw)).accepted, true); assert.equal((await bridge.receiveSdk(raw)).reason, 'duplicate');
    assert.equal((await bridge.receiveSdk(sdkMessage(input()))).accepted, true); assert.equal(Object.keys(bridge.state.seen).length, 1); await bridge.close();
  });
  await check('storage-failure-before-model-and-sink-side-effects', async () => {
    let calls = 0; const bridge = makeBridge('storage', { respond: async () => { calls++; return 'ok'; }, sendText: async () => { calls++; return 'receipt'; } });
    const original = bridge.file; bridge.file = bridge.dataDir;
    assert.throws(() => bridge.receiveSdk(sdkMessage(input()))); assert.equal(calls, 0);
    bridge.file = original; await bridge.close();
  });
  await check('full-backend-role-context-isolation-and-system-role-not-in-history', async () => {
    const dataDir = makeDir('application'); app = await createApplication({ dataDir });
    const first = input({ text: 'ALPHA-context' });
    assert.match((await app.receiveFixture(first)).reply, /七草日花/);
    assert.match((await app.receiveFixture(input({ text: 'second' }))).reply, /第2轮/);
    for (const role of ['hazuki', 'toru']) { app.bridge.setRole('private', '10001', role); const reply = await app.receiveFixture(input({ text: 'role-new' })); assert.equal(reply.role, role); assert.match(reply.reply, /第1轮/); assert.doesNotMatch(reply.reply, /ALPHA-context/); }
    const group = await app.receiveFixture(input({ scene: 'group', peerId: '20001', senderId: '30001', mentioned: true, text: 'group-new' }));
    assert.match(group.reply, /第1轮/); assert.doesNotMatch(group.reply, /ALPHA-context/);
    app.bridge.setRole('private', '10001', 'hinana'); await app.close(); app = await createApplication({ dataDir });
    assert.equal((await app.receiveFixture(first)).reason, 'duplicate');
    const restored = await app.receiveFixture(input({ text: 'restart' })); assert.match(restored.reply, /第3轮/); assert.match(restored.reply, /ALPHA-context/);
    const request = app.modelRequests.at(-1);
    assert.equal(request.messages.filter(m => m.role === 'system').length, 1);
    assert.ok(request.messages[0].content.includes('日花')); assert.equal(request.tools, undefined);
    assert.ok(request.messages.filter(m => m.role === 'user').every(m => !m.content.includes('你没有本地工具')));
  });
  await check('http-admin-auth-host-origin-and-real-connection-closed', async () => {
    const page = await (await fetch(app.origin)).text(); assert.match(page, /模拟发件箱/);
    const token = page.match(/const token='([a-f0-9]+)'/)[1];
    const headers = { 'content-type': 'application/json', 'x-lab-token': token };
    assert.equal((await fetch(app.origin + '/api/policy', { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await fetch(app.origin + '/api/policy', { method: 'POST', headers: { ...headers, origin: 'https://invalid.example' }, body: '{}' })).status, 403);
    const wrongHost = await new Promise((resolve, reject) => http.get(app.origin + '/api/status', { headers: { host: 'invalid.example' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject));
    assert.equal(wrongHost, 403);
    assert.equal((await fetch(app.origin + '/api/connect', { method: 'POST', headers })).status, 409);
    const runtime = await (await fetch(app.origin + '/api/runtime')).json();
    assert.equal(runtime.managed, false); assert.equal(runtime.pid, process.pid);
    assert.equal(app.status().realGateway, 'disabled-signature-unverified');
    const valid = await fetch(app.origin + '/api/fixture', { method: 'POST', headers, body: JSON.stringify(input({ text: 'HTTP fixture' })) });
    assert.equal(valid.status, 200); assert.equal((await valid.json()).accepted, true);
    await app.close(); app = null;
    const invalidDir = makeDir('real-mode-rejected'); const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'))); cfg.mode = 'real'; atomicJson(path.join(invalidDir, 'config.json'), cfg);
    await assert.rejects(createApplication({ dataDir: invalidDir }), /真实网关/);
  });
  await check('backend-model-failure-never-becomes-successful-outgoing-reply', async () => {
    app = await createApplication({ dataDir: makeDir('model-failure'), fixtureModel: async () => { throw new Error('synthetic model failure'); } });
    assert.equal((await app.receiveFixture(input())).reason, 'model-error');
    assert.equal(app.status().outbox.length, 0); await app.close(); app = null;
  });
  await check('backend-session-save-failure-blocks-outgoing-reply', async () => {
    const dataDir = makeDir('session-save-failure');
    app = await createApplication({ dataDir, fixtureModel: async () => {
      const dir = path.join(dataDir, 'standalone/sessions');
      const name = fs.readdirSync(dir).find(name => name.endsWith('.json'));
      const file = path.join(dir, name);
      fs.renameSync(file, file + '.saved'); fs.mkdirSync(file);
      return { choices: [{ message: { content: 'This must not leave the bridge' } }] };
    } });
    assert.equal((await app.receiveFixture(input())).reason, 'model-error');
    assert.equal(app.status().outbox.length, 0); await app.close(); app = null;
  });
  await runPortAcceptance({ check, sdkMessage, input, makeBridge });
  await runModelPreviewAcceptance({ check, makeDir });
  await runBackupAcceptance({ check, makeDir });
  const guard = globalThis[Symbol.for('qqrobot.termux.c.guard')];
  assert.ok(guard); assert.equal(guard.blocked.length, 0);
  report.checks.push({ name: 'no-common-node-outbound-attempts', ok: true, loopbackConnects: guard.loopbackConnects });
  report.ok = true;
} catch (error) { report.ok = false; report.error = error.stack; console.error(error); process.exitCode = 1; }
finally {
  await app?.close(); report.elapsedMs = Date.now() - started; report.rssBytes = process.memoryUsage().rss;
  fs.writeFileSync(path.join(ROOT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(report.ok ? 'E_TEXT_ACCEPTANCE_COMPLETE' : 'E_TEXT_ACCEPTANCE_FAILED');
}
