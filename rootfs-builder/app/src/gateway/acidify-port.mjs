import { decimalId } from './acidify-message.mjs';

// Receives an already authenticated Bot from a future trusted bootstrap.
// This module never constructs Bot, logs in, signs, reconnects, or retries.
// onlineConfirmed is a caller assertion, not evidence of signing compatibility.
export class AcidifyTextPort {
  constructor({ bot, receive }) {
    for (const name of ['onMessageReceive', 'offMessageReceive', 'onBotOffline', 'offBotOffline', 'sendFriendMessage', 'sendGroupMessage']) {
      if (typeof bot?.[name] !== 'function') throw new TypeError('Unsupported Acidify text contract');
    }
    if (typeof receive !== 'function') throw new TypeError('Missing receiver');
    this.bot = bot; this.receive = receive; this.state = 'idle';
    this.stop = new AbortController(); this.receiving = new Set();
    this.counters = { received: 0, receiveErrors: 0, offline: 0, sends: 0, receipts: 0, sendErrors: 0 };
    this.detachFailed = false;
  }
  status() { return { state: this.state, counters: { ...this.counters }, detachFailed: this.detachFailed, pendingReceives: this.receiving.size }; }
  attach({ onlineConfirmed = false } = {}) {
    if (!onlineConfirmed || this.state !== 'idle') throw new Error('Explicit confirmed online state required; port is single-use');
    this.state = 'attaching';
    this.messageCallback = event => {
      if (this.state !== 'ready') return;
      if (this.receiving.size >= 64) { this.counters.receiveErrors++; return; }
      this.counters.received++;
      // SDK callbacks are synchronous: always consume async receiver failures.
      const task = Promise.resolve().then(() => {
        if (this.state !== 'ready') return;
        return this.receive(event?.message);
      }).catch(() => { this.counters.receiveErrors++; }).finally(() => this.receiving.delete(task));
      this.receiving.add(task);
    };
    this.offlineCallback = () => {
      if (!['ready', 'attaching'].includes(this.state)) return;
      this.counters.offline++; this.state = 'offline'; this.stop.abort();
      // Provider reason strings can contain identifiers: never retain them.
    };
    try {
      this.offlineHandle = this.bot.onBotOffline(this.offlineCallback);
      this.messageHandle = this.bot.onMessageReceive(this.messageCallback);
      if (this.state !== 'attaching') throw new Error('Offline during subscription');
      this.state = 'ready';
    } catch {
      this.state = 'faulted'; this.stop.abort(); this.detach();
      throw new Error('Acidify event subscription failed');
    }
  }
  detach() {
    for (const [method, handle, callback] of [
      ['offMessageReceive', this.messageHandle, this.messageCallback],
      ['offBotOffline', this.offlineHandle, this.offlineCallback]
    ]) {
      if (!callback) continue;
      try { if (this.bot[method](handle ?? callback) === false) this.detachFailed = true; }
      catch { this.detachFailed = true; }
    }
    this.messageCallback = null; this.offlineCallback = null;
    this.messageHandle = null; this.offlineHandle = null;
  }
  async sendText({ scene, peerId, text, signal } = {}) {
    if (this.state !== 'ready' || signal?.aborted) throw new Error('Acidify port unavailable');
    if (!['private', 'group'].includes(scene)) throw new TypeError('Unsupported text scene');
    const peer = BigInt(decimalId(peerId));
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new TypeError('Invalid outgoing text');
    let cancel;
    const cancelled = new Promise((_, reject) => { cancel = () => reject(new Error('Send result uncertain; no retry')); });
    signal?.addEventListener('abort', cancel, { once: true });
    this.stop.signal.addEventListener('abort', cancel, { once: true });
    try {
      if (this.state !== 'ready' || signal?.aborted || this.stop.signal.aborted) throw new Error('Acidify port unavailable');
      const method = scene === 'private' ? 'sendFriendMessage' : 'sendGroupMessage';
      const sending = Promise.resolve().then(() => {
        if (this.state !== 'ready' || signal?.aborted) throw new Error('Acidify port unavailable');
        this.counters.sends++;
        return this.bot[method](peer, builder => builder.text(text));
      });
      const result = await Promise.race([sending, cancelled]);
      if (this.state !== 'ready' || signal?.aborted) throw new Error('Late send result');
      const sequence = decimalId(result?.sequence, { zero: true });
      const sendTime = decimalId(result?.sendTime, { zero: true });
      this.counters.receipts++;
      return `acidify:${scene}:${peer}:${sequence}:${sendTime}`;
    } catch {
      this.counters.sendErrors++;
      // The SDK has no cancellation contract for sendFriendMessage/sendGroupMessage.
      // Aborting our wait does not prove that QQ did not receive the message.
      if (this.state === 'ready') this.state = 'faulted';
      this.stop.abort();
      throw new Error('Acidify send outcome uncertain; no retry');
    } finally {
      signal?.removeEventListener('abort', cancel);
      this.stop.signal.removeEventListener('abort', cancel);
    }
  }
  async close() {
    this.state = 'closed'; this.stop.abort(); this.detach();
    await Promise.allSettled([...this.receiving]);
  }
}
