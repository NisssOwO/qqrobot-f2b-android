// OneBot v11 array messages only. CQ strings and display names confer no authority.
import { decimalId } from './acidify-message.mjs';
export function oneBotId(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('Unsafe OneBot numeric ID');
    value = String(value);
  }
  return decimalId(value);
}
export function oneBotMessageId(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('Unsafe message ID');
    value = String(value);
  }
  if (typeof value !== 'string' || !/^(?:0|-?[1-9]\d{0,19})$/.test(value)) throw new TypeError('Invalid message ID');
  return value;
}
export function normalizeOneBotMessage(raw, { selfId }) {
  const self = oneBotId(selfId);
  if (raw?.post_type !== 'message' || oneBotId(raw.self_id) !== self) throw new TypeError('Wrong event or account');
  const scene = raw.message_type;
  if (!['private', 'group'].includes(scene)) throw new TypeError('Unsupported scene');
  if (scene === 'private' ? raw.sub_type !== 'friend' : raw.sub_type !== 'normal' || raw.anonymous != null) throw new TypeError('Unsupported temporary/anonymous event');
  const senderId = oneBotId(raw.user_id), peerId = scene === 'group' ? oneBotId(raw.group_id) : senderId;
  const messageId = oneBotMessageId(raw.message_id);
  if (!Number.isSafeInteger(raw.time) || raw.time < 0) throw new TypeError('Invalid event time');
  if (!Array.isArray(raw.message) || raw.message.length > 256) throw new TypeError('Array message required');
  let text = '', mentioned = false, replyTo = null, unsupported = 0;
  for (const segment of raw.message) {
    if (!segment || typeof segment !== 'object' || !segment.data || typeof segment.data !== 'object') throw new TypeError('Invalid segment');
    if (segment.type === 'text') {
      if (typeof segment.data.text !== 'string') throw new TypeError('Invalid text');
      text += segment.data.text;
    } else if (segment.type === 'at') {
      if (segment.data.qq !== 'all' && oneBotId(segment.data.qq) === self) mentioned = true;
    } else if (segment.type === 'reply') {
      replyTo = { messageId: oneBotMessageId(segment.data.id) };
      // Reply segments contain no authoritative author; do not infer an @ here.
    } else unsupported++;
    if (text.length > 8000) throw new TypeError('Text exceeds 8000 characters');
  }
  return Object.freeze({ scene, peerId, senderId, messageId, timestamp: String(raw.time),
    text: text.trim(), mentioned, replyTo, unsupported, self: senderId === self,
    key: `onebot:${self}:${scene}:${peerId}:${senderId}:${messageId}` });
}
