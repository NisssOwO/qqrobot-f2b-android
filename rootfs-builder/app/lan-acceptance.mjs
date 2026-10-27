// LAN exposure acceptance: verify bind + host whitelist + password gate.
// Run: node lan-acceptance.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const APP_DIR = process.cwd().replace(/\\/g, '/');
const NODE_BIN = 'F:/node-v24.16.0-win-x64/node.exe';
let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); failures++; }
}
function get(port, host, path, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host, ...headers } }, res => {
      let body = ''; res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', e => resolve({ status: 0, body: String(e) }));
    req.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function startServer(env, logFile) {
  try { fs.unlinkSync(logFile); } catch {}
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(NODE_BIN, ['server.mjs'], {
    cwd: APP_DIR,
    env: { ...process.env, QQROBOT_DATA_DIR: APP_DIR + '/data-lan-test', ...env },
    stdio: ['ignore', fd, fd],
  });
  let exited = false, code = null;
  child.on('exit', (c) => { exited = true; code = c; });
  for (let i = 0; i < 40 && !exited; i++) {
    await sleep(150);
    let out = '';
    try { out = fs.readFileSync(logFile, 'utf8'); } catch {}
    if (out.includes('E_TEXT_WEBUI_READY')) break;
  }
  await sleep(150);
  let out = '';
  try { out = fs.readFileSync(logFile, 'utf8'); } catch {}
  return { child, out: () => out, exited: () => exited, code: () => code };
}

console.log('== 1. bind 0.0.0.0 without password must refuse to start ==');
{
  const s = await startServer({ QQROBOT_BIND: '0.0.0.0', QQROBOT_PORT: '38201' }, APP_DIR + '/lan-log1.txt');
  check('process exited', s.exited() === true);
  check('error mentions QQROBOT_PASSWORD', /QQROBOT_PASSWORD/.test(s.out()), s.out().slice(0, 300));
}

console.log('== 2. bind 127.0.0.1 default (no password) still works ==');
{
  const s = await startServer({ QQROBOT_PORT: '38202', QQROBOT_BIND: '127.0.0.1' }, APP_DIR + '/lan-log2.txt');
  try {
    const r = await get(38202, '127.0.0.1:38202', '/api/status');
    check('GET /api/status 200', r.status === 200, r.status + ' ' + r.body.slice(0, 120));
    check('bind logged as loopback', s.out().includes('127.0.0.1:38202'));
  } finally { s.child.kill(); }
}

console.log('== 3. bind 0.0.0.0 with password: 401 / 200 / host whitelist / CORS ==');
{
  const s = await startServer({ QQROBOT_BIND: '0.0.0.0', QQROBOT_PORT: '38203', QQROBOT_PASSWORD: 'test-pass-123' }, APP_DIR + '/lan-log3.txt');
  try {
    const noAuth = await get(38203, '192.168.31.50:38203', '/api/status');
    check('lan host without auth -> 401', noAuth.status === 401, noAuth.status + '');
    check('www-authenticate present', /Basic/.test(noAuth.headers['www-authenticate'] || ''), String(noAuth.headers['www-authenticate']));

    const auth = 'Basic ' + Buffer.from('user:test-pass-123').toString('base64');
    const withAuth = await get(38203, '192.168.31.50:38203', '/api/status', { authorization: auth });
    check('lan host with auth -> 200', withAuth.status === 200, withAuth.status + ' ' + withAuth.body.slice(0, 120));

    const wrongAuth = 'Basic ' + Buffer.from('user:wrong').toString('base64');
    const bad = await get(38203, '192.168.31.50:38203', '/api/status', { authorization: wrongAuth });
    check('wrong password -> 401', bad.status === 401, bad.status + '');

    const publicHost = await get(38203, '8.8.8.8:38203', '/api/status', { authorization: auth });
    check('public IP host -> 403', publicHost.status === 403, publicHost.status + '');

    const loop = await get(38203, '127.0.0.1:38203', '/api/status', { authorization: auth });
    check('loopback host with auth -> 200', loop.status === 200, loop.status + '');

    const cors = await get(38203, '192.168.31.50:38203', '/api/status', { authorization: auth, origin: 'http://192.168.31.20:38203' });
    check('CORS allows LAN sibling origin', cors.headers['access-control-allow-origin'] === 'http://192.168.31.20:38203', String(cors.headers['access-control-allow-origin']));

    const badCors = await get(38203, '192.168.31.50:38203', '/api/status', { authorization: auth, origin: 'http://evil.example.com' });
    check('CORS rejects unknown origin', !badCors.headers['access-control-allow-origin'], String(badCors.headers['access-control-allow-origin']));

    const page = await get(38203, '192.168.31.50:38203', '/', { authorization: auth });
    check('GET / returns panel html', page.status === 200 && /<html/i.test(page.body), page.status + ' len=' + page.body.length);
  } finally { s.child.kill(); }
}

console.log('');
console.log(failures === 0 ? 'ALL LAN ACCEPTANCE PASSED' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);