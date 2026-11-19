#!/usr/bin/env bash
# NapCat 更新源迁移脚本（Linux / macOS）
#
# 背景：上游 NapNeko/NapCatQQ 已归档，老版本的「检查更新」会一直拿不到新版本。
# 本脚本把当前安装目录里的程序文件换成维护仓库的最新 Release，
# 换完之后 WebUI 的检查更新 / 版本列表 / 临时版本都会指向维护仓库。
#
# 用法：
#   ./migrate-update-source.sh [选项]
#     --dir <目录>      NapCat 安装目录（默认：本脚本所在目录）
#     --tag <vX.Y.Z>    指定版本（默认：维护仓库最新 Release）
#     --mirror <前缀>   下载加速前缀，例如 https://ghproxy.com/
#     --dry-run         只打印将要覆盖的文件，不实际写入
#     -h, --help        显示帮助
#
# 保留：config/ data/ logs/ temp/ cache/ 以及三个 Windows 引导文件
set -euo pipefail

REPO_OWNER="EXE-autumnwind"
REPO_NAME="NapCatQQ"
API="https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAG=""
MIRROR="${NAPCAT_MIGRATE_MIRROR:-}"
DRY_RUN=0

usage () {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die () {
  echo "[migrate] 错误：$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --mirror) MIRROR="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1（用 --help 查看用法）" ;;
  esac
done

command -v curl >/dev/null 2>&1 || die "需要 curl"

[ -d "$DIR" ] || die "目录不存在：$DIR"
[ -f "$DIR/napcat.mjs" ] || die "$DIR 不像 NapCat 目录（找不到 napcat.mjs）"

# 与 WebUI 更新器一致的判断：有 napcat.cjs 就是 Framework 版，否则是 Shell 版
if [ -f "$DIR/napcat.cjs" ]; then
  ASSET="NapCat.Framework.zip"
  EDITION="Framework"
else
  ASSET="NapCat.Shell.zip"
  EDITION="Shell"
fi

if [ -z "$TAG" ]; then
  echo "[migrate] 查询 ${REPO_OWNER}/${REPO_NAME} 最新 Release ..."
  TAG="$(curl -fsSL "$API/releases/latest" \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1)"
  [ -n "$TAG" ] || die "无法获取最新版本号（网络或 API 限流），可用 --tag 手动指定"
fi

URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${TAG}/${ASSET}"
if [ -n "$MIRROR" ]; then
  URL="${MIRROR%/}/${URL}"
fi
# 便于自建镜像 / 离线调试：直接指定完整下载地址
URL="${NAPCAT_MIGRATE_URL:-$URL}"

TMP="$(mktemp -d 2>/dev/null || mktemp -d -t napcat-migrate)"
cleanup () { rm -rf "$TMP"; }
trap cleanup EXIT

echo "[migrate] 版本：${TAG}（${EDITION} 版）"
echo "[migrate] 下载：${URL}"
curl -fL --retry 3 --retry-delay 5 -o "$TMP/$ASSET" "$URL" || die "下载失败"

echo "[migrate] 解压 ..."
if command -v unzip >/dev/null 2>&1; then
  unzip -q "$TMP/$ASSET" -d "$TMP/pkg"
elif command -v python3 >/dev/null 2>&1; then
  python3 -m zipfile -e "$TMP/$ASSET" "$TMP/pkg"
else
  die "需要 unzip 或 python3 来解压"
fi

# 用户数据目录与引导文件不覆盖
PRESERVE_DIRS="config data logs temp cache"
SKIP_FILES="NapCatWinBootMain.exe NapCatWinBootHook.dll quickLoginExample.bat"

cd "$TMP/pkg"
COUNT=0
while IFS= read -r f; do
  rel="${f#./}"
  dir_part="$(dirname "$rel")"
  base="$(basename "$rel")"

  case "/$dir_part/" in
    */config/*|*/data/*|*/logs/*|*/temp/*|*/cache/*) continue ;;
  esac
  case " $SKIP_FILES " in
    *" $base "*) continue ;;
  esac

  if [ "$DRY_RUN" = "1" ]; then
    echo "  将覆盖：$rel"
  else
    mkdir -p "$DIR/$dir_part"
    cp -f "$f" "$DIR/$rel"
  fi
  COUNT=$((COUNT + 1))
done < <(find . -type f)

if [ "$DRY_RUN" = "1" ]; then
  echo "[migrate] dry-run 结束，共 ${COUNT} 个文件会被覆盖（未写入）"
else
  echo "[migrate] 完成：已覆盖 ${COUNT} 个文件，config/ 与 data/ 未改动"
  echo "[migrate] 重启 NapCat 后，WebUI 的检查更新会从 ${REPO_OWNER}/${REPO_NAME} 获取版本"
fi
