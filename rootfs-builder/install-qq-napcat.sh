#!/bin/bash
# 构建期: 安装 QQ NT (arm64) + 注入 NapCat 载荷
#
# 不走官方 install.sh —— 那条路在 QEMU 构建（arch 判断）和国内镜像站（NapCat 下载）
# 上都踩过坑。这里用真机验证过的两步：
#   1) dpkg -x 直接解 QQ deb 到 /root/Napcat/opt/QQ
#   2) 解压 NapCat.Shell.zip → cp -a 到 app_launcher/napcat → 写 loadNapCat.js → 改 package.json main
#
# 可用环境变量覆盖（CI 里指向自建 Release 资产，绕开国内 CDN）:
#   QQ_DEB_URL     QQ deb 下载地址
#   NAPCAT_URL     NapCat.Shell.zip 下载地址
#   GITHUB_PROXY   非空时给 NAPCAT_URL 加前缀（https://ghproxy.net 形式）
set -euo pipefail

QQ_DEB_URL="${QQ_DEB_URL:-https://qqdl.gtimg.cn/qqfile/QQNT/9.9.36/beta/9ee04bef/linuxqq_3.2.34-53644_arm64.deb}"
NAPCAT_URL="${NAPCAT_URL:-https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip}"
GITHUB_PROXY="${GITHUB_PROXY:-}"

if [ -n "$GITHUB_PROXY" ] && [ "$GITHUB_PROXY" != "0" ]; then
  NAPCAT_URL="${GITHUB_PROXY%/}/${NAPCAT_URL}"
fi

QQ_BASE=/root/Napcat/opt/QQ
WORK=/root/dl
rm -rf "$WORK"
mkdir -p "$WORK" /root/Napcat/opt

download() {  # $1=url  $2=out
  # The Tencent CDN drops long transfers now and then (curl 56). Retry across
  # errors and resume from whatever already landed instead of starting over.
  attempt=1
  while [ "$attempt" -le 6 ]; do
    if curl -fL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 20 \
         --max-time 2400 -C - -o "$2" "$1"; then
      return 0
    fi
    echo "download attempt $attempt failed for $1" >&2
    attempt=$((attempt + 1))
    sleep 5
  done
  echo "giving up on $1" >&2
  return 1
}

echo "==> [1/5] QQ deb: $QQ_DEB_URL"
download "$QQ_DEB_URL" "$WORK/QQ.deb"
ls -l "$WORK/QQ.deb"

echo "==> [2/5] 解包 QQ"
dpkg -x "$WORK/QQ.deb" "$WORK/qqroot"
if [ ! -d "$WORK/qqroot/opt/QQ" ]; then
  echo "FATAL: deb 里没有 opt/QQ"; find "$WORK/qqroot" -maxdepth 3 | head -20; exit 1
fi
mv "$WORK/qqroot/opt/QQ" "$QQ_BASE"

QQ_BIN="$QQ_BASE/qq"
[ -x "$QQ_BIN" ] || { echo "FATAL: $QQ_BIN 缺失或不可执行"; ls -la "$QQ_BASE" | head -20; exit 1; }
MACHINE="$(od -An -tx1 -j18 -N2 "$QQ_BIN" | tr -d ' \n')"
if [ "$MACHINE" != "b700" ]; then
  echo "FATAL: QQ 二进制不是 aarch64 (e_machine=$MACHINE, 期望 b700)"
  exit 1
fi
echo "    QQ ELF e_machine=$MACHINE (arm64 OK)"

echo "==> [3/5] NapCat: $NAPCAT_URL"
download "$NAPCAT_URL" "$WORK/NapCat.Shell.zip"
ls -l "$WORK/NapCat.Shell.zip"

echo "==> [4/5] 解压并注入 NapCat"
mkdir -p "$WORK/napcat"
unzip -q "$WORK/NapCat.Shell.zip" -d "$WORK/napcat"

# zip 内层结构各版本不同：优先认扁平结构（当前版本就是 napcat.mjs 在顶层），
# 否则向下找同时含 package.json 与 napcat.mjs 的那一层
SRC=""
if [ -f "$WORK/napcat/napcat.mjs" ] && [ -f "$WORK/napcat/package.json" ]; then
  SRC="$WORK/napcat"
else
  while IFS= read -r pkg; do
    dir="$(dirname "$pkg")"
    if [ -f "$dir/napcat.mjs" ]; then SRC="$dir"; break; fi
  done < <(find "$WORK/napcat" -maxdepth 3 -name package.json -not -path '*/node_modules/*')
fi
if [ -z "$SRC" ]; then
  echo "FATAL: 在 NapCat.Shell.zip 里找不到 napcat.mjs 所在目录"
  find "$WORK/napcat" -maxdepth 3 | head -40
  exit 1
fi
echo "    载荷目录: $SRC"

LAUNCHER="$QQ_BASE/resources/app/app_launcher"
mkdir -p "$LAUNCHER"
rm -rf "$LAUNCHER/napcat"
cp -a "$SRC" "$LAUNCHER/napcat"

cat > "$QQ_BASE/resources/app/loadNapCat.js" <<'EOF'
const path = require('node:path');
const { pathToFileURL } = require('node:url');
import(pathToFileURL(path.join(__dirname, 'app_launcher/napcat/napcat.mjs')).href);
EOF

jq '.main = "./loadNapCat.js"' "$QQ_BASE/resources/app/package.json" > "$WORK/pkg.json"
mv "$WORK/pkg.json" "$QQ_BASE/resources/app/package.json"
echo "    package.json main = $(jq -r '.main' "$QQ_BASE/resources/app/package.json")"

echo "==> [5/5] 清理"
rm -rf "$WORK"
echo "INSTALL_OK qq=$(du -sh "$QQ_BASE" | cut -f1) napcat=$(du -sh "$LAUNCHER/napcat" | cut -f1)"