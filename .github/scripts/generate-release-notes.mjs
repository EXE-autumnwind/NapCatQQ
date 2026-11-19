import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

/**
 * 生成 Release 说明
 *
 * 输出格式（维护接力约定）：
 *   新增
 *   - ...
 *   修复(如有)
 *   - ...
 *   删减（如有）
 *   - ...
 *
 * 用法：node generate-release-notes.mjs <vX.Y.Z> <owner/repo> <output.md>
 */

function parseVersion (tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(tag);
  if (!match) return null;
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some(identifier => !identifier || /^0\d+$/.test(identifier))) return null;
  return { tag, numbers: match.slice(1, 4).map(BigInt), prerelease };
}

function compareVersions (left, right) {
  for (let index = 0; index < 3; index++) {
    if (left.numbers[index] !== right.numbers[index]) {
      return left.numbers[index] > right.numbers[index] ? 1 : -1;
    }
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    return Number(!left.prerelease.length) - Number(!right.prerelease.length);
  }
  for (let index = 0; index < Math.min(left.prerelease.length, right.prerelease.length); index++) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) return BigInt(leftIdentifier) > BigInt(rightIdentifier) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier > rightIdentifier ? 1 : -1;
  }
  return left.prerelease.length - right.prerelease.length;
}

function git (...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

const [tag, repository, outputFile] = process.argv.slice(2);
const currentVersion = parseVersion(tag);
if (process.argv.length !== 5 || !currentVersion || !repository || !outputFile) {
  throw new Error('Usage: node generate-release-notes.mjs <vX.Y.Z[-prerelease]> <owner/repo> <output.md>');
}
if (git('rev-parse', '--is-shallow-repository') === 'true') {
  throw new Error('Release notes require complete Git history and tags (fetch-depth: 0)');
}

const currentRef = `refs/tags/${currentVersion.tag}`;
const previousVersion = git('tag', '--merged', currentRef)
  .split('\n')
  .map(parseVersion)
  .filter(version => version && compareVersions(version, currentVersion) < 0)
  .sort((left, right) => compareVersions(right, left))[0];
if (!previousVersion) throw new Error(`No preceding version tag is reachable from ${currentVersion.tag}`);

const commits = git('log', '--reverse', '--format=%H%x09%s', `refs/tags/${previousVersion.tag}..${currentRef}`);
const repositoryUrl = `https://github.com/${repository}`;

// 按提交前缀归类：feat -> 新增，fix -> 修复，revert/remove/drop/refactor -> 删减，其余归入新增
const sections = { added: [], fixed: [], removed: [] };
for (const commit of commits.split('\n').filter(Boolean)) {
  const separator = commit.indexOf('\t');
  const hash = commit.slice(0, separator);
  const subject = commit.slice(separator + 1).replace(/[\\`*_[\]<>]/g, '\\$&');
  const line = `- ${subject} ([${hash.slice(0, 8)}](${repositoryUrl}/commit/${hash}))`;
  if (/^fix(\(|:|!|\s)/i.test(subject)) {
    sections.fixed.push(line);
  } else if (/^(revert|remove|drop|refactor|perf)(\(|:|!|\s)/i.test(subject)) {
    sections.removed.push(line);
  } else {
    sections.added.push(line);
  }
}

const lines = ['新增', ''];
lines.push(...(sections.added.length ? sections.added : ['- 无']));
lines.push('', '修复(如有)', '');
if (sections.fixed.length) lines.push(...sections.fixed);
lines.push('', '删减（如有）', '');
if (sections.removed.length) lines.push(...sections.removed);
lines.push('', `[完整变更](${repositoryUrl}/compare/${previousVersion.tag}...${currentVersion.tag})`, '');

writeFileSync(outputFile, lines.join('\n'), 'utf8');
console.log(`Generated release notes: ${previousVersion.tag}...${currentVersion.tag}`);
