// Verifies that the QQ reply path follows the model configured in the panel and
// falls back to the built-in fixture when nothing is configured.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
await import('./network-guard.cjs');
const { createApplication } = await import('./runtime.mjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-model-'));
let sequence = 0;
const input = (change = {}) => { const id = String(++sequence); return { scene: 'private', peerId: '10001', senderId: '10001', sequence: id, messageUid: id, text: '测试文字', ...change }; };

const fake = { calls: [], closed: 0, reply: async event => { fake.calls.push(event.text); return 'REAL-MODEL-REPLY'; }, close: async () => { fake.closed++; } };
const app = await createApplication({ dataDir: dir, previewChatFactory: () => fake });
try {
  const page = await (await fetch(app.origin)).text();
  const token = page.match(/const token='([a-f0-9]+)'/)[1];
  const headers = { 'content-type': 'application/json', 'x-lab-token': token };
  const base = { baseUrl: 'https://model.example.invalid/compatible-mode/v1', model: 'owner-selected-model', apiKey: 'synthetic-owner-model-key-7391' };

  // 1. Nothing configured: the built-in fixture answers, the real model is untouched.
  assert.equal((await app.receiveFixture(input({ text: '未配置时' }))).accepted, true);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(fake.calls.length, 0, 'fixture must answer before a model is configured');

  // 2. Configure a model: the reply path switches over immediately.
  const configured = await fetch(app.origin + '/api/model/config', { method: 'POST', headers, body: JSON.stringify(base) });
  assert.equal(configured.status, 200);
  assert.equal(fake.closed, 0, 'the fixture chat is kept for fallback');
  assert.equal((await app.receiveFixture(input({ text: '配置后' }))).accepted, true);
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(fake.calls.length, 1, 'the configured model must answer QQ replies');
  assert.equal(fake.calls[0], '配置后');

  // 3. Clearing the model puts the fixture back.
  assert.equal((await fetch(app.origin + '/api/model/clear', { method: 'POST', headers })).status, 200);
  assert.equal(fake.closed, 1, 'the switched chat must be closed on clear');
  assert.equal((await app.receiveFixture(input({ text: '清除后' }))).accepted, true);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(fake.calls.length, 1, 'the fixture must answer again after clearing');

  // 4. The status still redacts the key and reports the panel scope.
  assert.ok(!JSON.stringify(app.status()).includes(base.apiKey));
  console.log('ALL REPLY-MODEL ACCEPTANCE PASSED');
} finally {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
}