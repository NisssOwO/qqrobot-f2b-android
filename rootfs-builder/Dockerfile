# QQ聊天机器人 (dev.qqrobot.f2b) — proot 容器 rootfs 构建
# 产物: docker build → docker create → docker export | xz > rootfs.tar.xz（首启下载资源）
# 运行侧不变: termux-app 定制版用 proot 运行此容器; docker 只管构建。
#
# 内容（对应 HANDOFF §4.2/§4.4-3）: ubuntu noble arm64 + Node v24 + NapCat + QQ + 自家后端 + 启动脚本
# 构建: docker buildx build --platform linux/arm64 -t qqrobot-rootfs:v1 .
#
# 注意:
#  - 首次扫码引导（决策③）: 本镜像不含任何 QQ 登录态 / NapCat WebUI token
#  - 凭据（webui.json token / 受管服务 control token）由首启脚本随机生成, 不入镜像

FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
ARG GITHUB_PROXY=https://ghproxy.net

# 1) 基础 + NapCat/QQ 运行依赖（与真机验证过的清单一致, EXEC-NOTES.md）
RUN apt-get update && apt-get install -y --no-install-recommends \
        bash coreutils ca-certificates curl wget unzip zip xz-utils jq \
        screen procps rpm2cpio cpio \
        xvfb xauth \
        python3 \
        libnss3 libgbm1 libgssapi-krb5-2 \
        libglib2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 \
        libgtk-3-0t64 libasound2t64 \
    && rm -rf /var/lib/apt/lists/*

# 2) Node v24 (官方 arm64 tarball; noble 自带 nodejs 只有 18, 后端要求 >=22.13)
ARG NODE_VERSION=v24.22.1
RUN tmpdir=$(mktemp -d) && cd "$tmpdir" \
    && PLAT="$(uname -m)" \
    && ARCH=$([ "$PLAT" = "aarch64" ] && echo arm64 || echo "$PLAT") \
    && curl -fsSL -o node.tar.xz "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-${ARCH}.tar.xz" \
    && tar -xJf node.tar.xz --strip-components=1 -C /usr/local \
    && rm -rf "$tmpdir" \
    && node --version && npm --version

# 3) NapCat + QQ 3.2.34-53644 (官方 shell 安装, 与真机一致; 无 QQ 登录态)
COPY install.sh /root/install.sh
RUN chmod 700 /root/install.sh \
    && bash /root/install.sh --docker n --cli n --github-proxy "${GITHUB_PROXY}" > /root/napcat-install.log 2>&1 \
    || { echo "install.sh failed, last log:"; tail -40 /root/napcat-install.log; exit 1; } \
    && tail -5 /root/napcat-install.log

# 4) 自家后端 0.6.1 (supervisor: service.mjs → network-guard + server.mjs; 38121 面板 / 38122 控制)
COPY app/ /root/qqrobot-app
RUN cd /root/qqrobot-app \
    && npm ci --omit=dev --no-audit --no-fund --registry=https://registry.npmjs.org \
    && chmod 700 /root/qqrobot-app/start-managed.sh /root/qqrobot-app/launch-managed.sh 2>/dev/null || true

# 5) 启动脚本与首启配置生成器
COPY start-qqrobot.sh /root/start-qqrobot.sh
COPY init-napcat-config.sh /root/init-napcat-config.sh
COPY check-qqrobot.sh /root/check-qqrobot.sh
RUN chmod 700 /root/start-qqrobot.sh /root/init-napcat-config.sh /root/check-qqrobot.sh

ENV DISPLAY=:97
ENV QT_QPA_PLATFORM=xcb
CMD ["/bin/bash", "/root/start-qqrobot.sh"]