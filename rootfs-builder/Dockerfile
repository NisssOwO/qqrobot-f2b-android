# QQ聊天机器人 — 可分发 OCI 镜像 (linux/arm64)
#
# 两种用法:
#   1) 标准 docker / podman:  docker run -d -p 38121:38121 -e QQROBOT_PASSWORD=... qqrobot
#   2) Termux 免 root:       udocker load < qqrobot-arm64.tar.xz  →  udocker run ...
#
# 内容: ubuntu noble arm64 + Node v24 + NapCat + QQ 3.2.34 + 自家后端 + 启动脚本
# 构建: docker buildx build --platform linux/arm64 -t qqrobot:latest .
#
# 安装方式: 直接解 QQ deb + 解压 NapCat.Shell.zip 注入（见 install-qq-napcat.sh），
#           不用官方 install.sh（QEMU 下会误判架构，且镜像站下载慢）。
#
# 安全立场:
#  - 镜像内不含任何 QQ 登录态 / NapCat WebUI token（首启随机生成，落在 /data 卷）
#  - 后端默认绑定 127.0.0.1；只有设置 QQROBOT_BIND=0.0.0.0 才对外，且必须同时给 QQROBOT_PASSWORD

FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
# 只影响 NapCat.Shell.zip 的下载方式（给 URL 加代理前缀）。CI 在海外构建时保持 0。
ARG GITHUB_PROXY=0
ARG NODE_VERSION=v24.22.1

LABEL org.opencontainers.image.title="QQ聊天机器人" \
      org.opencontainers.image.description="QQ chat bot runtime: NapCat + QQ NT + LLM bridge, arm64, rootless-friendly" \
      org.opencontainers.image.source="https://github.com/NisssOwO/qqrobot-f2b-android" \
      org.opencontainers.image.licenses="MIT"

# 1) 基础 + NapCat/QQ 运行依赖（与真机验证过的清单一致, EXEC-NOTES.md）
RUN apt-get update && apt-get install -y --no-install-recommends \
        bash coreutils ca-certificates curl wget unzip zip xz-utils jq \
        screen procps rpm2cpio cpio \
        xvfb xauth \
        libnss3 libgbm1 libgssapi-krb5-2 \
        libglib2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 \
        libgtk-3-0t64 libasound2t64 \
        tini \
    && rm -rf /var/lib/apt/lists/*

# 1b) 架构防线（必须在装 QQ 之前跑）
# 本镜像只做 linux/arm64。构建机上 buildx 用 QEMU 模拟 arm64，而 `uname -m` / `arch`
# 在 binfmt_misc 配置不同的情况下可能返回宿主机的 x86_64 —— 一旦如此，install.sh
# 会去下 linuxqq_*_amd64.deb，镜像装进一个 x86 的 QQ，上了手机根本跑不起来，
# 而且直到真机启动才发现。这里显式断言 + 导出 ARCH，让后续步骤有确定值可用。
RUN set -eu; \
    ARCH="$(dpkg --print-architecture)"; \
    if [ "$ARCH" != "arm64" ]; then \
        echo "FATAL: this image must be built for linux/arm64, got dpkg arch=$ARCH"; \
        echo "       build with: docker buildx build --platform linux/arm64 ..."; \
        exit 1; \
    fi; \
    echo "arch check OK: dpkg=$ARCH uname=$(uname -m)"
ENV QQROBOT_ARCH=arm64

# 2) Node v24 (官方 arm64 tarball; noble 自带 nodejs 只有 18, 后端要求 >=22.13)
# 用 dpkg --print-architecture 而不是 uname -m：前者读的是镜像内 dpkg 状态，
# QEMU 下也稳定返回 arm64。
# cd / 之后才删临时目录：留在被删掉的 cwd 里执行 npm 会以
# "uv_cwd ENOENT: process.cwd failed" 失败（npm 启动就要读 cwd）。
RUN set -eu; \
    tmpdir="$(mktemp -d)"; \
    cd "$tmpdir"; \
    curl -fsSL --retry 3 -o node.tar.xz \
         "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-arm64.tar.xz"; \
    tar -xJf node.tar.xz --strip-components=1 -C /usr/local; \
    cd /; rm -rf "$tmpdir"; \
    node --version; npm --version

# 2b) /dev/shm 兜底
# proot (udocker P 模式) 不提供 /dev/shm，而 Electron/Chromium 默认会去用它。
# 启动 QQ 时已经带 --disable-dev-shm-usage（走 /tmp），这里再显式建一个 1777
# 目录，给没有该参数的子进程（以及将来别的组件）留一条活路。容器运行时会
# 用 --tmpfs /dev/shm 覆盖它，所以镜像里这一层不会占体积。
RUN mkdir -p /dev/shm && chmod 1777 /dev/shm

# 3) QQ NT 3.2.34-53644 + NapCat 载荷
#    不走官方 install.sh：它在 QEMU 构建机上会用 `arch`/`uname -m` 判断架构（可能得到宿主的
#    x86_64 → 装进 amd64 的 QQ），且 NapCat 走 GitHub 镜像站下载极慢。这里用真机验证过的
#    直装路径：dpkg -x 解 QQ deb → 解压 NapCat.Shell.zip → cp -a 注入 → 改 package.json main。
#    两个下载地址都能用 build-arg 覆盖（CI 落地时指向自建 Release 资产）。
ARG QQ_DEB_URL=https://qqdl.gtimg.cn/qqfile/QQNT/9.9.36/beta/9ee04bef/linuxqq_3.2.34-53644_arm64.deb
ARG NAPCAT_URL=https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip
COPY install-qq-napcat.sh /root/install-qq-napcat.sh
RUN chmod 700 /root/install-qq-napcat.sh \
    && QQ_DEB_URL="${QQ_DEB_URL}" NAPCAT_URL="${NAPCAT_URL}" GITHUB_PROXY="${GITHUB_PROXY}" \
       bash /root/install-qq-napcat.sh \
    && rm -f /root/install-qq-napcat.sh

# 3b) 兜底断言：QQ 必须是 aarch64，NapCat 载荷必须在位
RUN set -eu; \
    QQ_BIN=/root/Napcat/opt/QQ/qq; \
    [ -x "$QQ_BIN" ] || { echo "FATAL: $QQ_BIN missing"; exit 1; }; \
    MACHINE="$(od -An -tx1 -j18 -N2 "$QQ_BIN" | tr -d ' \n')"; \
    [ "$MACHINE" = "b700" ] || { echo "FATAL: QQ not aarch64 ($MACHINE)"; exit 1; }; \
    LAUNCH=/root/Napcat/opt/QQ/resources/app/app_launcher/napcat; \
    [ -f "$LAUNCH/napcat.mjs" ] || { echo "FATAL: NapCat payload missing"; exit 1; }; \
    [ "$(jq -r '.main' /root/Napcat/opt/QQ/resources/app/package.json)" = "./loadNapCat.js" ] \
        || { echo "FATAL: QQ package.json main not patched"; exit 1; }; \
    echo "QQ+NapCat OK (qq=$(du -sh /root/Napcat | cut -f1))"

# 4) 自家后端 (supervisor: service.mjs → network-guard + server.mjs; 38121 面板 / 38122 控制面)
COPY app/ /root/qqrobot-app
RUN cd /root/qqrobot-app \
    && npm ci --omit=dev --no-audit --no-fund --registry=https://registry.npmjs.org
RUN chmod 700 /root/qqrobot-app/start-managed.sh /root/qqrobot-app/launch-managed.sh 2>/dev/null || true

# 5) 启动脚本与首启配置生成器
COPY start-qqrobot.sh /root/start-qqrobot.sh
COPY init-napcat-config.sh /root/init-napcat-config.sh
COPY check-qqrobot.sh /root/check-qqrobot.sh
COPY entrypoint.sh /root/entrypoint.sh
COPY healthcheck.sh /root/healthcheck.sh
RUN chmod 700 /root/start-qqrobot.sh /root/init-napcat-config.sh /root/check-qqrobot.sh \
        /root/entrypoint.sh /root/healthcheck.sh

# 6) 运行期契约
#    QQROBOT_DATA_DIR  持久数据卷（config.json / .runtime / QQ 登录态 / NapCat 配置）
#    QQROBOT_BIND      127.0.0.1（默认，仅本机）| 0.0.0.0（局域网）
#    QQROBOT_PORT      面板端口，默认 38121
#    QQROBOT_PASSWORD  局域网登录口令（QQROBOT_BIND=0.0.0.0 时必填）
#    QQ_ACCOUNT        机器人 QQ 号（写入首启配置）
#    GROUP_ALLOW       允许群号，逗号分隔
ENV DISPLAY=:97 \
    QT_QPA_PLATFORM=xcb \
    QQROBOT_DATA_DIR=/data \
    QQROBOT_BIND=127.0.0.1 \
    QQROBOT_PORT=38121

VOLUME ["/data"]
EXPOSE 38121

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD ["/bin/bash", "/root/healthcheck.sh"]

# tini 接管 PID 1，负责转发 SIGTERM 并回收 NapCat/QQ 的僵尸子进程
ENTRYPOINT ["/usr/bin/tini", "--", "/bin/bash", "/root/entrypoint.sh"]