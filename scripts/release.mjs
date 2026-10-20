// GitHub 发布计划：版本、提交、更新说明与已发布标签必须一致。
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function compareVersions(left, right) {
  if (!stableVersion.test(left) || !stableVersion.test(right)) throw new Error('发布版本必须是 x.y.z 格式的正式版本');
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

export function affectsApp(path) {
  if (/(^|\/)(test|tests)(\/|$)/.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) return false;
  if (/^apps\/desktop\/scripts\/ui-smoke-[^/]+\.mjs$/.test(path)) return false;
  return /^(apps\/(desktop|help|mcp|plugin)\/|packages\/|\.agents\/skills\/)/.test(path)
    || /^(package(?:-lock)?\.json|tsconfig[^/]*\.json|scripts\/generate-command-inputs\.cjs)$/.test(path);
}

export function releaseNotes(changelog, version) {
  compareVersions(version, version);
  const sections = [...changelog.matchAll(/^## (\d+\.\d+\.\d+)\s+[^\n]+$/gm)];
  if (sections[0]?.[1] !== version) throw new Error(`CHANGELOG.md 的首个版本必须是 ${version}`);
  if (sections.filter(section => section[1] === version).length !== 1) throw new Error('CHANGELOG.md 中存在重复版本');
  const body = changelog.slice(sections[0].index + sections[0][0].length, sections[1]?.index).trim();
  if (!/^### (新增|修复|变更)$/m.test(body) || !/^- \S/m.test(body)) throw new Error('当前版本缺少中文分类和变更条目');
  return body;
}

export function validateVersionChange({ version, previousVersion, paths }) {
  if (!previousVersion) return;
  const order = compareVersions(version, previousVersion);
  if (order < 0) throw new Error(`版本不能从 ${previousVersion} 回退到 ${version}`);
  if (paths.some(affectsApp) && order <= 0) throw new Error(`本次推送修改了 App，必须递增版本号并更新 CHANGELOG.md（当前 ${version}）`);
}

function existingRelease(repository, tag) {
  // 草稿可能尚未创建标签，读取发布列表才能可靠恢复上传失败的草稿。
  const result = spawnSync('gh', ['api', `repos/${repository}/releases?per_page=100`, '--paginate', '--slurp'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status === 0) return JSON.parse(result.stdout).flat().find(release => release.tag_name === tag) ?? null;
  throw new Error(`无法读取 GitHub Release：${result.stderr}`);
}

export function planRelease(env = process.env, directory = root, lookupRelease = existingRelease) {
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  const readJson = path => JSON.parse(readFileSync(join(directory, path), 'utf8'));
  const { version } = readJson('package.json');
  compareVersions(version, version);
  const lock = readJson('package-lock.json');
  for (const actual of [readJson('apps/desktop/package.json').version, lock.version, lock.packages[''].version, lock.packages['apps/desktop'].version]) {
    if (actual !== version) throw new Error('根清单、桌面清单和锁文件版本必须一致');
  }
  const notes = releaseNotes(readFileSync(join(directory, 'CHANGELOG.md'), 'utf8'), version);
  const sha = git('rev-parse', 'HEAD');
  if (env.GITHUB_SHA && sha !== env.GITHUB_SHA) throw new Error('检出提交与触发工作流的提交不一致');
  const repository = env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('缺少有效的 GITHUB_REPOSITORY');
  const event = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {};
  if (env.GITHUB_EVENT_NAME === 'push' && event.before && !/^0+$/.test(event.before)) {
    const previousVersion = JSON.parse(git('show', `${event.before}:package.json`)).version;
    const paths = git('diff', '--name-only', event.before, sha).split('\n');
    validateVersionChange({ version, previousVersion, paths });
  }
  const tag = `v${version}`;
  const tagResult = spawnSync('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], { cwd: directory, encoding: 'utf8' });
  if (tagResult.error) throw tagResult.error;
  const target = tagResult.status === 0 ? tagResult.stdout.trim() : sha;
  if (target !== sha && git('diff', '--name-only', target, sha).split('\n').some(affectsApp)) {
    throw new Error(`标签 ${tag} 已存在且 App 内容不同，请升版；禁止移动已发布标签`);
  }
  const release = lookupRelease(repository, tag);
  if (release && tagResult.status !== 0 && (!release.draft || release.target_commitish !== sha)) {
    throw new Error('Release 已存在但缺少匹配当前提交的标签或草稿，请检查发布目标');
  }
  const publish = !release || release.draft;
  if (publish && target !== sha) throw new Error(`未完成的 ${tag} 标签指向其他提交，请在该标签提交上重跑发布`);
  const out = join(directory, 'dist', 'github-release');
  mkdirSync(out, { recursive: true });
  const body = `${notes}\n\n### 下载与安装\n\n- Apple 芯片 Mac：下载 Dayfolio-${version}-macOS-arm64.zip。\n- Intel Mac：下载 Dayfolio-${version}-macOS-x64.zip。\n- 解压后将 Dayfolio.app 放入“应用程序”；SHA256SUMS 提供两个下载包的 SHA-256 校验值。\n- 源码归档由 GitHub 在本页提供，构建方法见仓库 README。\n\n桌面包采用 ad-hoc 签名，尚未进行 Developer ID 签名和 Apple 公证；首次打开可能受到 macOS 安全机制拦截。\n\n构建提交：${sha}\n`;
  writeFileSync(join(out, 'notes.md'), body);
  const plan = { version, tag, sha, target, publish, exists: Boolean(release) };
  writeFileSync(join(out, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  if (env.GITHUB_OUTPUT) for (const [key, value] of Object.entries(plan)) appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);
  console.log(publish ? `准备发布 ${tag}，提交 ${sha}` : `${tag} 已发布，本次跳过`);
  return plan;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) planRelease();
