# QQ聊天机器人 — 可分发 OCI 镜像 (linux/arm64)
#
# 两种用法:
#   1) 标准 docker / podman:  docker run -d -p 38121:38121 -e QQROBOT_PASSWORD=... qqrobot
#   2) Termux 免 root:       udocker load < qqrobot-arm64.tar.xz  →  udocker run ...
#
# 内容: ubuntu noble arm64 + Node v24 + NapCat + QQ 3.2.34 + 自家后端 + 启动脚本
# 构建: docker buildx build --platform linux/arm64 -t qqrobot:latest .
#
# 安全立场:
#  - 镜像内不含任何 QQ 登录态 / NapCat WebUI token（首启随机生成）
#  - 后端默认绑定 127.0.0.1；只有设置 QQROBOT_BIND=0.0.0.0 才对外，且必须同时给 QQROBOT_PASSWORD

FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
ARG GITHUB_PROXY=https://ghproxy.net
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

# 2) Node v24 (官方 arm64 tarball; noble 自带 nodejs 只有 18, 后端要求 >=22.13)
RUN tmpdir=$(mktemp -d) && cd "$tmpdir" \
    && PLAT="$(uname -m)" \
    && ARCH=$([ "$PLAT" = "aarch64" ] && echo arm64 || echo "$PLAT") \
    && curl -fsSL --retry 3 -o node.tar.xz "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-${ARCH}.tar.xz" \
    && tar -xJf node.tar.xz --strip-components=1 -C /usr/local \
    && rm -rf "$tmpdir" \
    && node --version && npm --version

# 3) NapCat + QQ 3.2.34-53644 (官方 shell 安装; 无 QQ 登录态)
COPY install.sh /root/install.sh
RUN chmod 700 /root/install.sh \
    && bash /root/install.sh --docker n --cli n --github-proxy "${GITHUB_PROXY}" > /root/napcat-install.log 2>&1 \
    || { echo "install.sh failed, last log:"; tail -40 /root/napcat-install.log; exit 1; } \
    && tail -5 /root/napcat-install.log

# 4) 自家后端 (supervisor: service.mjs → network-guard + server.mjs; 38121 面板 / 38122 控制面)
COPY app/ /root/qqrobot-app
RUN cd /root/qqrobot-app \
    && npm ci --omit=dev --no-audit --no-fund --registry=https://registry.npmjs.org \
    && chmod 700 /root/qqrobot-app/start-managed.sh /root/qqrobot-app/launch-managed.sh 2>/dev/null || true

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