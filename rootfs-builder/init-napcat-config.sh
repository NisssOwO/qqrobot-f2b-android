#!/bin/bash
# 首启/每次启动: 生成 NapCat 与后端的运行时配置（幂等）
#
# 原则:
#   - 镜像不含任何凭据；WebUI token / OneBot token 首启随机生成，写在 $DATA 持久卷
#   - 会让容器重建后"重新扫码"的所有状态（QQ 自身数据、NapCat 账号配置）都在 $DATA 里
set -eu

NAP_BASE="/root/Napcat/opt/QQ/resources/app/app_launcher/napcat"
NAP_CONFIG="${NAP_BASE}/config"
DATA="${QQROBOT_DATA_DIR:-/data}"
QQ_ACCOUNT="${QQ_ACCOUNT:-3836367204}"
GROUP_ALLOW="${GROUP_ALLOW:-620765931}"

mkdir -p "${DATA}" "${DATA}/napcat-config"

# 0) NapCat 配置目录 → 数据卷
if [ -L "${NAP_CONFIG}" ]; then
  :
elif [ -d "${NAP_CONFIG}" ]; then
  if [ -z "$(ls -A "${DATA}/napcat-config" 2>/dev/null)" ]; then
    cp -a "${NAP_CONFIG}/." "${DATA}/napcat-config/" 2>/dev/null || true
  fi
  rm -rf "${NAP_CONFIG}"
  ln -s "${DATA}/napcat-config" "${NAP_CONFIG}"
  echo "linked napcat config -> ${DATA}/napcat-config"
else
  mkdir -p "${DATA}/napcat-config"
  ln -s "${DATA}/napcat-config" "${NAP_CONFIG}"
  echo "linked napcat config -> ${DATA}/napcat-config (created)"
fi

# 1) QQ 客户端自身数据（登录态/缓存）→ 数据卷，否则 docker rm 后要重新扫码
QQ_USER_DATA="${DATA}/qq-user-data"
mkdir -p "${QQ_USER_DATA}" /root/.config
if [ -d /root/.config/QQ ] && [ ! -L /root/.config/QQ ]; then
  if [ -z "$(ls -A "${QQ_USER_DATA}" 2>/dev/null)" ]; then
    cp -a /root/.config/QQ/. "${QQ_USER_DATA}/" 2>/dev/null || true
  fi
  rm -rf /root/.config/QQ
fi
[ -L /root/.config/QQ ] || ln -s "${QQ_USER_DATA}" /root/.config/QQ
echo "linked QQ user data -> ${QQ_USER_DATA}"

# 2) OneBot 握手 token：与后端 config.json 保持一致
#    优先级: 已有 config.json 的 gateway.token > token 文件 > 新生成
TOKEN_FILE="${DATA}/onebot-token.txt"
ONEBOT_TOKEN=""
if [ -f "${DATA}/config.json" ]; then
  ONEBOT_TOKEN="$(jq -r '.gateway.token // empty' "${DATA}/config.json" 2>/dev/null | head -1)"
fi
if [ -z "$ONEBOT_TOKEN" ] && [ -f "${TOKEN_FILE}" ]; then
  ONEBOT_TOKEN="$(cat "${TOKEN_FILE}")"
fi
if [ -z "$ONEBOT_TOKEN" ]; then
  ONEBOT_TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  echo "generated new onebot token"
fi
printf '%s' "$ONEBOT_TOKEN" > "${TOKEN_FILE}"
chmod 600 "${TOKEN_FILE}"

# 3) NapCat WebUI 配置（随机 token）
if [ ! -f "${NAP_CONFIG}/webui.json" ]; then
  WEBUI_TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  cat > "${NAP_CONFIG}/webui.json" <<EOF
{
  "host": "::",
  "port": 6099,
  "token": "${WEBUI_TOKEN}",
  "loginRate": 10,
  "autoLoginAccount": "${QQ_ACCOUNT}"
}
EOF
  echo "generated webui.json"
fi

# 4) NapCat 全局配置
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

# 5) OneBot11 正向 WS 127.0.0.1:3001
#    字段必须是 NapCat 认识的那一组；多一个未知字段/缺 path 都会让 3001 起不来（真机踩过）。
#    token 缺省时 NapCat 放行无认证连接，但后端 runtime 要求 8-512 个可打印 ASCII，所以必须显式给。
ONEBOT_CFG="${NAP_CONFIG}/onebot11_${QQ_ACCOUNT}.json"
cat > "${ONEBOT_CFG}" <<EOF
{
  "network": {
    "httpServers": [],
    "httpSseServers": [],
    "httpClients": [],
    "websocketServers": [
      {
        "name": "qqrobot-ws",
        "enable": true,
        "host": "127.0.0.1",
        "port": 3001,
        "path": "",
        "messagePostFormat": "array",
        "reportSelfMessage": false,
        "token": "${ONEBOT_TOKEN}",
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
echo "wrote $(basename "${ONEBOT_CFG}") (ws 127.0.0.1:3001)"

# 6) 后端 config.json（以 config.example.json 为模板，注入账号与网关）
if [ ! -f "${DATA}/config.json" ]; then
  jq --arg qq "$QQ_ACCOUNT" --arg group "$GROUP_ALLOW" --arg token "$ONEBOT_TOKEN" '
    .policy.selfId = $qq
    | .policy.ownerId = $qq
    | .policy.allow = { "private": [], "group": [$group] }
    | .policy.defaultRole = "hinana"
    | .policy.requireGroupMention = true
    | .gateway = {
        "type": "onebot",
        "enabled": true,
        "url": "ws://127.0.0.1:3001/",
        "token": $token,
        "selfId": $qq
      }
  ' /root/qqrobot-app/config.example.json > "${DATA}/config.json"
  echo "generated ${DATA}/config.json (selfId=${QQ_ACCOUNT}, group=${GROUP_ALLOW})"
fi

echo "== INIT_NAPCAT_CONFIG_DONE =="