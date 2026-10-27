#!/data/data/com.termux/files/usr/bin/bash
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
export QQROBOT_DATA_DIR="${QQROBOT_DATA_DIR:-$PWD/data}"
exec node --require ./network-guard.cjs ./server.mjs
