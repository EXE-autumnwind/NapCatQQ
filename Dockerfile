# NapCat Linux 镜像（维护接力版）
#
# 构建前需要把 NapCat.Shell 包解压到构建上下文的 ./napcat 目录，
# 由 .github/workflows/release-publish.yml 的 docker-image 任务自动完成。
#
# 机制说明：Linux QQ 是 Electron 应用，把 resources/app/package.json 的 main
# 指向 NapCat 的 loadNapCat.js（与 Windows 版 NapCatWinBootMain 注入同一套思路），
# 再由 entrypoint 用 xvfb 启动 QQ，NapCat 会随 QQ 主进程一起加载。
FROM node:22-bookworm-slim

# Linux QQ 安装包（AppImage），可用 --build-arg 覆盖成其他构建
ARG QQ_URL="https://qqdl.gtimg.cn/qqfile/QQNT/9.9.36/beta/9ee04bef/linuxqq_3.2.34-53644_x86_64.AppImage"

# QQ 运行所需的基础依赖 + xvfb（容器内没有真实显示器）
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xvfb \
      libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 libatspi2.0-0 \
      libsecret-1-0 libgbm1 libasound2 xdg-utils \
      fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# 解压 Linux QQ 到 /opt/QQ
RUN mkdir -p /opt/QQ \
    && curl -fsSL --retry 3 --retry-delay 5 -o /tmp/qq.AppImage "$QQ_URL" \
    && chmod +x /tmp/qq.AppImage \
    && cd /tmp && ./qq.AppImage --appimage-extract >/dev/null \
    && cp -a /tmp/squashfs-root/. /opt/QQ/ \
    && rm -rf /tmp/qq.AppImage /tmp/squashfs-root

# NapCat Shell 包（构建上下文里的 ./napcat）
COPY napcat /app/napcat
COPY docker/entrypoint.sh /app/napcat/docker-entrypoint.sh
RUN chmod +x /app/napcat/docker-entrypoint.sh

# 把 QQ 的 Electron 入口指向 NapCat 的加载器
RUN node -e "const fs=require('fs');const p='/opt/QQ/resources/app/package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.main='/app/napcat/loadNapCat.js';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');"

ENV NAPCAT_MAIN_PATH=/app/napcat/napcat.mjs \
    NAPCAT_DOCKER=1 \
    QQ_DIR=/opt/QQ

WORKDIR /app/napcat

# WebUI / OneBot 默认端口
EXPOSE 6099

# 配置与数据持久化
VOLUME ["/app/napcat/config", "/app/napcat/data"]

ENTRYPOINT ["/app/napcat/docker-entrypoint.sh"]
