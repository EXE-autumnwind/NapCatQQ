/**
 * NapCat 仓库信息（检查更新 / 版本列表 / 临时版本 的统一入口）
 *
 * 维护接力说明：上游 NapNeko/NapCatQQ 已归档，仓库只剩 README，
 * 继续按上游仓库检查更新会永远拿不到新版本。这里把仓库指向维护仓库，
 * 需要换到其他 fork 时只改下面三个常量即可，其余逻辑无需改动。
 */

/** 维护仓库 owner */
export const NAPCAT_REPO_OWNER = 'EXE-autumnwind';

/** 维护仓库 repo */
export const NAPCAT_REPO_NAME = 'NapCatQQ';

/** 产出临时版本（Action artifacts）的 workflow 文件名，对应 .github/workflows/build-ci.yml */
export const NAPCAT_ACTION_WORKFLOW = 'build-ci.yml';

/** 仓库主页地址 */
export const NAPCAT_REPO_URL = `https://github.com/${NAPCAT_REPO_OWNER}/${NAPCAT_REPO_NAME}`;

/** Release 列表地址 */
export const NAPCAT_RELEASES_URL = `${NAPCAT_REPO_URL}/releases`;

/** README 原始文件地址（用于镜像测速） */
export const NAPCAT_README_URL = `https://raw.githubusercontent.com/${NAPCAT_REPO_OWNER}/${NAPCAT_REPO_NAME}/main/README.md`;

/** Docker 镜像地址（容器内更新时提示用户拉取新镜像） */
export const NAPCAT_DOCKER_IMAGE = `ghcr.io/${NAPCAT_REPO_OWNER.toLowerCase()}/napcat`;

/**
 * 生成某个 Release tag 的页面地址
 * @param tag - 版本 tag，例如 v4.18.44
 */
export function napcatReleaseTagUrl (tag: string): string {
  return `${NAPCAT_RELEASES_URL}/tag/${tag}`;
}
