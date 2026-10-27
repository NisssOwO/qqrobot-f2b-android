import { createApplication } from './runtime.mjs';

const port = Number(process.env.QQROBOT_PORT || process.env.PANEL_PORT || 38121);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');

// Bind address: 127.0.0.1 (default, host-only) or 0.0.0.0 (LAN). The control
// port (38122) always stays on loopback — only the panel is exposed.
const bind = process.env.QQROBOT_BIND || process.env.PANEL_BIND || '127.0.0.1';
if (!['127.0.0.1', '0.0.0.0'].includes(bind)) throw new Error('QQROBOT_BIND must be 127.0.0.1 or 0.0.0.0');

// LAN login: when bound beyond loopback, a password is mandatory so that
// anyone on the LAN cannot silently drive the bot.
const password = process.env.QQROBOT_PASSWORD || process.env.PANEL_PASSWORD || '';
if (bind === '0.0.0.0' && !password) throw new Error('QQROBOT_BIND=0.0.0.0 requires QQROBOT_PASSWORD');

// The network guard blocks non-loopback *listening* by default. Exposing the
// admin panel on the LAN is a deliberate opt-in, so unlock exactly that case
// (outbound connections/DNS/UDP stay blocked while the guard is loaded).
if (bind === '0.0.0.0') process.env.QQROBOT_ALLOW_LAN_LISTEN = '1';

const app = await createApplication({
  port,
  bind,
  password,
  dataDir: process.env.QQROBOT_DATA_DIR,
  serviceDataDir: process.env.QQROBOT_SERVICE_DATA_DIR,
});
console.log('E_TEXT_WEBUI_READY ' + app.origin + ' — QQ disconnected, local fixture model');
console.log('E_TEXT_WEBUI_BIND ' + bind + ':' + port + (password ? ' (password required)' : ''));
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { if (closing) return; closing = true; await app.close(); process.exit(0); });