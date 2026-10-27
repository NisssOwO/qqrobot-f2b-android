import fs from 'node:fs';
import path from 'node:path';
import { captureData, validateBundle } from './data-backup.mjs';
import { atomicJson } from './gateway/text-bridge.mjs';
const validId = id => id === 'original' || typeof id === 'string' && /^\d{13}-[a-f0-9]{12}$/.test(id);
const regularDirectory = dir => {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid data directory');
};
const selectionFile = base => path.join(path.resolve(base), '.runtime', 'selection.json');
export function selectedData(base, options) {
  const file = selectionFile(base);
  let id = 'original';
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error('Invalid data selection');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.version !== 1 || !validId(value.id)) throw new Error('Invalid selected copy');
    id = value.id;
  }
  return resolveData(base, id, options);
}
export function resolveData(base, id, options) {
  base = path.resolve(base);
  if (!validId(id)) throw new Error('Invalid restore identifier');
  regularDirectory(base);
  if (id === 'original') return { id, dataDir: base };
  const parent = path.join(base, 'restored'); regularDirectory(parent);
  const dataDir = path.join(parent, id); regularDirectory(dataDir);
  // Refuse incomplete or subsequently edited copies before scheduling a restart.
  validateBundle(captureData(dataDir, options), options);
  return { id, dataDir };
}
export function selectData(base, id, options) {
  const selected = resolveData(base, id, options);
  if (id === 'original') validateBundle(captureData(selected.dataDir, options), options);
  const runtime = path.join(path.resolve(base), '.runtime');
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 }); regularDirectory(runtime);
  atomicJson(selectionFile(base), { version: 1, id: selected.id });
  return { selectedId: selected.id };
}
export function listRestores(base) {
  const parent = path.join(path.resolve(base), 'restored');
  if (!fs.existsSync(parent)) return [];
  regularDirectory(parent);
  return fs.readdirSync(parent, { withFileTypes: true }).filter(e => validId(e.name) && e.name !== 'original' && e.isDirectory() && !e.isSymbolicLink()).map(e => ({ id: e.name })).sort((a,b) => b.id.localeCompare(a.id));
}
