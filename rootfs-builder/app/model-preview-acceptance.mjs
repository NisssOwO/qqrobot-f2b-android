import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApplication, ROOT } from './runtime.mjs';
import { createConversation } from './src/conversation.mjs';
import { createModelPreview, validateModelConfig } from './src/model-preview.mjs';

const sample = { baseUrl: 'https://model.example.invalid/compatible-mode/v1', model: 'owner-selected-model', apiKey: 'synthetic-owner-model-key-7391' };
export async function runModelPreviewAcceptance({ check, makeDir }) {
  await check('model-config-validation-key-reuse-and-address-change-protection', () => {
    const saved = validateModelConfig(sample);
    assert.equal(validateModelConfig({ ...sample, apiKey: '' }, saved).apiKey, sample.apiKey);
    for (const baseUrl of ['http://example.invalid/v1', 'https://127.0.0.1/v1', 'https://example.local/v1', 'https://a:b@example.invalid/v1', 'https://example.invalid/v1?key=secret', 'https://example.invalid:8443/v1']) assert.throws(() => validateModelConfig({ ...sample, baseUrl }));
    assert.throws(() => validateModelConfig({ ...sample, baseUrl: 'https://other.example.invalid/v1', apiKey: '' }, saved));
  });
  await check('model-preview-explicit-request-busy-failure-redaction-and-private-file', async () => {
    const dataDir = makeDir('model-service'); let created = 0, release;
    const service = createModelPreview({ root: ROOT, dataDir, roleIds: ['hinana'], chatFactory: () => {
      created++; return { reply: () => new Promise(resolve => { release = resolve; }), close: async () => {} };
    } });
    try {
      await service.configure(sample); assert.equal(created, 0);
      assert.ok(!JSON.stringify(service.status()).includes(sample.apiKey));
      if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dataDir, 'model-config.json')).mode & 0o777, 0o600);
      const pending = service.reply({ role: 'hinana', text: 'hello' });
      await assert.rejects(service.reply({ role: 'hinana', text: 'duplicate' }));
      await assert.rejects(service.configure(sample)); await assert.rejects(service.clear());
      release('ordinary reply'); assert.equal((await pending).qqSent, false); assert.equal(created, 1);
      const leaking = service.reply({ role: 'hinana', text: 'another' });
      const blocked = assert.rejects(leaking, error => !error.message.includes(sample.apiKey));
      release(sample.apiKey); await blocked;
      await service.clear(); assert.equal(service.status().configured, false);
      assert.equal(fs.existsSync(path.join(dataDir, 'model-config.json')), false);
      const once = service.testOnce({ ...sample, role: 'hinana', text: 'single local test' });
      release('once response'); const onceReply = await once;
      assert.equal(onceReply.keySaved, false); assert.equal(onceReply.qqSent, false);
      assert.equal(service.status().configured, false);
      assert.equal(fs.existsSync(path.join(dataDir, 'model-config.json')), false);
      assert.equal(fs.readdirSync(dataDir).some(name => name.startsWith('model-once-')), false);
    } finally { await service.close(); }
  });
  await check('model-preview-http-auth-real-backend-context-restart-and-no-qq-outbox', async () => {
    let app, token, factoryCalls = 0;
    const dataDir = makeDir('model-preview-http');
    const factory = options => {
      factoryCalls++; assert.equal(options.apiKey, sample.apiKey);
      // Test-only redirection to the authenticated loopback model fixture.
      return createConversation({ ...options, baseUrl: app.origin + '/fixture/v1', apiKey: token });
    };
    const start = async () => {
      app = await createApplication({ dataDir, previewChatFactory: factory });
      token = (await (await fetch(app.origin)).text()).match(/const token='([a-f0-9]+)'/)[1];
    };
    const post = (route, value) => fetch(app.origin + route, { method: 'POST', headers: { 'x-lab-token': token, 'content-type': 'application/json' }, body: JSON.stringify(value) });
    try {
      await start();
      assert.equal((await fetch(app.origin + '/api/model/config', { method: 'POST', body: JSON.stringify(sample) })).status, 403);
      assert.equal((await post('/api/model/config', sample)).status, 200); assert.equal(factoryCalls, 0);
      assert.ok(!JSON.stringify(app.status()).includes(sample.apiKey));
      for (const text of ['FIRST-preview-memory', 'second']) {
        const response = await post('/api/model/chat', { role: 'hinana', text }); assert.equal(response.status, 200);
        assert.equal((await response.json()).qqSent, false);
      }
      assert.equal(app.modelRequests.at(-1).model, sample.model); assert.equal(app.modelRequests.at(-1).tools, undefined);
      assert.equal(app.status().outbox.length, 0); assert.equal(app.status().conversation.sessions, 0);
      await app.close(); app = null; const before = factoryCalls; await start();
      assert.equal(app.status().modelPreview.keyPresent, true); assert.equal(factoryCalls, before);
      const restored = await (await post('/api/model/chat', { role: 'hinana', text: 'restart' })).json();
      assert.match(restored.reply, /第3轮/); assert.match(restored.reply, /FIRST-preview-memory/);
      assert.equal((await post('/api/model/clear', {})).status, 200);
      assert.equal(app.status().modelPreview.keyPresent, false);
      assert.equal((await post('/api/model/chat', { role: 'hinana', text: 'no config' })).status, 400);
      const countBefore = app.modelRequests.length;
      const once = await (await post('/api/model/once', { ...sample, role: 'hinana', text: 'one-shot preview' })).json();
      assert.equal(once.keySaved, false); assert.match(once.reply, /第1轮/);
      assert.equal(app.modelRequests.length, countBefore + 1);
      assert.equal(app.status().modelPreview.configured, false);
    } finally { await app?.close(); }
  });
}
