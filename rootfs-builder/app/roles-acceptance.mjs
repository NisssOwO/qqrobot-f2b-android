#!/usr/bin/env node
/**
 * Role-card management acceptance. Runs the real server against a throwaway
 * prompts directory, so the card CRUD, the guards and the injected size limit
 * are all exercised without touching the shipped cards.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqrobot-roles-'));

let pass = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`PASS ${name}`); }
  else { console.log(`FAIL ${name} — ${detail}`); process.exitCode = 1; }
};

function seed() {
  const dir = path.join(TMP, 'prompts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hinana.md'), '# 角色卡：七草日花（七草にちか）\n\n## 你是谁\n\n283 事务所的偶像。\n');
  fs.writeFileSync(path.join(dir, 'hazuki.md'), '# 角色卡：七草はづき\n\n## 你是谁\n\n制作人。\n');
  fs.writeFileSync(path.join(dir, 'text-chat.md'), '# preset\n');
  return dir;
}

function request(port, method, p, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {};
    if (token) headers['x-lab-token'] = token;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const prompts = seed();
const logPath = path.join(TMP, 'server.log');
const logFd = fs.openSync(logPath, 'w');
const child = spawn(NODE, ['--require', './network-guard.cjs', 'server.mjs'], {
  cwd: HERE,
  env: {
    ...process.env,
    QQROBOT_DATA_DIR: path.join(TMP, 'data'),
    QQROBOT_PROMPTS_DIR: prompts,
    QQROBOT_BIND: '127.0.0.1',
    QQROBOT_PORT: '38211',
    QQROBOT_PASSWORD: '',
  },
  stdio: ['ignore', logFd, logFd],
});

function readLog() { try { return fs.readFileSync(logPath, 'utf8'); } catch { return ''; } }
async function waitPort() {
  for (let i = 0; i < 60; i += 1) {
    const m = /E_TEXT_WEBUI_READY http:\/\/127\.0\.0\.1:(\d+)/.exec(readLog());
    if (m) return Number(m[1]);
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`server did not start: ${readLog().slice(-600)}`);
}

try {
  const port = await waitPort();
  const get = (p) => request(port, 'GET', p);
  // Every non-GET route requires the page token; take it from the served page.
  const page = await get('/');
  const PAGE_TOKEN = /const token='([0-9a-f]{64})'/.exec(page.body)?.[1] ?? '';
  check('the page carries a token for form posts', PAGE_TOKEN.length === 64, `len=${PAGE_TOKEN.length}`);
  const post = (p, body) => request(port, 'POST', p, body, PAGE_TOKEN);

  const list = await get('/api/roles');
  const listBody = JSON.parse(list.body);
  check('GET /api/roles is 200', list.status === 200, `status=${list.status}`);
  check('the preset prompt is not listed as a role',
    !listBody.roles.some(r => r.id === 'text-chat'), JSON.stringify(listBody.roles.map(r => r.id)));
  check('two seeded role cards are listed', listBody.roles.length === 2, JSON.stringify(listBody.roles.map(r => r.id)));
  const hinana = listBody.roles.find(r => r.id === 'hinana');
  check('the summary carries size stats',
    hinana && typeof hinana.chars === 'number' && hinana.bytes > 0 && hinana.lines >= 1, JSON.stringify(hinana));
  check('the display name comes from the card heading', hinana?.name === '七草日花', JSON.stringify(hinana?.name));
  check('the limits are reported', listBody.limits?.injectMaxChars === 8000 && listBody.limits?.contentMaxBytes === 65536);

  const content = await get('/api/roles/content?id=hinana');
  const contentBody = JSON.parse(content.body);
  check('GET /api/roles/content returns the card', content.status === 200 && contentBody.content.includes('283 事务所'), content.body.slice(0, 120));

  const missing = await get('/api/roles/content?id=nope');
  check('GET content for an unknown role is 404', missing.status === 404, `status=${missing.status}`);

  const traversal = await get('/api/roles/content?id=..%2Fetc%2Fpasswd');
  check('a path traversal id is refused', traversal.status === 400, `status=${traversal.status}`);

  const created = await post('/api/roles/save', { name: '朝日', content: '# 角色卡：芹泽朝日\n\n## 你是谁\n\nStraylight 的中心。\n' });
  check('POST /api/roles/save creates a card', created.status === 200 && JSON.parse(created.body).id === '朝日', created.body.slice(0, 160));
  check('the card file landed in the prompts dir', fs.existsSync(path.join(prompts, '朝日.md')));

  const afterCreate = JSON.parse((await get('/api/roles')).body);
  check('the new role shows up in the list', afterCreate.roles.length === 3 && afterCreate.roles.some(r => r.id === '朝日'), JSON.stringify(afterCreate.roles.map(r => r.id)));

  const duplicate = await post('/api/roles/save', { name: '朝日', content: 'x' });
  check('creating a duplicate name is 409', duplicate.status === 409, `status=${duplicate.status}`);

  const updated = await post('/api/roles/save', { id: '朝日', content: '# 角色卡：芹泽朝日\n\n## 你是谁\n\n改过的内容。\n' });
  check('POST /api/roles/save updates an existing card', updated.status === 200, updated.body.slice(0, 120));
  check('the update is on disk', fs.readFileSync(path.join(prompts, '朝日.md'), 'utf8').includes('改过的内容'));

  const tooBig = await post('/api/roles/save', { id: '朝日', content: 'x'.repeat(65537) });
  check('a card over 64 KB is refused', tooBig.status === 400, `status=${tooBig.status}`);

  const long = await post('/api/roles/save', { id: '朝日', content: '# 角色卡：芹泽朝日\n\n' + 'あ'.repeat(9000) });
  const longBody = JSON.parse(long.body);
  check('an over-long card saves with a truncation warning',
    long.status === 200 && longBody.warnings.length === 1 && longBody.truncated === true, long.body.slice(0, 200));

  const renamed = await post('/api/roles/rename', { id: '朝日', name: 'asahi' });
  check('POST /api/roles/rename moves the file',
    renamed.status === 200 && fs.existsSync(path.join(prompts, 'asahi.md')) && !fs.existsSync(path.join(prompts, '朝日.md')), renamed.body.slice(0, 120));

  const renameClash = await post('/api/roles/rename', { id: 'asahi', name: 'hinana' });
  check('renaming onto an existing role is 409', renameClash.status === 409, `status=${renameClash.status}`);

  const deleted = await post('/api/roles/delete', { id: 'asahi' });
  check('POST /api/roles/delete removes the card',
    deleted.status === 200 && !fs.existsSync(path.join(prompts, 'asahi.md')), deleted.body.slice(0, 120));

  const deleteDefault = await post('/api/roles/delete', { id: 'hinana' });
  check('deleting the role in use is refused', deleteDefault.status === 409, `status=${deleteDefault.status}`);

  const erased = await post('/api/roles/delete', { id: '../escape' });
  check('a traversal id is refused on delete', erased.status === 400, `status=${erased.status}`);
} catch (error) {
  check('acceptance harness ran', false, error.message);
} finally {
  child.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 400));
  fs.closeSync(logFd);
  fs.rmSync(TMP, { recursive: true, force: true });
}

if (!process.exitCode) console.log(`\nALL ROLE ACCEPTANCE PASSED (${pass}/${pass})`);