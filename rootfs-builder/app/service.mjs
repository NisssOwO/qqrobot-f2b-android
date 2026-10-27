import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { atomicJson } from './src/gateway/text-bridge.mjs';
import { selectedData, selectData } from './src/data-selection.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const roleIds = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources/roles.json'), 'utf8')).map(role => role.id);
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export class BoundedLog {
  constructor(file, { bytes = 1048576, files = 3 } = {}) {
    if (!Number.isInteger(bytes) || bytes < 128 || !Number.isInteger(files) || files < 1 || files > 10) throw new TypeError('Invalid log limit');
    this.file = file; this.bytes = bytes; this.files = files;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  write(chunk) {
    const data = Buffer.from(chunk).subarray(-this.bytes);
    const size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
    if (size + data.length > this.bytes) {
      for (let i = this.files - 1; i >= 1; i--) {
        const source = i === 1 ? this.file : this.file + '.' + (i - 1);
        const target = this.file + '.' + i;
        if (fs.existsSync(target)) fs.unlinkSync(target);
        if (fs.existsSync(source)) fs.renameSync(source, target);
      }
      if (this.files === 1 && fs.existsSync(this.file)) fs.unlinkSync(this.file);
    }
    fs.appendFileSync(this.file, data, { mode: 0o600 });
  }
}

// Trusted process supervisor; only the child loads the outbound network guard.
// Defaults always run the existing signature-gated application, never a QQ login.
export async function createSupervisor({ dataDir = path.join(ROOT, 'data'), controlPort = 38122,
  command = [process.execPath, '--require', path.join(ROOT, 'network-guard.cjs'), path.join(ROOT, 'server.mjs')],
  maxRestarts = 5, windowMs = 600000, baseDelayMs = 2000, maxDelayMs = 60000, stopGraceMs = 5000, logBytes = 1048576 } = {}) {
  dataDir = path.resolve(dataDir);
  const dir = path.join(dataDir, '.runtime'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const controlFile = path.join(dir, 'control.json'), statusFile = path.join(dir, 'status.json');
  const token = randomBytes(32).toString('hex'), instanceId = randomBytes(16).toString('hex');
  const log = new BoundedLog(path.join(dir, 'service.log'), { bytes: logBytes });
  let child = null, restartTimer = null, stopping = false, restarting = false, stopPromise, phase = 'starting', lastExit = null, launches = 0, nextStartAt = null, storageFault = false, activeDataId = null;
  const restartTimes = []; let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const status = () => ({ instanceId, supervisorPid: process.pid, childPid: child?.pid ?? null, phase, launches,
    restartsInWindow: restartTimes.length, maxRestarts, lastExit, nextStartAt, storageFault, activeDataId, realGateway: 'disabled-signature-unverified' });
  function persist() {
    try { atomicJson(statusFile, status()); }
    catch {
      storageFault = true; phase = 'halted-storage'; clearTimeout(restartTimer); restartTimer = null; nextStartAt = null;
      child?.kill('SIGTERM'); // Only this process's own ChildProcess handle.
      console.error('SERVICE_STATUS_WRITE_FAILED: stopped recovery; inspect private storage');
    }
  }
  function writeLog(chunk) {
    try { log.write(chunk); }
    catch { storageFault = true; phase = 'halted-storage'; child?.kill('SIGTERM'); clearTimeout(restartTimer); restartTimer = null; nextStartAt = null; persist(); }
  }
  function exited(code, signal) {
    child = null; lastExit = { code: Number.isInteger(code) ? code : null, signal: typeof signal === 'string' ? signal : null, at: Date.now() };
    if (stopping || restarting || storageFault) { persist(); return; }
    const now = Date.now(); while (restartTimes.length && restartTimes[0] < now - windowMs) restartTimes.shift();
    if (restartTimes.length >= maxRestarts) { phase = 'halted-restart-limit'; nextStartAt = null; persist(); return; }
    const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** restartTimes.length);
    restartTimes.push(now); phase = 'waiting-restart'; nextStartAt = now + delay; persist();
    if (storageFault) return;
    restartTimer = setTimeout(() => { restartTimer = null; nextStartAt = null; launch(); }, delay);
  }
  function launch() {
    if (stopping || storageFault) return;
    let selected;
    try { selected = selectedData(dataDir, { roleIds }); }
    catch { phase = 'halted-data-selection'; nextStartAt = null; persist(); return; }
    activeDataId = selected.id;
    phase = 'running'; launches++;
    const processHandle = spawn(command[0], command.slice(1), { cwd: ROOT, env: { ...process.env, QQROBOT_DATA_DIR: selected.dataDir, QQROBOT_SERVICE_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child = processHandle;
    processHandle.stdout.on('data', writeLog); processHandle.stderr.on('data', writeLog);
    let ended = false;
    const finish = (code, signal) => { if (ended) return; ended = true; exited(code, signal); };
    processHandle.once('error', () => finish(null, 'spawn-error'));
    processHandle.once('exit', finish); persist();
  }
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
    if (req.headers.host !== `127.0.0.1:${server.address().port}`) { res.writeHead(403); res.end('{"error":"host"}'); return; }
    if (req.method === 'GET' && req.url === '/status') { res.end(JSON.stringify(status())); return; }
    if (req.method === 'POST' && ['/stop', '/restart'].includes(req.url) && equal(req.headers['x-service-token'], token) && req.headers['x-service-instance'] === instanceId) {
      if (req.url === '/restart' && (stopping || restarting || storageFault)) { res.writeHead(409); res.end('{"error":"busy"}'); return; }
      res.end('{"accepted":true}');
      if (req.url === '/stop') stop().catch(() => {});
      else {
        restarting = true; phase = 'restarting'; clearTimeout(restartTimer); restartTimer = null; nextStartAt = null; persist();
        setTimeout(() => restart().catch(() => { restarting = false; phase = 'halted-restart-error'; persist(); }), 100);
      }
      return;
    }
    res.writeHead(403); res.end('{"error":"unauthorized"}');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(controlPort, '127.0.0.1', resolve); });
  try { atomicJson(controlFile, { version: 1, instanceId, token, port: server.address().port }); }
  catch (error) { await new Promise(resolve => server.close(resolve)); throw new Error('Cannot save private service control file'); }
  async function stopChild() {
    const processHandle = child;
    if (processHandle && processHandle.exitCode === null && processHandle.signalCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => { processHandle.kill('SIGKILL'); }, stopGraceMs);
        processHandle.once('exit', () => { clearTimeout(timer); resolve(); });
        processHandle.kill('SIGTERM');
      });
    }
  }
  async function restart() {
    await stopChild(); restarting = false;
    if (!stopping && !storageFault) launch();
  }
  async function stop() {
    if (stopPromise) return stopPromise;
    stopping = true; phase = 'stopping'; clearTimeout(restartTimer); restartTimer = null; nextStartAt = null;
    stopPromise = (async () => {
      await stopChild();
      phase = 'stopped'; persist();
      await new Promise(resolve => server.close(resolve));
      try { if (JSON.parse(fs.readFileSync(controlFile)).instanceId === instanceId) fs.unlinkSync(controlFile); } catch {}
      resolveClosed();
    })();
    return stopPromise;
  }
  launch();
  return { status, stop, closed, port: server.address().port, instanceId };
}

export async function serviceCommand(action, dataDir = path.join(ROOT, 'data')) {
  if (!['status', 'stop', 'restart'].includes(action)) throw new Error('Unknown service action');
  const file = path.join(path.resolve(dataDir), '.runtime/control.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Number.isInteger(cfg.port) || cfg.port < 1024 || cfg.port > 65535 || !/^[a-f0-9]{64}$/.test(cfg.token) || !/^[a-f0-9]{32}$/.test(cfg.instanceId)) throw new Error('Invalid private control file');
  const res = await fetch(`http://127.0.0.1:${cfg.port}/${action}`, {
    method: action === 'status' ? 'GET' : 'POST', headers: { 'x-service-token': cfg.token, 'x-service-instance': cfg.instanceId }, signal: AbortSignal.timeout(3000), redirect: 'error'
  });
  if (!res.ok) throw new Error('Service identity check failed');
  const value = await res.json();
  if (action === 'status' && value.instanceId !== cfg.instanceId) throw new Error('Service instance changed');
  return value;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2] || 'run';
  try {
    if (action === 'run') {
      const app = await createSupervisor({ dataDir: process.env.QQROBOT_DATA_DIR });
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { app.stop().catch(() => { process.exitCode = 1; }); });
      console.log('MANAGED_SERVICE_READY control=127.0.0.1:' + app.port);
      await app.closed;
    } else if (['status', 'stop', 'restart'].includes(action)) console.log(JSON.stringify(await serviceCommand(action, process.env.QQROBOT_DATA_DIR)));
    else if (action === 'select') console.log(JSON.stringify(selectData(process.env.QQROBOT_DATA_DIR || path.join(ROOT, 'data'), process.argv[3], { roleIds })));
    else throw new Error('Use run, status, stop, restart or select <original|restore-id>');
  } catch { console.error('SERVICE_COMMAND_FAILED: check service state, port and private storage'); process.exitCode = 1; }
}
