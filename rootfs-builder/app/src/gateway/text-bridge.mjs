import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { SENSITIVE_RE } from '../sensitive.js';
import { decimalId, normalizeAcidifyMessage } from './acidify-message.mjs';

export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.tmp-' + randomBytes(6).toString('hex');
  try { fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(temp, file); }
  catch (error) { try { fs.unlinkSync(temp); } catch {} throw error; }
}
export function validatePolicy(raw, roleIds) {
  const ids = list => {
    if (!Array.isArray(list) || list.length > 128) throw new TypeError('白名单需为不超过 128 项的数组');
    return [...new Set(list.map(item => decimalId(item)))];
  };
  const role = raw.defaultRole;
  if (!roleIds.includes(role)) throw new TypeError('未知默认角色');
  return { selfId: decimalId(raw.selfId), ownerId: raw.ownerId ? decimalId(raw.ownerId) : null,
    allow: { private: ids(raw.allow?.private), group: ids(raw.allow?.group) },
    deny: { private: ids(raw.deny?.private || []), group: ids(raw.deny?.group || []) },
    defaultRole: role, requireGroupMention: raw.requireGroupMention !== false };
}
export class TextBridge {
  constructor({ sdk, normalizeMessage = normalizeAcidifyMessage, dataDir, policy, roleIds, respond, sendText, quiet, now = Date.now, knownSecrets = [], dedupTtlMs = 86400000, maxRecords = 4096, sendTimeoutMs = 10000, sendRate = {}, gatewayBacked = false }) {
    Object.assign(this, { sdk, dataDir, roleIds, respond, sendText, quiet, now, knownSecrets, dedupTtlMs, maxRecords, sendTimeoutMs, gatewayBacked });
    this.policy = validatePolicy(policy, roleIds);
    if (typeof normalizeMessage !== 'function') throw new TypeError('Missing message normalizer');
    this.normalizeMessage = normalizeMessage;
    // 连发速率控制：滑动窗口限流，防 QQ 账号因发送过快触发风控（对齐 Windows 版
    // send.maxSendPerMinute=4 / maxSendPerHour=36）。超限的回合直接判定
    // send-rate-limited，不排队、不重试、不断开传输。
    // 仅在真实网关（gatewayBacked）下生效：fixture/离线模拟没有账号风控风险，
    // 限流反而会打断业务回归节奏。
    this.maxSendPerMinute = Number.isInteger(sendRate.maxSendPerMinute) && sendRate.maxSendPerMinute > 0 ? sendRate.maxSendPerMinute : 4;
    this.maxSendPerHour = Number.isInteger(sendRate.maxSendPerHour) && sendRate.maxSendPerHour > 0 ? sendRate.maxSendPerHour : 36;
    this.sendStamps = [];
    this.file = path.join(dataDir, 'gateway-state.json');
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { seen: {}, roleMap: {}, outbox: [], counters: {} };
    for (const record of Object.values(this.state.seen)) {
      if (record.status === 'sending') this.state.transportFaulted = true;
      if (['processing', 'sending'].includes(record.status)) record.status = 'uncertain';
    }
    this.queue = Promise.resolve(); this.queued = 0; this.closed = false; this.persist();
  }
  persist() { atomicJson(this.file, this.state); }
  allowed(scene, peerId) { return !this.policy.deny[scene].includes(peerId) && this.policy.allow[scene].includes(peerId); }
  count(kind) { this.state.counters[kind] = (this.state.counters[kind] || 0) + 1; }

  /** 连发速率闸：仅真实网关模式下生效；fixture 模拟不限流。
   *  每分钟最多 maxSendPerMinute 条、每小时最多 maxSendPerHour 条。
   *  返回 true 表示本次发送放行并占位；false 表示超限，本次不发（防腾讯风控）。 */
  sendGate() {
    if (!this.gatewayBacked) return true;
    const now = this.now();
    this.sendStamps = this.sendStamps.filter((t) => now - t < 3600000);
    if (this.sendStamps.filter((t) => now - t < 60000).length >= this.maxSendPerMinute) return false;
    if (this.sendStamps.length >= this.maxSendPerHour) return false;
    this.sendStamps.push(now);
    return true;
  }
  updatePolicy(raw) {
    const next = validatePolicy(raw, this.roleIds);
    if (next.selfId !== this.policy.selfId) throw new Error('更换机器人身份需要停止并重启适配器');
    this.policy = next;
  }
  setRole(scene, peerId, role) {
    if (!['private', 'group'].includes(scene) || !this.allowed(scene, decimalId(peerId))) throw new Error('目标不在白名单');
    if (!this.roleIds.includes(role)) throw new Error('未知角色');
    const next = { ...this.state, roleMap: { ...this.state.roleMap, [`${scene}:${peerId}`]: role } };
    atomicJson(this.file, next); this.state = next;
  }
  status() { return { mode: 'offline-fixtures', realGateway: 'disabled-signature-unverified', transportFaulted: this.state.transportFaulted === true, queued: this.queued, counters: this.state.counters, outbox: this.state.outbox.slice(-30), policy: this.policy, roleMap: this.state.roleMap, sendRate: { maxSendPerMinute: this.maxSendPerMinute, maxSendPerHour: this.maxSendPerHour } }; }
  reject(reason) { this.count(reason); this.persist(); return { accepted: false, reason }; }
  trimSeen() {
    const records = Object.entries(this.state.seen);
    const terminal = records.filter(([, value]) => !['processing', 'sending', 'uncertain'].includes(value.status)).sort((a, b) => a[1].at - b[1].at);
    for (const [key, value] of terminal) {
      if (value.at + this.dedupTtlMs < this.now() || Object.keys(this.state.seen).length >= this.maxRecords) delete this.state.seen[key];
    }
  }
  receiveSdk(message) {
    if (this.closed) return Promise.resolve({ accepted: false, reason: 'closed' });
    let event;
    try { event = this.normalizeMessage(message, { sdk: this.sdk, selfId: this.policy.selfId }); }
    catch { return Promise.resolve(this.reject('invalid-message')); }
    if (event.self) return Promise.resolve(this.reject('own-message'));
    if (!this.allowed(event.scene, event.peerId)) return Promise.resolve(this.reject('not-allowed'));
    if (!event.text) return Promise.resolve(this.reject('unsupported-content'));
    if (event.scene === 'group' && this.policy.requireGroupMention && !event.mentioned) return Promise.resolve(this.reject('not-mentioned'));
    // No remote admin command implementation in this stage; quoted text never
    // changes identity or role. Roles can only be changed through local control.
    if (/^\//.test(event.text)) return Promise.resolve(this.reject('remote-command-disabled'));
    const previous = this.state.seen[event.key];
    if (previous && (['processing', 'sending', 'uncertain'].includes(previous.status) || previous.at + this.dedupTtlMs >= this.now())) return Promise.resolve(this.reject('duplicate'));
    if (previous) delete this.state.seen[event.key];
    if (this.state.transportFaulted) return Promise.resolve(this.reject('transport-needs-review'));
    this.trimSeen();
    if (this.state.seen[event.key]) return Promise.resolve(this.reject('duplicate'));
    if (this.queued >= 64 || Object.keys(this.state.seen).length >= this.maxRecords) return Promise.resolve(this.reject('capacity'));
    this.state.seen[event.key] = { status: 'processing', at: this.now() };
    this.persist(); // Persist before model/sink side effects. Failure stops here.
    this.queued++;
    const task = this.queue.then(() => this.process(event)).finally(() => { this.queued--; });
    this.queue = task.catch(() => {});
    return task;
  }
  async process(event) {
    const record = this.state.seen[event.key];
    const finish = reason => { record.status = reason; this.count(reason); this.persist(); return { accepted: false, reason }; };
    const permitted = () => this.allowed(event.scene, event.peerId) && this.quiet.allowsInbound({ isOwner: this.policy.ownerId === event.senderId, mentioned: event.mentioned, now: this.now() });
    if (!permitted()) return finish('policy-or-quiet');
    if (this.state.transportFaulted) return finish('transport-needs-review');
    const role = this.state.roleMap[`${event.scene}:${event.peerId}`] || this.policy.defaultRole;
    // 管理员标记：发给模型时让 respond 知道对方是不是管理员（对齐 Windows 版 ownerTag
    // 的【管理员·QQ 号】标注；这里只传布尔，由上层拼进上下文或日志）。
    const isOwner = this.policy.ownerId === event.senderId;
    let reply;
    try { reply = await this.respond({ ...event, role, isOwner }); }
    catch { return finish('model-error'); }
    if (!permitted()) return finish('revoked-before-send');
    if ((this.state.roleMap[`${event.scene}:${event.peerId}`] || this.policy.defaultRole) !== role) return finish('role-changed-before-send');
    if (typeof reply !== 'string' || !reply.trim() || reply.length > 2000) return finish('invalid-reply');
    if (SENSITIVE_RE.test(reply) || /(?:\/data\/(?:data|user)\/|\/storage\/emulated\/)/i.test(reply) || this.knownSecrets.some(secret => secret && reply.includes(secret))) return finish('reply-audit');
    // 连发速率闸：超限的回合直接判 send-rate-limited，不入队、不重试、不断开传输。
    if (!this.sendGate()) return finish('send-rate-limited');
    record.status = 'sending'; this.persist();
    let timer;
    const abort = new AbortController();
    try {
      // No automatic retry: a transport failure might have happened after send.
      const receipt = await Promise.race([
        this.sendText({ scene: event.scene, peerId: event.peerId, text: reply, key: event.key, signal: abort.signal }),
        new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error('Transport timeout')); }, this.sendTimeoutMs); })
      ]);
      if (typeof receipt !== 'string' || !receipt || receipt.length > 128) throw new Error('Invalid transport receipt');
      this.state.outbox.push({ key: event.key, scene: event.scene, peerId: event.peerId, role, text: reply, at: this.now(), receipt });
      this.state.outbox = this.state.outbox.slice(-100);
      record.status = 'sent'; this.count('sent'); this.persist();
      return { accepted: true, mode: 'offline-fixtures', role, reply, receipt };
    } catch { record.status = 'uncertain'; this.state.transportFaulted = true; this.count('uncertain'); this.persist(); return { accepted: false, reason: 'send-uncertain-no-retry' }; }
    finally { clearTimeout(timer); }
  }
  async close() { this.closed = true; await this.queue; this.persist(); }
}
