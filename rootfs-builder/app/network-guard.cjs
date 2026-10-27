'use strict';
// Prevent accidental outbound use of common Node APIs during this probe.
// This is not an OS firewall or a security sandbox for untrusted code.
const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');
const dgram = require('node:dgram');
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const state = { blocked: [], loopbackConnects: 0, modelConnects: 0, explicitModelFetches: 0 };
globalThis[Symbol.for('qqrobot.termux.c.guard')] = state;
const loopback = host => ['127.0.0.1', '::1', '[::1]'].includes(String(host));
let modelEndpoint = null;
// Trusted application opt-in only. This guard is still not a security sandbox.
state.setModelEndpoint = baseUrl => {
  if (baseUrl === null) { modelEndpoint = null; return; }
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname) || /(?:^|\.)(?:localhost|local|internal)$/i.test(url.hostname)) throw new Error('Invalid model endpoint');
  modelEndpoint = new URL(url.href.replace(/\/$/, '') + '/chat/completions');
};
const modelHost = host => modelEndpoint && String(host).toLowerCase() === modelEndpoint.hostname;
// Inbound LAN binding is an explicit product opt-in (the admin panel). It is
// never implied: the caller must set QQROBOT_ALLOW_LAN_LISTEN=1, which only the
// panel process does when QQROBOT_BIND=0.0.0.0. Outbound traffic stays
// restricted to loopback by the wrappers below.
const lanListen = () => process.env.QQROBOT_ALLOW_LAN_LISTEN === '1';
const wildcardLiteral = host => ['0.0.0.0', '::', '::0'].includes(String(host));
function deny(kind, target) {
  state.blocked.push({ kind, target: String(target) });
  const error = new Error(`C_NETWORK_GUARD: ${kind} ${target}`);
  error.code = 'C_NETWORK_GUARD';
  throw error;
}
function connectionTarget(args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  if (first && typeof first === 'object') {
    if (first.path) return { host: 'unix-socket' };
    return { host: first.host ?? first.hostname ?? 'localhost', port: first.port };
  }
  return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: first };
}
for (const [object, method] of [[net, 'connect'], [net, 'createConnection'], [net.Socket.prototype, 'connect'], [tls, 'connect']]) {
  const original = object[method];
  object[method] = function (...args) {
    const { host, port } = connectionTarget(args);
    if (!loopback(host) && !(modelHost(host) && Number(port) === 443)) return deny(method, host);
    if (loopback(host)) state.loopbackConnects++; else state.modelConnects++;
    return Reflect.apply(original, this, args);
  };
}
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const first = args[0];
  const host = typeof first === 'object' ? first.host : args[1];
  // Inbound LAN binding is an explicit product opt-in (the admin panel). It is
  // never implied: the caller must set QQROBOT_ALLOW_LAN_LISTEN=1, which only
  // the panel process does when QQROBOT_BIND=0.0.0.0. Outbound traffic is still
  // restricted to loopback by the wrappers above.
  const lanBind = lanListen() && wildcardLiteral(host);
  if (!loopback(host) && !lanBind) return deny('listen', host ?? 'unspecified');
  return Reflect.apply(listen, this, args);
};
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = function (input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!loopback(url.hostname)) {
    if (!modelEndpoint || url.href !== modelEndpoint.href || String(init?.method ?? 'GET').toUpperCase() !== 'POST') return deny('fetch', url.hostname);
    state.explicitModelFetches++;
    return originalFetch(input, { ...init, redirect: 'error' });
  }
  return originalFetch(input, init);
};
for (const method of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny']) {
  const original = dns[method];
  dns[method] = function (host, ...args) {
    // net.Server.listen() resolves a wildcard bind address through dns.lookup;
    // that is not an outbound query, so allow it only with the LAN opt-in.
    if (!loopback(host) && !modelHost(host) && !(lanListen() && wildcardLiteral(host))) return deny(`dns.${method}`, host);
    return Reflect.apply(original, this, [host, ...args]);
  };
  const promiseOriginal = dns.promises[method];
  if (promiseOriginal) dns.promises[method] = function (host, ...args) {
    if (!loopback(host) && !modelHost(host) && !(lanListen() && wildcardLiteral(host))) return Promise.reject(new Error('C_NETWORK_GUARD: DNS disabled'));
    return Reflect.apply(promiseOriginal, this, [host, ...args]);
  };
}
dgram.createSocket = () => deny('udp', 'disabled');
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[method] = () => deny('child-process', method);
}
syncBuiltinESMExports();
