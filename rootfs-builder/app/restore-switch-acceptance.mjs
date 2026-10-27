import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createSupervisor, serviceCommand } from './service.mjs';
import { captureData, stageRestore } from './src/data-backup.mjs';
import { selectedData, selectData } from './src/data-selection.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const roles = JSON.parse(fs.readFileSync(path.join(root, 'resources/roles.json'))).map(r => r.id);
const temp = fs.mkdtempSync(path.join(root, 'restore-switch-test-'));
const checks = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 200; i++) { try { const value = await fn(); if (value) return value; } catch {} await sleep(25); } throw Error('Service observation deadline'); }
async function check(name, run) { await run(); checks.push({ name, passed: true }); }
let manager;
try {
  const dataDir = path.join(temp, 'data'); fs.mkdirSync(dataDir);
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'))); cfg.quietHours.enabled = false;
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(cfg));
  fs.writeFileSync(path.join(dataDir, 'model-config.json'), JSON.stringify({ baseUrl: 'https://models.example/v1', model: 'controlled', apiKey: 'synthetic-test-key-only', revision: 'a'.repeat(24) }));
  await check('selection-rejects-path-escape-and-incomplete-restore-before-pointer-write', async () => {
    for (const id of ['../outside', '/root', '1793000000000-nothex', null]) assert.throws(() => selectData(dataDir, id, { roleIds: roles }));
    const incomplete = path.join(dataDir, 'restored', '1793000000000-aaaaaaaaaaaa'); fs.mkdirSync(incomplete, { recursive: true });
    assert.throws(() => selectData(dataDir, path.basename(incomplete), { roleIds: roles }));
    assert.equal(fs.existsSync(path.join(dataDir, '.runtime/selection.json')), false);
    assert.equal(selectedData(dataDir, { roleIds: roles }).id, 'original');
  });
  const reserve = http.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const child = path.join(temp, 'managed-app.mjs');
  fs.writeFileSync(child, `process.env.QQROBOT_PORT=${JSON.stringify(String(port))}; await import(${JSON.stringify(new URL('./server.mjs', import.meta.url).href)});`);
  manager = await createSupervisor({ dataDir, controlPort: 0, stopGraceMs: 1000, baseDelayMs: 50,
    command: [process.execPath, '--require', path.join(root, 'network-guard.cjs'), child] });
  const origin = `http://127.0.0.1:${port}`;
  async function session() {
    const response = await fetch(origin); if (!response.ok) throw Error('Page unavailable');
    const page = await response.text(), token = page.match(/const token='([a-f0-9]+)'/)?.[1];
    if (!token) throw Error('Missing management credential');
    return async (route, body) => {
      const r = await fetch(origin + route, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-lab-token': token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await r.json(); if (!r.ok) throw Object.assign(Error(value.error), { status: r.status }); return value;
    };
  }
  let api = await until(session), firstPid, copyId;
  const input = text => ({ scene: 'private', peerId: '10001', senderId: '10001', text, sequence: '11', messageUid: '22' });
  await check('managed-api-auth-and-restore-preserve-live-original', async () => {
    firstPid = (await api('/api/runtime')).pid;
    assert.equal((await api('/api/status')).modelPreview.configured, true);
    assert.equal((await fetch(origin + '/api/restores')).status, 403);
    assert.equal((await fetch(origin + '/api/restore/activate', { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await api('/api/fixture', input('first historical turn'))).accepted, true);
    await api('/api/role', { scene: 'private', peerId: '10001', role: 'toru' });
    const bundle = captureData(dataDir, { roleIds: roles });
    const result = await api('/api/backup/restore', bundle); copyId = result.id;
    assert.equal((await api('/api/runtime')).pid, firstPid);
    assert.equal((await api('/api/restores')).activeId, 'original');
    assert((await api('/api/restores')).copies.some(c => c.id === copyId));
    await api('/api/role', { scene: 'private', peerId: '10001', role: 'hinana' });
  });
  await check('activate-copy-restarts-owned-child-retains-dedup-role-and-no-credentials', async () => {
    const activated = await api('/api/restore/activate', { id: copyId }); assert.equal(activated.accepted, true);
    await until(async () => { const next = await session(); const state = await next('/api/runtime'); if (state.pid === firstPid || state.activeDataId !== copyId) return false; api = next; return true; });
    assert.equal(manager.status().launches, 2); assert.equal(manager.status().activeDataId, copyId);
    assert.equal((await api('/api/status')).roleMap['private:10001'], 'toru');
    assert.equal((await api('/api/status')).conversation.sessions, 1);
    assert.equal((await api('/api/fixture', input('same event redelivered'))).reason, 'duplicate');
    assert.equal((await api('/api/status')).modelPreview.configured, false);
    assert.equal(fs.existsSync(path.join(dataDir, 'restored', copyId, 'model-config.json')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'gateway-state.json'))).roleMap['private:10001'], 'hinana');
    const originalMap = JSON.parse(fs.readFileSync(path.join(dataDir, 'conversations.json')));
    const sessionId = Object.values(originalMap)[0];
    assert.equal(fs.existsSync(path.join(dataDir, 'restored', copyId, 'standalone/sessions', sessionId + '.json')), true);
  });
  await check('child-and-cold-manager-restarts-reopen-copy-and-return-to-original', async () => {
    const previous = manager.status().childPid;
    await serviceCommand('restart', dataDir);
    await until(async () => { const next = await session(); const state = await next('/api/runtime'); if (state.pid === previous || state.activeDataId !== copyId) return false; api = next; return true; });
    assert.equal((await api('/api/restores')).activeId, copyId);
    const oldInstance = manager.instanceId;
    await manager.stop();
    manager = await createSupervisor({ dataDir, controlPort: 0, stopGraceMs: 1000, baseDelayMs: 50,
      command: [process.execPath, '--require', path.join(root, 'network-guard.cjs'), child] });
    api = await until(session);
    assert.notEqual(manager.instanceId, oldInstance);
    assert.equal((await api('/api/runtime')).activeDataId, copyId);
    const selectedPid = manager.status().childPid;
    await api('/api/restore/activate', { id: 'original' });
    await until(async () => { const next = await session(); const state = await next('/api/runtime'); if (state.pid === selectedPid || state.activeDataId !== 'original') return false; api = next; return true; });
    assert.equal((await api('/api/status')).roleMap['private:10001'], 'hinana');
    assert.equal((await api('/api/status')).modelPreview.configured, true);
    assert.equal((await api('/api/runtime')).modelRequestAttempts, 0);
    assert.equal(manager.status().launches, 2);
  });
  await check('onebot-signed-id-dedup-and-uncertain-freeze-survive-backup', async () => {
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'gateway-state.json')));
    state.seen['onebot:90001:private:10001:10001:-456'] = { status: 'uncertain', at: 1793000000000 };
    state.transportFaulted = true;
    fs.writeFileSync(path.join(dataDir, 'gateway-state.json'), JSON.stringify(state));
    const bundle = captureData(dataDir, { roleIds: roles });
    const restored = stageRestore(dataDir, bundle, { roleIds: roles });
    const copy = JSON.parse(fs.readFileSync(path.join(dataDir, 'restored', restored.id, 'gateway-state.json')));
    assert.equal(copy.seen['onebot:90001:private:10001:10001:-456'].status, 'uncertain');
    assert.equal(copy.transportFaulted, true);
  });
  const report = { passed: true, platform: process.platform, uid: process.getuid?.() ?? null, scope: 'Actual managed local application restarts and private restore copies; no QQ or paid model', checks };
  if (process.env.RESTORE_SWITCH_REPORT) fs.writeFileSync(process.env.RESTORE_SWITCH_REPORT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await manager?.stop();
  if (path.dirname(path.resolve(temp)) !== root || !path.basename(temp).startsWith('restore-switch-test-')) throw Error('Unsafe cleanup');
  fs.rmSync(temp, { recursive: true, force: true });
}
