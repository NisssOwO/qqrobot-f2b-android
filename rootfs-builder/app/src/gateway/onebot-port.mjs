import WebSocket from 'ws';
import { randomBytes } from 'node:crypto';
import { oneBotId, oneBotMessageId } from './onebot-message.mjs';

// Explicit, single-use local connection. No QQ login, model calls or automatic retries.
export class OneBotTextPort {
  constructor({ url, token, selfId, receive, timeoutMs = 5000 }) {
    const endpoint = new URL(url);
    if (endpoint.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname) || !endpoint.port || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) throw new TypeError('Local combined OneBot WS endpoint required');
    if (typeof token !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(token)) throw new TypeError('OneBot access token required');
    if (typeof receive !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 20 || timeoutMs > 30000) throw new TypeError('Invalid port options');
    Object.assign(this, { endpoint: endpoint.href, token, selfId: oneBotId(selfId), receive, timeoutMs });
    this.state = 'idle'; this.pending = new Map(); this.receiving = new Set();
    this.counters = { received: 0, receiveErrors: 0, sends: 0, receipts: 0, sendErrors: 0 };
  }
  status() { return { state: this.state, pending: this.pending.size, pendingReceives: this.receiving.size, counters: { ...this.counters } }; }
  fault() {
    if (this.state !== 'closed') this.state = 'faulted';
    for (const request of [...this.pending.values()]) request.fail();
    this.socket?.terminate();
  }
  async connect({ enabled = false } = {}) {
    if (!enabled || this.state !== 'idle') throw new Error('Explicit single-use connection required');
    this.state = 'connecting';
    this.socket = new WebSocket(this.endpoint, { headers: { Authorization: `Bearer ${this.token}` },
      followRedirects: false, handshakeTimeout: this.timeoutMs, maxPayload: 131072, perMessageDeflate: false });
    this.socket.on('error', () => this.fault());
    this.socket.on('close', () => this.fault());
    this.socket.on('message', (data, binary) => this.message(data, binary));
    try {
      await new Promise((resolve, reject) => {
        this.socket.once('open', resolve);
        this.socket.once('error', () => reject(new Error('Local gateway connection failed')));
        this.socket.once('close', () => reject(new Error('Local gateway connection closed')));
      });
      if (this.state !== 'connecting') throw new Error('Gateway unavailable');
      this.state = 'checking';
      await this.checkIdentity();
      if (this.state !== 'checking') throw new Error('Gateway unavailable');
      this.state = 'ready';
    } catch { this.fault(); throw new Error('OneBot identity/online verification failed'); }
  }
  async checkIdentity(signal) {
    const login = await this.request('get_login_info', {}, signal);
    if (oneBotId(login?.user_id) !== this.selfId) throw new Error('Wrong account');
    const status = await this.request('get_status', {}, signal);
    if (status?.online !== true || status?.good !== true) throw new Error('Gateway offline');
  }
  request(action, params, signal) {
    if (!['get_login_info', 'get_status', 'send_private_msg', 'send_group_msg'].includes(action)) return Promise.reject(new Error('Unsupported OneBot action'));
    if (!['checking', 'ready'].includes(this.state) || this.socket.readyState !== WebSocket.OPEN || signal?.aborted || this.pending.size >= 32) return Promise.reject(new Error('Gateway unavailable'));
    return new Promise((resolve, reject) => {
      const echo = randomBytes(12).toString('hex');
      let timer;
      const done = (error, value) => {
        if (!this.pending.delete(echo)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', cancel);
        if (error) reject(new Error('OneBot request result unavailable')); else resolve(value);
      };
      const cancel = () => done(true);
      this.pending.set(echo, { fail: cancel, complete: value => done(false, value) });
      timer = setTimeout(cancel, this.timeoutMs);
      signal?.addEventListener('abort', cancel, { once: true });
      try { this.socket.send(JSON.stringify({ action, params, echo }), error => { if (error) cancel(); }); }
      catch { cancel(); }
    });
  }
  message(bytes, binary) {
    let value;
    try { if (binary) throw new Error(); value = JSON.parse(bytes.toString()); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); }
    catch { this.fault(); return; }
    if (Object.hasOwn(value, 'echo')) {
      const pending = this.pending.get(value.echo);
      if (!pending) return;
      if (value.status !== 'ok' || value.retcode !== 0) pending.fail(); else pending.complete(value.data);
      return;
    }
    if (value.post_type === 'meta_event') {
      if ((value.meta_event_type === 'heartbeat' && (value.status?.online === false || value.status?.good === false)) || (value.meta_event_type === 'lifecycle' && value.sub_type === 'disable')) this.fault();
      return;
    }
    if (this.state !== 'ready' || value.post_type !== 'message') return;
    try { if (oneBotId(value.self_id) !== this.selfId) throw new Error(); }
    catch { this.fault(); return; }
    if (this.receiving.size >= 64) { this.counters.receiveErrors++; return; }
    this.counters.received++;
    const task = Promise.resolve().then(() => this.state === 'ready' ? this.receive(value) : undefined)
      .catch(() => { this.counters.receiveErrors++; }).finally(() => this.receiving.delete(task));
    this.receiving.add(task);
  }
  async sendText({ scene, peerId, text, signal } = {}) {
    if (this.state !== 'ready' || signal?.aborted) throw new Error('OneBot port unavailable');
    if (!['private', 'group'].includes(scene) || typeof text !== 'string' || !text.trim() || text.length > 2000) throw new TypeError('Invalid outgoing text');
    const peer = oneBotId(peerId);
    try {
      await this.checkIdentity(signal);
      if (this.state !== 'ready' || signal?.aborted) throw new Error('Gateway unavailable');
      const params = { [scene === 'private' ? 'user_id' : 'group_id']: peer, message: [{ type: 'text', data: { text } }] };
      this.counters.sends++;
      const result = await this.request(scene === 'private' ? 'send_private_msg' : 'send_group_msg', params, signal);
      if (this.state !== 'ready' || signal?.aborted) throw new Error('Late result');
      const id = oneBotMessageId(result?.message_id);
      this.counters.receipts++;
      return `onebot:${scene}:${peer}:${id}`;
    } catch { this.counters.sendErrors++; this.fault(); throw new Error('OneBot send result uncertain; no retry'); }
  }
  async close() {
    this.state = 'closed'; this.fault();
    await Promise.allSettled([...this.receiving]);
  }
}
