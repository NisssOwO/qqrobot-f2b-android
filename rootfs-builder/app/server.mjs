import { createApplication } from './runtime.mjs';
const port = Number(process.env.QQROBOT_PORT || 38121);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
const app = await createApplication({ port, dataDir: process.env.QQROBOT_DATA_DIR, serviceDataDir: process.env.QQROBOT_SERVICE_DATA_DIR });
console.log('E_TEXT_WEBUI_READY ' + app.origin + ' — QQ disconnected, local fixture model');
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { if (closing) return; closing = true; await app.close(); process.exit(0); });
