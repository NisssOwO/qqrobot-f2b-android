#!/bin/bash
# 首启/每次启动: 生成 NapCat 与后端的运行时配置（幂等; 存在即跳过）
# 原则: 镜像不含任何凭据; token 一律首次随机生成, 写进 $DATA 持久目录
set -eu
NAP_BASE="/root/Napcat/opt/QQ/resources/app/app_launcher/napcat"
NAP_CONFIG="${NAP_BASE}/config"
DATA="${QQROBOT_DATA_DIR:-/root/qqrobot-data}"

mkdir -p "${NAP_CONFIG}" "${DATA}"

# 1) NapCat WebUI token（随机, 只有本机知道; webui.json 结构照真机, 主题默认即可）
if [ ! -f "${NAP_CONFIG}/webui.json" ]; then
  TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  cat > "${NAP_CONFIG}/webui.json" <<EOF
{
  "host": "::",
  "port": 6099,
  "token": "${TOKEN}",
  "loginRate": 10,
  "autoLoginAccount": ""
}
EOF
  echo "generated webui.json (new random token)"
fi

# 2) NapCat 全局配置（无凭据, 照真机 napcat.json; napcat_<qq>.json 登录后由 NapCat 生成）
if [ ! -f "${NAP_CONFIG}/napcat.json" ]; then
  cat > "${NAP_CONFIG}/napcat.json" <<'EOF'
{
  "fileLog": false,
  "consoleLog": true,
  "fileLogLevel": "debug",
  "consoleLogLevel": "info",
  "packetBackend": "auto",
  "packetServer": "",
  "o3HookMode": 1,
  "bypass": {
    "hook": false,
    "window": false,
    "module": false,
    "process": false,
    "container": false,
    "js": false
  }
}
EOF
  echo "generated napcat.json"
fi

# 3) OneBot v11 正向 WS 127.0.0.1:3001 (loopback, 无 token; 与归档 onebot11_*.json 一致)
if [ ! -d "${NAP_CONFIG}/onebot11_3836367204.json" ] && [ ! -f "${NAP_CONFIG}/onebot11_3836367204.json" ]; then
  cat > "${NAP_CONFIG}/onebot11_3836367204.json" <<'EOF'
{
  "network": {
    "httpServers": [],
    "httpSseServers": [],
    "httpClients": [],
    "websocketServers": [
      {
        "name": "ws-local",
        "enable": true,
        "host": "127.0.0.1",
        "port": 3001,
        "path": "",
        "messagePostFormat": "array",
        "reportSelfMessage": false,
        "token": "",
        "debug": false,
        "heartInterval": 10000
      }
    ],
    "websocketClients": [],
    "plugins": []
  },
  "musicSignUrl": "",
  "enableLocalFile2Url": false,
  "parseMultMsg": false,
  "imageDownloadProxy": "",
  "timeout": {
    "baseTimeout": 10000,
    "uploadSpeedKBps": 256,
    "downloadSpeedKBps": 256,
    "maxTimeout": 1800000
  }
}
EOF
  echo "generated onebot11_3836367204.json"
fi

# 4) 后端 config.json: 以 config.example.json 为模板, 注入本机账号与网关
if [ ! -f "${DATA}/config.json" ]; then
  QQ_ACCOUNT="${QQ_ACCOUNT:-3836367204}"
  GROUP_ALLOW="${GROUP_ALLOW:-620765931}"
  python3 - "${QQ_ACCOUNT}" "${GROUP_ALLOW}" "${DATA}" /root/qqrobot-app/config.example.json <<'PY'
import json, os, sys
qq, group, data_dir, example = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
cfg = json.load(open(example, encoding='utf-8'))
cfg['policy']['selfId'] = qq
cfg['policy']['ownerId'] = qq
cfg['policy']['allow'] = {'private': [], 'group': [group]}
cfg['policy']['defaultRole'] = 'hinana'
cfg['policy']['requireGroupMention'] = True
# 网关段必须显式存在（runtime.mjs gatewayConfig）: 本机正向 WS, token 仅本地握手常量
cfg['gateway'] = {
    'type': 'onebot',
    'enabled': True,
    'url': 'ws://127.0.0.1:3001/',
    'token': 'napcat-local-token-only-0001',
    'selfId': qq,
}
os.makedirs(data_dir, exist_ok=True)
with open(os.path.join(data_dir, 'config.json'), 'w', encoding='utf-8') as f:
    json.dump(cfg, f, ensure_ascii=False, indent=2)
PY
  echo "generated ${DATA}/config.json (selfId=${QQ_ACCOUNT})"
fi

echo "== INIT_NAPCAT_CONFIG_DONE =="