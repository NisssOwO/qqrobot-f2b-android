import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createApplication, ROOT } from './runtime.mjs';
import { captureData, validateBundle, restoreData, createBackup, listBackups, readBackup } from './src/data-backup.mjs';

const roleIds = ['hinana', 'hazuki', 'toru'];
const options = { roleIds, appVersion: 'backup-test' };
const clone = value => JSON.parse(JSON.stringify(value));
const encode = (name, value) => {
  const bytes = Buffer.from(JSON.stringify(value));
  return { path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), data: bytes.toString('base64') };
};
let sequence = 500000n;
const input = text => { const id = String(++sequence); return { scene: 'private', peerId: '10001', senderId: '10001', text, sequence: id, messageUid: id }; };
export async function runBackupAcceptance({ check, makeDir }) {
  let bundle, source;
  await check('backup-restores-core-context-role-dedup-and-uncertain-freeze', async () => {
    source = makeDir('backup-source'); let app, restored;
    try {
      app = await createApplication({ dataDir: source });
      const first = input('THETA-preserved-context'); await app.receiveFixture(first);
      app.bridge.setRole('private', '10001', 'hazuki'); await app.receiveFixture(input('HAZUKI-preserved-context'));
      app.bridge.state.transportFaulted = true; app.bridge.persist();
      const secret = 'synthetic-credential-exclusion-7391';
      const configFile = path.join(source, 'config.json'); const cfg = JSON.parse(fs.readFileSync(configFile)); cfg.apiKey = secret; fs.writeFileSync(configFile, JSON.stringify(cfg));
      fs.writeFileSync(path.join(source, 'model-config.json'), JSON.stringify({ apiKey: secret }));
      fs.mkdirSync(path.join(source, '.runtime')); fs.writeFileSync(path.join(source, '.runtime/control.json'), JSON.stringify({ token: secret }));
      bundle = captureData(source, options);
      assert.ok(bundle.files.every(file => !Buffer.from(file.data, 'base64').toString().includes(secret)));
      assert.ok(!bundle.files.some(file => /model-config|control|service\.log/.test(file.path)));
      const destination = path.join(makeDir('backup-destination-parent'), 'new-data');
      restoreData(bundle, destination, options);
      assert.equal(fs.existsSync(path.join(destination, 'model-config.json')), false);
      if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(destination, 'config.json')).mode & 0o777, 0o600);
      restored = await createApplication({ dataDir: destination });
      assert.equal(restored.status().modelPreview.keyPresent, false);
      assert.equal((await restored.receiveFixture(first)).reason, 'duplicate');
      assert.equal((await restored.receiveFixture(input('must remain frozen'))).reason, 'transport-needs-review');
      // Controlled test fixture only: emulate a completed owner's transport review.
      restored.bridge.state.transportFaulted = false; restored.bridge.persist();
      assert.match((await restored.receiveFixture(input('second hazuki'))).reply, /第2轮.*HAZUKI-preserved-context/s);
      restored.bridge.setRole('private', '10001', 'hinana');
      assert.match((await restored.receiveFixture(input('second hinana'))).reply, /第2轮.*THETA-preserved-context/s);
      assert.equal(app.status().roleMap['private:10001'], 'hazuki');
      assert.throws(() => restoreData(bundle, destination, options));
    } finally { await restored?.close(); await app?.close(); }
  });
  await check('backup-import-path-hash-preset-role-and-missing-session-rejected-before-write', () => {
    const parent = makeDir('backup-invalid');
    const cases = [];
    for (const name of ['../escape.json', 'C:/escape.json', 'model-config.json', '.runtime/control.json']) {
      const edited = clone(bundle); edited.files.push(encode(name, {})); cases.push(edited);
    }
    const corrupt = clone(bundle); corrupt.files[0].sha256 = '0'.repeat(64); cases.push(corrupt);
    const duplicate = clone(bundle); duplicate.files.push(duplicate.files[0]); cases.push(duplicate);
    const role = clone(bundle); const gateway = role.files.find(file => file.path === 'gateway-state.json');
    const gatewayData = JSON.parse(Buffer.from(gateway.data, 'base64')); gatewayData.roleMap['private:10001'] = '../../outside';
    Object.assign(gateway, encode(gateway.path, gatewayData)); cases.push(role);
    const preset = clone(bundle); const session = preset.files.find(file => file.path.includes('/sessions/'));
    const sessionData = JSON.parse(Buffer.from(session.data, 'base64')); sessionData.preset = '../../outside';
    Object.assign(session, encode(session.path, sessionData)); cases.push(preset);
    const missing = clone(bundle); missing.files = missing.files.filter(file => !file.path.includes('/sessions/')); cases.push(missing);
    for (let i = 0; i < cases.length; i++) {
      const destination = path.join(parent, 'invalid-' + i);
      assert.throws(() => restoreData(cases[i], destination, options)); assert.equal(fs.existsSync(destination), false);
    }
    assert.equal(fs.existsSync(path.join(parent, '..', 'escape.json')), false);
  });
  await check('backup-file-limit-private-permissions-and-partial-write-cleanup', () => {
    const base = makeDir('backup-limit');
    fs.writeFileSync(path.join(base, 'config.json'), fs.readFileSync(path.join(ROOT, 'config.example.json')));
    for (let i = 0; i < 5; i++) {
      const result = createBackup(base, options); assert.ok(readBackup(base, result.id).length > 0);
      if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(base, 'backups', result.id + '.json')).mode & 0o777, 0o600);
    }
    assert.throws(() => createBackup(base, options)); assert.equal(listBackups(base).length, 5);
    const failure = makeDir('backup-disk-failure'); fs.writeFileSync(path.join(failure, 'config.json'), fs.readFileSync(path.join(ROOT, 'config.example.json')));
    const write = fs.writeFileSync;
    fs.writeFileSync = (file, ...args) => {
      if (typeof file === 'number') { write(file, 'partial'); throw new Error('synthetic storage failure'); }
      return write(file, ...args);
    };
    try { assert.throws(() => createBackup(failure, options)); } finally { fs.writeFileSync = write; }
    assert.deepEqual(fs.readdirSync(path.join(failure, 'backups')), []);
    assert.throws(() => readBackup(base, '../escape'));
    if (process.platform === 'android') {
      const symlinks = makeDir('backup-symlinks');
      fs.writeFileSync(path.join(symlinks, 'config.json'), fs.readFileSync(path.join(ROOT, 'config.example.json')));
      fs.symlinkSync(path.join(base, 'config.json'), path.join(symlinks, 'conversations.json'));
      assert.throws(() => captureData(symlinks, options)); fs.unlinkSync(path.join(symlinks, 'conversations.json'));
      fs.symlinkSync(path.join(base, 'backups'), path.join(symlinks, 'backups'));
      assert.throws(() => createBackup(symlinks, options));
    }
  });
  await check('backup-http-admin-auth-quiescence-download-and-new-directory-restore', async () => {
    const dataDir = makeDir('backup-http'); let app, release;
    let entered; const enteredPromise = new Promise(resolve => { entered = resolve; });
    try {
      app = await createApplication({ dataDir, fixtureModel: async () => { entered(); await new Promise(resolve => { release = resolve; }); return { choices: [{ message: { content: 'controlled reply' } }] }; } });
      const page = await (await fetch(app.origin)).text(); const token = page.match(/const token='([a-f0-9]+)'/)[1];
      const headers = { 'content-type': 'application/json', 'x-lab-token': token };
      assert.equal((await fetch(app.origin + '/api/backups')).status, 403);
      const pending = app.receiveFixture(input('backup race')); await enteredPromise;
      assert.equal((await fetch(app.origin + '/api/backup/create', { method: 'POST', headers, body: '{}' })).status, 409);
      release(); await pending;
      const result = await (await fetch(app.origin + '/api/backup/create', { method: 'POST', headers, body: '{}' })).json(); assert.ok(result.id);
      const downloadUrl = app.origin + '/api/backup/download?id=' + result.id;
      assert.equal((await fetch(downloadUrl)).status, 403);
      const response = await fetch(downloadUrl, { headers }); assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition'), /attachment/);
      const downloaded = await response.json(); validateBundle(downloaded, options);
      const list = await (await fetch(app.origin + '/api/backups', { headers })).json(); assert.equal(list.backups.length, 1);
      const restored = await (await fetch(app.origin + '/api/backup/restore', { method: 'POST', headers, body: JSON.stringify(downloaded) })).json();
      assert.equal(restored.activeDataChanged, false); assert.equal(restored.credentialsRestored, false);
      assert.ok(fs.existsSync(path.join(dataDir, 'restored', restored.id, 'conversations.json')));
      assert.equal(app.status().conversation.sessions, 1);
    } finally { release?.(); await app?.close(); }
  });
}
