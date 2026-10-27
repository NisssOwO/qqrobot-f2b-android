import assert from 'node:assert/strict';
import { AcidifyTextPort } from './src/gateway/acidify-port.mjs';

// Controlled SDK port double. No Bot constructor, socket, signing or account.
class ControlledBot {
  constructor() { this.messages = new Set(); this.offlines = new Set(); this.sent = []; }
  onMessageReceive(callback) { const handle = event => callback(event); this.messages.add(handle); return handle; }
  offMessageReceive(handle) { return this.messages.delete(handle); }
  onBotOffline(callback) { const handle = event => callback(event); this.offlines.add(handle); return handle; }
  offBotOffline(handle) { return this.offlines.delete(handle); }
  sendFriendMessage(peer, build) { return this.send('private', peer, build); }
  sendGroupMessage(peer, build) { return this.send('group', peer, build); }
  send(scene, peer, build) {
    const parts = []; build({ text: value => parts.push(value) });
    this.sent.push({ scene, peer, parts });
    return this.outcome ? this.outcome() : Promise.resolve({ sequence: 9007199254740993n, sendTime: 1792990000n });
  }
  incoming(message) { for (const callback of this.messages) callback({ message }); }
  offline() { for (const callback of this.offlines) callback({ reason: 'synthetic-private-reason-must-not-be-stored' }); }
}
const drain = () => new Promise(resolve => setImmediate(resolve));
export async function runPortAcceptance({ check, sdkMessage, input, makeBridge }) {
  await check('sdk-port-explicit-attach-and-exact-subscription-handles', async () => {
    const bot = new ControlledBot(); let message;
    const port = new AcidifyTextPort({ bot, receive: value => { message = value; } });
    assert.throws(() => port.attach()); assert.equal(bot.messages.size, 0);
    port.attach({ onlineConfirmed: true }); assert.throws(() => port.attach({ onlineConfirmed: true }));
    const raw = sdkMessage(input()); bot.incoming(raw); await drain(); assert.equal(message, raw);
    await port.close(); assert.equal(bot.messages.size, 0); assert.equal(bot.offlines.size, 0);
    assert.equal(port.status().detachFailed, false); assert.equal(port.status().state, 'closed');
  });
  await check('sdk-port-bigint-friend-group-text-and-receipts', async () => {
    const bot = new ControlledBot(), port = new AcidifyTextPort({ bot, receive: () => {} }); port.attach({ onlineConfirmed: true });
    for (const scene of ['private', 'group']) {
      const receipt = await port.sendText({ scene, peerId: '9007199254740995', text: '日本語と中文' });
      assert.equal(receipt, `acidify:${scene}:9007199254740995:9007199254740993:1792990000`);
    }
    assert.ok(bot.sent.every(item => item.peer === 9007199254740995n && item.parts[0] === '日本語と中文'));
    for (const request of [{ scene: 'temp', peerId: '1', text: 'x' }, { scene: 'private', peerId: 123, text: 'x' }, { scene: 'private', peerId: '1', text: 'x'.repeat(2001) }]) await assert.rejects(port.sendText(request));
    assert.equal(bot.sent.length, 2); await port.close();
  });
  await check('sdk-port-receiver-error-contained-and-offline-stops-input-output', async () => {
    const bot = new ControlledBot(), port = new AcidifyTextPort({ bot, receive: async () => { throw Error('synthetic private receiver error'); } });
    port.attach({ onlineConfirmed: true }); bot.incoming({}); await drain();
    assert.equal(port.status().counters.receiveErrors, 1); bot.offline(); bot.incoming({}); await drain();
    assert.equal(port.status().state, 'offline'); assert.equal(port.status().counters.received, 1);
    assert.ok(!JSON.stringify(port.status()).includes('synthetic-private'));
    await assert.rejects(port.sendText({ scene: 'private', peerId: '1', text: 'x' })); assert.equal(bot.sent.length, 0);
    assert.throws(() => port.attach({ onlineConfirmed: true })); await port.close();
  });
  await check('sdk-port-aborted-send-does-not-retry-or-accept-late-receipt', async () => {
    let resolve; const bot = new ControlledBot(); bot.outcome = () => new Promise(done => { resolve = done; });
    const port = new AcidifyTextPort({ bot, receive: () => {} }); port.attach({ onlineConfirmed: true });
    const controller = new AbortController();
    const pending = port.sendText({ scene: 'group', peerId: '20001', text: 'x', signal: controller.signal });
    const rejected = assert.rejects(pending, /uncertain/); await drain(); controller.abort(); await rejected;
    resolve({ sequence: 1n, sendTime: 2n }); await drain();
    assert.equal(port.status().counters.receipts, 0); assert.equal(bot.sent.length, 1);
    await assert.rejects(port.sendText({ scene: 'group', peerId: '20001', text: 'x' })); assert.equal(bot.sent.length, 1); await port.close();
  });
  await check('sdk-port-sync-throw-invalid-receipt-and-partial-subscription-cleanup', async () => {
    for (const outcome of [() => { throw Error('private provider error'); }, () => ({ sequence: 123, sendTime: 1n })]) {
      const bot = new ControlledBot(); bot.outcome = outcome;
      const port = new AcidifyTextPort({ bot, receive: () => {} }); port.attach({ onlineConfirmed: true });
      await assert.rejects(port.sendText({ scene: 'private', peerId: '10001', text: 'x' }), /uncertain/);
      assert.equal(port.status().state, 'faulted'); assert.equal(bot.sent.length, 1); await port.close();
    }
    const bot = new ControlledBot(); bot.onMessageReceive = () => { throw Error('subscribe failed'); };
    const port = new AcidifyTextPort({ bot, receive: () => {} });
    assert.throws(() => port.attach({ onlineConfirmed: true }), /subscription failed/);
    assert.equal(bot.offlines.size, 0); assert.equal(port.status().state, 'faulted'); await port.close();
  });
  await check('sdk-port-offline-during-send-rejects-and-close-is-final', async () => {
    const bot = new ControlledBot(); bot.outcome = () => new Promise(() => {});
    const port = new AcidifyTextPort({ bot, receive: () => {} }); port.attach({ onlineConfirmed: true });
    const pending = port.sendText({ scene: 'private', peerId: '10001', text: 'x' });
    const rejected = assert.rejects(pending); await drain(); bot.offline(); await rejected;
    assert.equal(port.status().state, 'offline'); await port.close(); assert.equal(port.status().state, 'closed');
  });
  await check('sdk-port-integrated-bridge-dedup-policy-and-offline-in-generation', async () => {
    const bot = new ControlledBot(); let port;
    const bridge = makeBridge('sdk-port-bridge', { sendText: request => port.sendText(request) });
    port = new AcidifyTextPort({ bot, receive: message => bridge.receiveSdk(message) }); port.attach({ onlineConfirmed: true });
    const raw = sdkMessage(input()); bot.incoming(raw); bot.incoming(raw); await drain(); await bridge.queue;
    assert.equal(bot.sent.length, 1); assert.equal(bridge.state.outbox.length, 1); assert.equal(bridge.state.counters.duplicate, 1);
    bot.incoming(sdkMessage(input({ peerId: '99999' }))); await drain(); assert.equal(bot.sent.length, 1);
    let release, entered; const started = new Promise(resolve => { entered = resolve; });
    bridge.respond = async () => { entered(); await new Promise(resolve => { release = resolve; }); return 'must not send after offline'; };
    bot.incoming(sdkMessage(input())); await started; bot.offline(); release(); await bridge.queue;
    assert.equal(bot.sent.length, 1); assert.equal(bridge.status().transportFaulted, true);
    await port.close(); await bridge.close();
  });
}
