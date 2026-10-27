import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { validatePolicy } from './gateway/text-bridge.mjs';
import { parseHm } from './quiet-hours.mjs';

export const MAX_BACKUP_BYTES = 48 * 1024 * 1024;
const MAX_DATA_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 1024;
const FORMAT = 'qqrobot-text-data-v1';
const digest = buffer => createHash('sha256').update(buffer).digest('hex');
const allowed = file => /^(?:config\.json|gateway-state\.json|conversations\.json|standalone\/(?:meta\.json|sessions\/sess-[a-z0-9-]+\.json)|model-preview\/[a-f0-9]{24}\/(?:conversations\.json|standalone\/(?:meta\.json|sessions\/sess-[a-z0-9-]+\.json)))$/.test(file);
const descend = dir => /^(?:standalone(?:\/sessions)?|model-preview(?:\/[a-f0-9]{24}(?:\/standalone(?:\/sessions)?)?)?)$/.test(dir);
const backupId = () => `${Date.now()}-${randomBytes(6).toString('hex')}`;
const validId = id => typeof id === 'string' && /^\d{13}-[a-f0-9]{12}$/.test(id);
const sessionId = id => typeof id === 'string' && /^sess-[a-z0-9-]+$/.test(id);
const workspaceId = id => typeof id === 'string' && /^ws-[a-z0-9-]+$/.test(id);
const targetKey = key => /^(private|group):[1-9]\d{0,19}$/.test(key);
const messageKey = key => /^(?:(private|group):[1-9]\d{0,19}:[1-9]\d{0,19}:(uid:[1-9]\d{0,19}|seq:\d{1,20}:random:-?\d{1,10})|onebot:[1-9]\d{0,19}:(private|group):[1-9]\d{0,19}:[1-9]\d{0,19}:(?:0|-?[1-9]\d{0,19}))$/.test(key);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const finite = value => Number.isFinite(value) && value >= 0;
function privateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Backup directory must be private and regular');
}

function cleanFile(name, value, roleIds) {
  if (!object(value)) throw new Error('Invalid backup JSON object');
  if (name === 'config.json') return cleanConfig(value, roleIds);
  if (name.endsWith('conversations.json')) {
    if (Object.keys(value).length > 64) throw new Error('Conversation map limit');
    for (const [key, id] of Object.entries(value)) {
      const parts = key.split(':');
      if (parts.length !== 3 || !targetKey(parts.slice(0, 2).join(':')) || !roleIds.includes(parts[2]) || !sessionId(id)) throw new Error('Invalid conversation map');
    }
    return value;
  }
  if (name === 'gateway-state.json') {
    if (!object(value.seen) || !object(value.roleMap) || !object(value.counters) || !Array.isArray(value.outbox) || value.outbox.length > 100) throw new Error('Invalid gateway backup state');
    const seen = {};
    for (const [key, record] of Object.entries(value.seen)) {
      if (!messageKey(key) || !object(record) || !/^[a-z][a-z-]{0,63}$/.test(record.status) || !finite(record.at)) throw new Error('Invalid dedup record');
      seen[key] = { status: record.status, at: record.at };
    }
    for (const [key, role] of Object.entries(value.roleMap)) if (!targetKey(key) || !roleIds.includes(role)) throw new Error('Invalid restored role');
    const counters = {};
    for (const [key, count] of Object.entries(value.counters)) {
      if (!/^[a-z][a-z-]{0,63}$/.test(key) || !Number.isSafeInteger(count) || count < 0) throw new Error('Invalid counter'); counters[key] = count;
    }
    const outbox = value.outbox.map(item => {
      if (!object(item) || !messageKey(item.key) || !targetKey(`${item.scene}:${item.peerId}`) || !roleIds.includes(item.role) || typeof item.text !== 'string' || item.text.length > 2000 || !finite(item.at) || typeof item.receipt !== 'string' || item.receipt.length > 128) throw new Error('Invalid outbox');
      return { key: item.key, scene: item.scene, peerId: item.peerId, role: item.role, text: item.text, at: item.at, receipt: item.receipt };
    });
    return { seen, roleMap: value.roleMap, counters, outbox, transportFaulted: value.transportFaulted === true };
  }
  if (name.endsWith('/meta.json')) {
    const workspaces = {}, sessions = {};
    for (const [id, info] of Object.entries(value.workspaces ?? {})) {
      if (!workspaceId(id) || !object(info)) throw new Error('Invalid workspace metadata');
      // Old absolute paths are not portable and must not direct restored IO.
      workspaces[id] = { path: '.', createdAt: info.createdAt };
    }
    for (const [id, info] of Object.entries(value.sessions ?? {})) {
      if (!sessionId(id) || !workspaceId(info?.workspaceId) || info.preset !== 'text-chat') throw new Error('Invalid session metadata');
      sessions[id] = { workspaceId: info.workspaceId, preset: 'text-chat', updatedAt: info.updatedAt };
    }
    return { workspaces, sessions, sessionSeq: Number.isSafeInteger(value.sessionSeq) ? value.sessionSeq : 0, turnSeq: Number.isSafeInteger(value.turnSeq) ? value.turnSeq : 0 };
  }
  if (name.includes('/sessions/')) {
    const expected = path.posix.basename(name, '.json');
    if (value.id !== expected || !workspaceId(value.workspaceId) || value.preset !== 'text-chat' || !Array.isArray(value.messages) || value.messages.length > 512 || typeof value.summary !== 'string') throw new Error('Invalid session identity or preset');
    const messages = value.messages.map(message => {
      if (!object(message) || !['user', 'assistant', 'tool'].includes(message.role) || typeof message.content !== 'string') throw new Error('Only text conversation backups are supported');
      if (message.tool_calls !== undefined && (!Array.isArray(message.tool_calls) || message.tool_calls.some(call => !object(call) || typeof call.id !== 'string' || typeof call.function?.name !== 'string' || typeof call.function?.arguments !== 'string'))) throw new Error('Invalid historical tool call');
      if (message.role === 'tool' && typeof message.tool_call_id !== 'string') throw new Error('Invalid tool result reference');
      return { role: message.role, content: message.content,
        ...(message.role === 'tool' ? { tool_call_id: message.tool_call_id } : {}),
        ...(message.tool_calls ? { tool_calls: message.tool_calls.map(call => ({ id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } })) } : {}) };
    });
    return { id: value.id, workspaceId: value.workspaceId, preset: 'text-chat', model: null, messages, summary: value.summary, createdAt: value.createdAt, updatedAt: value.updatedAt };
  }
  throw new Error('Unsupported backup state');
}

function cleanConfig(raw, roleIds) {
  if (raw.backend !== 'standalone' || raw.mode !== 'simulation') throw new Error('Unsupported backup application mode');
  const quiet = raw.quietHours;
  if (typeof quiet?.enabled !== 'boolean' || !Array.isArray(quiet.workday?.weekdays) || !quiet.workday.weekdays.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) throw new Error('Invalid quiet settings');
  const section = source => {
    if (!Array.isArray(source?.windows) || source.windows.length > 12) throw new Error('Invalid quiet windows');
    return source.windows.map(w => {
      if (!Array.isArray(w) || w.length !== 2 || w.some(t => typeof t !== 'string') || parseHm(w[0]) === null || parseHm(w[1]) === null || parseHm(w[0]) >= parseHm(w[1])) throw new Error('Invalid quiet window');
      return [w[0], w[1]];
    });
  };
  // Explicit schema: unknown config properties may be credentials; omit them.
  return { backend: 'standalone', mode: 'simulation', policy: validatePolicy(raw.policy, roleIds), quietHours: {
    enabled: quiet.enabled, holidays: 'none', workday: { weekdays: [...quiet.workday.weekdays], windows: section(quiet.workday) }, offday: { windows: section(quiet.offday) }
  } };
}
function filesIn(root, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!allowed(relative) && !descend(relative)) continue;
    if (entry.isSymbolicLink()) throw new Error('Symlinks are not supported in backups');
    if (entry.isDirectory() && descend(relative)) files.push(...filesIn(root, relative));
    else if (entry.isFile() && allowed(relative)) files.push(relative);
    else throw new Error('Unsupported backup file');
  }
  return files.sort();
}
function readRegular(file) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) throw new Error('Invalid backup source file');
  return fs.readFileSync(file);
}
// Caller must quiesce all writers. The Web API checks both queues and runs this
// synchronous capture without yielding the application event loop.
export function captureData(dataDir, { roleIds, appVersion = 'unknown' }) {
  const names = filesIn(dataDir);
  if (!names.includes('config.json') || names.length > MAX_FILES) throw new Error('Missing config or too many files');
  let total = 0;
  const sourceHashes = new Map();
  const files = names.map(name => {
    const original = readRegular(path.join(dataDir, name)); sourceHashes.set(name, digest(original));
    const parsed = JSON.parse(original.toString('utf8'));
    const data = Buffer.from(JSON.stringify(cleanFile(name, parsed, roleIds)));
    total += data.length; if (total > MAX_DATA_BYTES) throw new Error('Backup data limit exceeded');
    return { path: name, bytes: data.length, sha256: digest(data), data: data.toString('base64') };
  });
  // Detect external writers as well as changes in the selected file set.
  if (JSON.stringify(filesIn(dataDir)) !== JSON.stringify(names) || names.some(name => digest(readRegular(path.join(dataDir, name))) !== sourceHashes.get(name))) throw new Error('Data changed during capture; stop writers before backup');
  return { format: FORMAT, createdAt: new Date().toISOString(), appVersion, credentialFilesIncluded: false, files };
}
export function validateBundle(bundle, { roleIds }) {
  if (bundle?.format !== FORMAT || !Array.isArray(bundle.files) || bundle.files.length < 1 || bundle.files.length > MAX_FILES) throw new Error('Unsupported backup format');
  const seen = new Set(); let total = 0;
  const decoded = bundle.files.map(entry => {
    if (typeof entry.path !== 'string' || !allowed(entry.path) || seen.has(entry.path)) throw new Error('Unsupported or duplicate backup path');
    seen.add(entry.path);
    if (!Number.isInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_FILE_BYTES || typeof entry.data !== 'string' || entry.data.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.data)) throw new Error('Invalid backup encoding');
    total += entry.bytes; if (total > MAX_DATA_BYTES) throw new Error('Backup data limit exceeded');
    let data = Buffer.from(entry.data, 'base64');
    if (data.length !== entry.bytes || !/^[a-f0-9]{64}$/.test(entry.sha256) || digest(data) !== entry.sha256) throw new Error('Backup integrity check failed');
    const parsed = JSON.parse(data.toString('utf8'));
    // Apply the same credential whitelist to imported, potentially edited files.
    data = Buffer.from(JSON.stringify(cleanFile(entry.path, parsed, roleIds), null, 2));
    return { path: entry.path, data };
  });
  if (!seen.has('config.json')) throw new Error('Backup configuration missing');
  for (const file of decoded.filter(file => file.path.endsWith('conversations.json'))) {
    const prefix = file.path.slice(0, -'conversations.json'.length);
    for (const id of Object.values(JSON.parse(file.data))) if (!seen.has(`${prefix}standalone/sessions/${id}.json`)) throw new Error('Conversation references missing session');
  }
  return decoded;
}
export function restoreData(bundle, destination, { roleIds }) {
  // Validate every byte/path before creating a destination. Never merge into a
  // live directory. A failed write leaves only a clearly separate partial copy.
  const files = validateBundle(bundle, { roleIds });
  destination = path.resolve(destination);
  fs.mkdirSync(destination, { mode: 0o700 }); // Exclusive: existing directories fail.
  try {
    for (const entry of files) {
      const target = path.resolve(destination, entry.path);
      if (!target.startsWith(destination + path.sep)) throw new Error('Unsafe restore target');
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, entry.data, { flag: 'wx', mode: 0o600 });
    }
  } catch { throw new Error('Restore incomplete; original data untouched; separate destination retained for review'); }
  return { restoredFiles: files.length, activeDataChanged: false, credentialsRestored: false };
}
export function createBackup(dataDir, options) {
  const dir = path.join(dataDir, 'backups'); privateDirectory(dir);
  if (listBackups(dataDir).length >= 5) throw new Error('Backup limit reached; retain or remove previous backups manually');
  const bundle = captureData(dataDir, options); const encoded = JSON.stringify(bundle);
  if (Buffer.byteLength(encoded) > MAX_BACKUP_BYTES) throw new Error('Backup file limit exceeded');
  const id = backupId(); const target = path.join(dir, id + '.json'); const temporary = target + '.tmp';
  let descriptor, created = false;
  try { descriptor = fs.openSync(temporary, 'wx', 0o600); created = true; fs.writeFileSync(descriptor, encoded); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined; fs.renameSync(temporary, target); }
  catch (error) { if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} } if (created) { try { fs.unlinkSync(temporary); } catch {} } throw error; }
  return { id, bytes: Buffer.byteLength(encoded), files: bundle.files.length, credentialsIncluded: false };
}
export function listBackups(dataDir) {
  const dir = path.join(dataDir, 'backups'); if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => validId(name.slice(0, -5)) && name.endsWith('.json')).flatMap(name => {
    const stat = fs.lstatSync(path.join(dir, name));
    return stat.isFile() && !stat.isSymbolicLink() ? [{ id: name.slice(0, -5), bytes: stat.size, createdAt: stat.mtime.toISOString() }] : [];
  }).sort((a, b) => b.id.localeCompare(a.id));
}
export function readBackup(dataDir, id) {
  if (!validId(id)) throw new Error('Invalid backup identifier');
  const file = path.join(dataDir, 'backups', id + '.json'); const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BACKUP_BYTES) throw new Error('Invalid private backup');
  return fs.readFileSync(file);
}
export function stageRestore(dataDir, bundle, options) {
  const parent = path.join(dataDir, 'restored'); privateDirectory(parent);
  if (fs.readdirSync(parent).filter(validId).length >= 3) throw new Error('Restore copy limit reached');
  const id = backupId(); const result = restoreData(bundle, path.join(parent, id), options);
  return { ...result, id };
}
