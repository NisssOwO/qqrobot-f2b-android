#!/bin/bash
# QQ聊天机器人 · Termux 一键安装（免 root，用 udocker 加载镜像）
#
# 用法: bash install.sh
# 前置: pkg install -y proot python curl git tar xz-utils
#
# 做了什么:
#   1. 校验/安装依赖（proot、python、curl、GNU tar、xz）
#   2. pip 安装 udocker
#   3. 下载 udockertools（经 GitHub 镜像，官方源国内常不通）
#   4. 下载 qqrobot 镜像 tar.xz（经 GitHub 镜像），校验 sha256
#   5. udocker load 导入镜像，建一个数据目录
#
# 数据目录: $HOME/qqrobot-data （config、QQ 登录态、NapCat 配置都在这）
set -eu

VERSION="${QQROBOT_VERSION:-0.2.0}"
REPO="${QQROBOT_REPO:-NisssOwO/qqrobot-f2b-android}"
PROXY="${QQROBOT_PROXY:-https://gh-proxy.com/}"
DATA_DIR="${QQROBOT_DATA_DIR:-$HOME/qqrobot-data}"
DOWNLOAD_DIR="${TMPDIR:-/tmp}/qqrobot-dl"

say()  { printf '\033[1;36m[qqrobot]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[qqrobot]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[qqrobot] 错误:\033[0m %s\n' "$*" >&2; exit 1; }

# --- 0. 环境检查 ------------------------------------------------------------
[ -n "${PREFIX:-}" ] && [ -d "$PREFIX" ] || die "这不是 Termux 环境（PREFIX 未设置）。桌面环境请用 docker load。"
say "版本 $VERSION  数据目录 $DATA_DIR"

case "$(uname -m)" in
  aarch64|arm64) ;;
  *) die "当前只提供 arm64 镜像（检测到 $(uname -m)）" ;;
esac

# --- 1. 依赖 ----------------------------------------------------------------
say "检查依赖…"
MISSING=""
for bin in proot python curl tar xz sha256sum; do
  command -v "$bin" >/dev/null 2>&1 || MISSING="$MISSING $bin"
done
if [ -n "$MISSING" ]; then
  say "安装缺失依赖:$MISSING"
  pkg install -y proot python curl tar xz-utils coreutils || die "pkg install 失败，请手动执行: pkg install -y proot python curl tar xz-utils"
fi

# udocker 解压镜像层依赖 GNU tar；toybox 的 tar 会报
# "Error: while extracting image layer"
if tar --version 2>/dev/null | grep -qi toybox; then
  warn "当前 tar 是 toybox，udocker 会解压失败，正在安装 GNU tar…"
  pkg install -y tar || die "安装 GNU tar 失败"
fi
tar --version 2>/dev/null | grep -qi 'GNU tar' || die "tar 不是 GNU tar，udocker 无法解压镜像层"

# --- 2. udocker -------------------------------------------------------------
if ! command -v udocker >/dev/null 2>&1; then
  say "安装 udocker…"
  pip install --no-cache-dir udocker || die "pip install udocker 失败"
fi
say "udocker: $(udocker --version 2>/dev/null | head -1)"

# 3. 运行期工具包（官方源 download.a.incd.pt 在部分网络不可达）
mkdir -p "$DOWNLOAD_DIR"
if [ ! -d "$HOME/.udocker/bin" ] || [ -z "$(ls -A "$HOME/.udocker/bin" 2>/dev/null)" ]; then
  ENG_URL="${PROXY}https://raw.githubusercontent.com/jorge-lip/udocker-builds/master/tarballs/udocker-englib-1.2.11.tar.gz"
  say "下载 udocker 运行工具包…"
  curl -fL --retry 3 --retry-delay 2 -o "$DOWNLOAD_DIR/udt.tar.gz" "$ENG_URL" \
    || die "下载 udockertools 失败，检查网络或设置 QQROBOT_PROXY"
  UDOCKER_TARBALL="$DOWNLOAD_DIR/udt.tar.gz" udocker install || die "udocker install 失败"
fi

# --- 4. 镜像 ----------------------------------------------------------------
mkdir -p "$DATA_DIR"
IMG_XZ="$DOWNLOAD_DIR/qqrobot-arm64.tar.xz"
IMG_TAR="$DOWNLOAD_DIR/qqrobot-arm64.tar"

if udocker images 2>/dev/null | grep -q "qqrobot:${VERSION}"; then
  say "镜像 qqrobot:${VERSION} 已存在，跳过下载"
else
  say "下载镜像（约 400–600MB，视网络可能需要几分钟）…"
  BASE="https://github.com/${REPO}/releases/download/v${VERSION}"
  ok=0
  for prefix in "$PROXY" ""; do
    url="${prefix}${BASE}/qqrobot-arm64.tar.xz"
    say "  尝试 $url"
    if curl -fL --retry 2 --retry-delay 3 -C - -o "$IMG_XZ" "$url"; then ok=1; break; fi
    rm -f "$IMG_XZ"
  done
  [ "$ok" = 1 ] || die "下载镜像失败。可换镜像: QQROBOT_PROXY=https://ghproxy.net/ bash install.sh"

  # 校验
  if curl -fsL -o "$IMG_XZ.sha256" "${PROXY}${BASE}/qqrobot-arm64.tar.xz.sha256" 2>/dev/null; then
    expect="$(awk '{print $1}' "$IMG_XZ.sha256")"
    actual="$(sha256sum "$IMG_XZ" | awk '{print $1}')"
    if [ "$expect" != "$actual" ]; then
      rm -f "$IMG_XZ"; die "镜像校验失败（期望 $expect，实际 $actual）"
    fi
    say "sha256 校验通过"
  else
    warn "未取到校验文件，跳过校验"
  fi

  say "解压…"
  xz -dkf "$IMG_XZ"
  say "导入 udocker…"
  udocker load -i "$IMG_TAR" || die "udocker load 失败"
fi

# --- 5. 建容器（不启动） -----------------------------------------------------
if udocker ps -a 2>/dev/null | grep -q 'qqrobot'; then
  say "容器已存在，跳过创建"
else
  udocker create --name=qqrobot "qqrobot:${VERSION}" || die "udocker create 失败"
fi

say ""
say "安装完成 ✔"
say "  镜像: qqrobot:${VERSION}"
say "  数据: $DATA_DIR"
say ""
say "下一步: bash start.sh"
say "  默认监听 本机 38121；对局域网开放需在 start.sh 前设置口令："
say "  QQROBOT_PASSWORD='你的口令' bash start.sh"