'use strict';
// Separate process: replace underlying transports before loading the guard.
// The entire policy check is offline, including the permitted-host case.
const assert = require('node:assert/strict');
const net = require('node:net');
const tls = require('node:tls');
let connections = 0, fetches = 0;
net.createConnection = () => { connections++; return 'controlled-socket'; };
tls.connect = () => { connections++; return 'controlled-tls'; };
globalThis.fetch = async (url, init) => { fetches++; return { url, method: init.method, redirect: init.redirect }; };
require('./network-guard.cjs');
const guard = globalThis[Symbol.for('qqrobot.termux.c.guard')];
(async () => {
  const endpoint = 'https://api.example.invalid/v1';
  assert.throws(() => fetch(endpoint + '/chat/completions', { method: 'POST' }), /NETWORK_GUARD/);
  guard.setModelEndpoint(endpoint);
  const response = await fetch(endpoint + '/chat/completions', { method: 'POST', redirect: 'follow' });
  assert.equal(response.redirect, 'error'); assert.equal(fetches, 1);
  for (const url of [endpoint + '/models', 'https://other.example.invalid/v1/chat/completions', endpoint + '/chat/completions?key=x']) assert.throws(() => fetch(url, { method: 'POST' }), /NETWORK_GUARD/);
  assert.throws(() => fetch(endpoint + '/chat/completions'), /NETWORK_GUARD/);
  assert.equal(net.createConnection({ host: 'api.example.invalid', port: 443 }), 'controlled-socket');
  assert.equal(tls.connect({ host: 'api.example.invalid', port: 443 }), 'controlled-tls');
  assert.equal(connections, 2);
  assert.throws(() => net.createConnection({ host: 'api.example.invalid', port: 80 }), /NETWORK_GUARD/);
  assert.throws(() => tls.connect({ host: 'qq.example.invalid', port: 443 }), /NETWORK_GUARD/);
  for (const url of ['http://api.example.invalid/v1', 'https://api.example.invalid:8443/v1', 'https://localhost/v1', 'https://127.0.0.1/v1']) assert.throws(() => guard.setModelEndpoint(url));
  guard.setModelEndpoint(null);
  assert.throws(() => fetch(endpoint + '/chat/completions', { method: 'POST' }), /NETWORK_GUARD/);
  assert.equal(fetches, 1); assert.equal(connections, 2);
  console.log(JSON.stringify({ ok: true, realNetworkCalls: 0, policy: 'default-loopback; explicit-model-host:443; exact POST path; redirects rejected; revoke supported' }));
})().catch(error => { console.error(error); process.exitCode = 1; });
