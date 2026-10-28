// Acceptance for the login panel: state / qrcode / refresh routes.
// Runs the real server on loopback with a fake QR path so nothing depends on a
// container being present.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE = process.env.NODE_BIN || process.execPath;
const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = 38211;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qrlogin-'));
const DATA = path.join(TMP, 'data');
const QR = path.join(TMP, 'qrcode.png');
fs.mkdirSync(DATA, { recursive: true });
// 1x1 PNG so the route serves real image bytes.
fs.writeFileSync(QR, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
}
function get(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'GET', headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const env = { ...process.env, QQROBOT_PORT: String(PORT), QQROBOT_DATA_DIR: DATA, NAPCAT_QR_PATH: QR, QQ_BIN: path.join(TMP, 'qq-nonexistent-binary'), QQROBOT_DEBUG: '1' };
// Piped stdio is unavailable under the Windows harness sandbox, so the child
// writes to a file we tail instead.
const LOG = path.join(TMP, 'server.log');
const logFd = fs.openSync(LOG, 'a');
const child = spawn(NODE, ['--require', './network-guard.cjs', 'server.mjs'], {
  cwd: APP_DIR,
  env,
  stdio: ['ignore', logFd, logFd],
});
const readOut = () => { try { return fs.readFileSync(LOG, 'utf8'); } catch { return ''; } };
let out = '';

const deadline = Date.now() + 20000;
while (Date.now() < deadline && !readOut().includes('E_TEXT_WEBUI_READY')) {
  await new Promise(r => setTimeout(r, 200));
}
out = readOut();

try {
  check('server started', out.includes('E_TEXT_WEBUI_READY'), out.split('\n')[0] || '');

  const state = await get('/api/login/state');
  if (state.status !== 200) console.log('LOG:', readOut().slice(-700));
  const body = JSON.parse(state.body.toString());
  check('GET /api/login/state is 200', state.status === 200, 'status='+state.status+' body='+state.body.toString().slice(0,300));
  check('state reports no QQ process', body.qqAlive === false, JSON.stringify(body.qqAlive));
  check('state reports the QR file age', typeof body.qr?.ageSec === 'number' && body.qr.bytes > 0, JSON.stringify(body.qr));

  const png = await get('/api/login/qrcode.png');
  check('GET /api/login/qrcode.png returns png', png.status === 200 && png.headers['content-type'] === 'image/png');
  check('PNG payload is a real PNG', png.body.subarray(1, 4).toString() === 'PNG');

  const page = await get('/');
  const html = page.body.toString();
  check('page contains the login section', html.includes('登录 QQ') && html.includes('/api/login/qrcode.png'));
  check('page still contains the health section', html.includes('id="health"'));

  // No X-Lab token -> the POST must be refused by the page-credential check.
  const noToken = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/login/refresh', method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end('{}');
  });
  check('POST /api/login/refresh without page token is refused', noToken.status === 403, `status=${noToken.status}`);

  // With the token but no running QQ: 409, not a blind kill.
  const tokenMatch = html.match(/const token='([0-9a-f]+)'/);
  if (tokenMatch) {
    const withToken = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/login/refresh', method: 'POST', headers: { 'content-type': 'application/json', 'x-lab-token': tokenMatch[1] } }, res => {
        const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject); req.end('{}');
    });
    check('POST /api/login/refresh with token and no QQ returns 409', withToken.status === 409, `status=${withToken.status} ${withToken.body.slice(0, 80)}`);

    // Logging out without a running QQ must not touch anything either.
    const logout = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/login/logout', method: 'POST', headers: { 'content-type': 'application/json', 'x-lab-token': tokenMatch[1] } }, res => {
        const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject); req.end('{}');
    });
    check('POST /api/login/logout with no QQ returns 409', logout.status === 409, `status=${logout.status} ${logout.body.slice(0, 80)}`);
  } else {
    check('page token is injected', false, 'token pattern not found');
  }

  // Host guard still applies to the new routes.
  const badHost = await get('/api/login/state', { host: '8.8.8.8:' + PORT });
  check('GET /api/login/state with public Host is 403', badHost.status === 403, `status=${badHost.status}`);
} finally {
  child.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 500));
  try { child.kill('SIGKILL'); } catch {}
  try { fs.closeSync(logFd); } catch {}
  fs.rmSync(TMP, { recursive: true, force: true });
}

const failed = results.filter(r => !r.ok);
console.log(failed.length ? `\nLOGIN ACCEPTANCE FAILED (${failed.length}/${results.length})` : `\nALL LOGIN ACCEPTANCE PASSED (${results.length}/${results.length})`);
process.exit(failed.length ? 1 : 0);