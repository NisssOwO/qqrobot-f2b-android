import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSupervisor, serviceCommand, BoundedLog } from './service.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const temp = fs.mkdtempSync(path.join(root, 'service-test-'));
const active = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 8000) {
  const limit = Date.now() + timeout;
  while (Date.now() < limit) { if (await fn()) return; await sleep(20); }
  throw new Error('Timed out waiting for controlled service state');
}
const start = async options => { const app = await createSupervisor({ controlPort: 0, baseDelayMs: 20, maxDelayMs: 40, stopGraceMs: 300, ...options }); active.add(app); return app; };
const checks = [];
try {
  const logDir = path.join(temp, 'logs'); const logFile = path.join(logDir, 'service.log');
  const log = new BoundedLog(logFile, { bytes: 1024, files: 3 });
  for (let i = 0; i < 10; i++) log.write('x'.repeat(i === 0 ? 6000 : 800));
  const logs = fs.readdirSync(logDir); assert.ok(logs.length <= 3);
  assert.ok(logs.every(name => fs.statSync(path.join(logDir, name)).size <= 1024));
  checks.push('log chunks and retained rotations bounded');

  const crashFixture = path.join(temp, 'crash-fixture.cjs');
  fs.writeFileSync(crashFixture, "console.log('x'.repeat(6000)); process.exit(23);");
  const crashDir = path.join(temp, 'crash-data');
  const crashing = await start({ dataDir: crashDir, command: [process.execPath, crashFixture], maxRestarts: 2, logBytes: 1024 });
  await until(() => crashing.status().phase === 'halted-restart-limit');
  assert.equal(crashing.status().launches, 3); assert.equal(crashing.status().childPid, null);
  const controlBefore = fs.readFileSync(path.join(crashDir, '.runtime/control.json'), 'utf8');
  await assert.rejects(createSupervisor({ dataDir: crashDir, controlPort: crashing.port, command: [process.execPath, crashFixture] }));
  assert.equal(fs.readFileSync(path.join(crashDir, '.runtime/control.json'), 'utf8'), controlBefore);
  checks.push('crash restart limit and duplicate supervisor do not overwrite owner identity');

  const unauthorized = await fetch(`http://127.0.0.1:${crashing.port}/stop`, { method: 'POST' });
  assert.equal(unauthorized.status, 403); assert.equal(crashing.status().phase, 'halted-restart-limit');
  const lookedUp = await serviceCommand('status', crashDir); assert.equal(lookedUp.instanceId, crashing.instanceId);
  assert.ok(!JSON.stringify(lookedUp).includes(JSON.parse(controlBefore).token));
  await serviceCommand('stop', crashDir); await crashing.closed;
  assert.equal(fs.existsSync(path.join(crashDir, '.runtime/control.json')), false);
  checks.push('private control token required; status proves live instance; stopped token removed');

  const runningFixture = path.join(temp, 'running-fixture.cjs');
  fs.writeFileSync(runningFixture, "console.log('fixture ready'); setInterval(()=>{},1000);");
  const runningDir = path.join(temp, 'running-data');
  const running = await start({ dataDir: runningDir, command: [process.execPath, runningFixture] });
  await until(() => running.status().childPid !== null); const pid = running.status().childPid;
  assert.doesNotThrow(() => process.kill(pid, 0)); await running.stop(); await running.closed;
  assert.equal(running.status().phase, 'stopped'); assert.equal(running.status().childPid, null); assert.equal(running.status().launches, 1);
  checks.push('graceful stop kills only the owned child and prevents recovery');

  const missing = await start({ dataDir: path.join(temp, 'missing'), command: [path.join(temp, 'nonexistent-executable')], maxRestarts: 0 });
  await until(() => missing.status().phase === 'halted-restart-limit'); assert.equal(missing.status().launches, 1); await missing.stop();
  checks.push('spawn failure is bounded without unhandled child errors');

  console.log(JSON.stringify({ ok: true, platform: process.platform, uid: process.getuid?.() ?? null, checks, realQqLogin: false, realModelCalls: 0 }, null, 2));
} finally {
  await Promise.allSettled([...active].map(app => app.stop()));
  if (path.dirname(path.resolve(temp)) !== root || !path.basename(temp).startsWith('service-test-')) throw new Error('Unsafe cleanup path');
  fs.rmSync(temp, { recursive: true, force: true });
}
