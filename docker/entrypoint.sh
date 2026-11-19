#!/usr/bin/env bash
# NapCat Linux 容器入口
# 用 xvfb 提供虚拟显示器后启动 Linux QQ，NapCat 随 QQ 主进程加载
set -euo pipefail

export NAPCAT_MAIN_PATH="${NAPCAT_MAIN_PATH:-/app/napcat/napcat.mjs}"
export NAPCAT_DOCKER=1

QQ_DIR="${QQ_DIR:-/opt/QQ}"
QQ_BIN="${QQ_DIR}/qq"

if [ ! -x "$QQ_BIN" ]; then
  echo "[entrypoint] 未找到 Linux QQ：$QQ_BIN" >&2
  exit 1
fi

# 允许通过参数覆盖启动参数（例如 --no-sandbox 已经默认带上）
exec xvfb-run -a --server-args="-screen 0 1280x800x24" "$QQ_BIN" --no-sandbox "$@"
