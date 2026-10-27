// The SDK is injected: importing this module never creates a Bot or opens QQ sockets.
export function decimalId(value, { zero = false } = {}) {
  if (typeof value !== 'bigint' && typeof value !== 'string') throw new TypeError('ID must be bigint or decimal string');
  const text = String(value);
  if (!(zero ? /^(0|[1-9]\d{0,19})$/ : /^[1-9]\d{0,19}$/).test(text)) throw new TypeError('Invalid decimal ID');
  return text;
}
function segments(list) {
  const values = Array.isArray(list) ? list : list?.asJsReadonlyArrayView?.();
  if (!Array.isArray(values) || values.length > 256) throw new TypeError('Unsupported SDK segment collection');
  return values;
}
export function normalizeAcidifyMessage(message, { sdk, selfId, selfUid = null }) {
  const scene = message.scene === sdk.MessageScene.FRIEND ? 'private' : message.scene === sdk.MessageScene.GROUP ? 'group' : null;
  if (!scene) throw new TypeError('Unsupported scene (temporary sessions are disabled)');
  const peerId = decimalId(message.peerUin), senderId = decimalId(message.senderUin);
  const sequence = decimalId(message.sequence, { zero: true });
  const messageUid = decimalId(message.messageUid, { zero: true });
  const timestamp = decimalId(message.timestamp, { zero: true });
  const random = message.random;
  if (!Number.isInteger(random) || random < -2147483648 || random > 4294967295) throw new TypeError('Invalid message random');
  let mentioned = false, replyTo = null, text = '', unsupported = 0;
  for (const segment of segments(message.segments)) {
    if (segment instanceof sdk.BotIncomingSegment.Text) {
      if (typeof segment.text !== 'string') throw new TypeError('Invalid text segment');
      text += segment.text;
    } else if (segment instanceof sdk.BotIncomingSegment.Mention) {
      const target = segment.uin == null ? null : decimalId(segment.uin, { zero: true });
      if (target === selfId || (selfUid && segment.uid === selfUid)) mentioned = true;
      // Names are display data only; they do not confer owner permissions.
      // Keep mention names outside model text and command parsing.
    } else if (segment instanceof sdk.BotIncomingSegment.Reply) {
      replyTo = { sequence: decimalId(segment.sequence, { zero: true }), senderId: decimalId(segment.senderUin) };
      if (replyTo.senderId === selfId) mentioned = true;
    } else { unsupported++; }
    if (text.length > 8000) throw new TypeError('Text exceeds 8000 characters');
  }
  return Object.freeze({ scene, peerId, senderId, sequence, messageUid, timestamp, random,
    text: text.trim(), mentioned, replyTo, unsupported,
    self: senderId === selfId || Boolean(selfUid && message.senderUid === selfUid),
    key: `${scene}:${peerId}:${senderId}:${messageUid !== '0' ? 'uid:' + messageUid : 'seq:' + sequence + ':random:' + random}` });
}

// Only used by explicitly labelled local fixtures. Runtime constructors exist in
// pinned SDK 1.6.3, although TS marks inbound constructors private. No login occurs.
export function makeSdkFixture(input, sdk, selfId) {
  if (!['private', 'group'].includes(input.scene)) throw new TypeError('Invalid fixture scene');
  const id = value => BigInt(decimalId(value));
  const parts = [];
  if (input.mentioned === true) parts.push(new sdk.BotIncomingSegment.Mention(BigInt(selfId), null, '机器人'));
  if (typeof input.text !== 'string') throw new TypeError('Invalid fixture text');
  parts.push(new sdk.BotIncomingSegment.Text(input.text));
  return new sdk.BotIncomingMessage(input.scene === 'group' ? sdk.MessageScene.GROUP : sdk.MessageScene.FRIEND,
    id(input.peerId), '', id(input.sequence), BigInt(Math.floor(Date.now() / 1000)), id(input.senderId), '',
    id(input.sequence), 0, id(input.messageUid), parts, null);
}
