#!/usr/bin/env node
// 从当前待交付文件建立干净副本；不修改 Git 索引，不连接真实数据库，不安装到正式路径。
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [major, minor] = process.versions.node.split('.').map(Number);
if (!((major === 22 && minor >= 13) || major === 24)) throw new Error('请使用 Node 22.13+ 或 24.x');
if (process.platform !== 'darwin') throw new Error('完整桌面验收需要 macOS');
const work = mkdtempSync(join(tmpdir(), 'tododesk-clean-'));
const repo = join(work, 'dayfolio');
const logs = join(work, 'logs');
const home = join(work, 'home');
for (const p of [repo, logs, home]) mkdirSync(p, { recursive: true });
const npmCli = process.env.npm_execpath;
if (!npmCli || !existsSync(npmCli)) throw new Error('请在仓库根目录通过 npm run verify:clean 启动');
const env = {
  PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
  HOME: home,
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
  TODODESK_DB: join(work, 'acceptance.db'),
  TODODESK_USER_DATA: join(work, 'userData'),
  npm_config_cache: join(work, 'npm-cache'),
  DAYFOLIO_SKIP_CODEX_SYNC: '1',
};
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const report = { version: JSON.parse(readFileSync(join(source, 'package.json'))).version, node: process.version, platform: process.platform, arch: process.arch, startedAt: new Date().toISOString(), directory: work, sourceFiles: {}, steps: [], passed: false };
const reportPath = join(work, 'report.json');
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(`[干净验收] 目录：${work}`);
let activeChild = null;
let interrupted = false;
const stopGroup = (child, signal) => {
  try { process.kill(-child.pid, signal); } catch { /* 进程组已退出 */ }
};
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted = true;
  if (activeChild) stopGroup(activeChild, 'SIGTERM');
});

const run = async (name, executable, args, options = {}) => {
  if (interrupted) throw new Error('验收已中断');
  console.log(`[干净验收] 开始：${name}`);
  const log = join(logs, `${String(report.steps.length + 1).padStart(2, '0')}-${name}.log`);
  const fd = openSync(log, 'w');
  const started = Date.now();
  let result;
  try {
    result = await new Promise((res, rej) => {
      const child = spawn(executable, args, { cwd: repo, env, detached: true, stdio: ['ignore', fd, fd], ...options });
      activeChild = child;
      const timeout = setTimeout(() => stopGroup(child, 'SIGKILL'), 600_000);
      child.once('error', (error) => { clearTimeout(timeout); activeChild = null; rej(error); });
      child.once('exit', (code, signal) => { clearTimeout(timeout); activeChild = null; res({ code, signal }); });
    });
  } finally { closeSync(fd); }
  report.steps.push({ name, command: [executable, ...args], ...result, durationMs: Date.now() - started, log });
  save();
  if (result.code !== 0) {
    console.error(readFileSync(log, 'utf8').slice(-12000));
    throw new Error(`${name} 失败（退出码 ${result.code ?? result.signal}）；日志：${log}`);
  }
  console.log(`[干净验收] 通过：${name}（${Math.round((Date.now() - started) / 1000)} 秒）`);
};
const npm = (name, args) => run(name, process.execPath, [npmCli, ...args]);
try {
  // 包含尚未提交的新文件，保持用户索引原样；已删除的跟踪文件不进入副本。
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: source, encoding: 'utf8' });
  const files = [...new Set(listed.split('\0').filter(Boolean))].sort();
  const aliases = ['tododesk', 'tododesk-teach', 'tododesk-sports'].map(name => `.agents/skills/${name}`).filter(rel => {
    try { return lstatSync(join(source, rel)).isSymbolicLink(); } catch { return false; }
  });
  report.sourceLinks = {};
  for (const rel of aliases) {
    const name = rel.split('/').at(-1);
    if (realpathSync(join(source, rel)) !== realpathSync(join(source, 'packages/agent-kit/skills', name))) throw new Error(`非法技能链接：${rel}`);
    const link = readlinkSync(join(source, rel));
    if (isAbsolute(link)) throw new Error(`技能链接必须可迁移：${rel}`);
    mkdirSync(dirname(join(repo, rel)), { recursive: true }); symlinkSync(link, join(repo, rel)); report.sourceLinks[rel] = link;
  }
  for (const rel of files) {
    if (aliases.some(alias => rel === alias || rel.startsWith(alias + '/'))) continue;
    if (isAbsolute(rel) || rel.split('/').includes('..')) throw new Error(`非法源码路径：${rel}`);
    if (/(^|\/)(node_modules|\.git|dist|out|release|backups)(\/|$)/.test(rel) || /(^|\/)(\.env(?:\..+)?|credentials\.json|secrets\.json)$/.test(rel) && !rel.endsWith('.env.example') || /\.(?:db|sqlite3?|pem|key)(?:-wal|-shm|\.bak)?$/.test(rel) || rel === '.mcp.json') {
      throw new Error(`待交付文件包含个人数据、凭证或旧构建目录：${rel}`);
    }
    const original = join(source, rel);
    if (!existsSync(original)) continue;
    if (!lstatSync(original).isFile()) throw new Error(`源码包含符号链接或非普通文件，请人工检查：${rel}`);
    const destination = join(repo, rel);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(original, destination);
    report.sourceFiles[rel] = sha256(destination);
  }
  for (const rel of ['apps/plugin/.mcp.json', 'apps/plugin/mcp.json', 'package-lock.json']) {
    if (!report.sourceFiles[rel]) throw new Error(`发布文件缺失：${rel}`);
  }
  for (const p of ['node_modules', 'apps/desktop/out', 'apps/mcp/dist', '.mcp.json']) {
    if (existsSync(join(repo, p))) throw new Error(`干净副本混入本地文件：${p}`);
  }
  writeFileSync(join(work, 'SHA256SUMS'), Object.entries(report.sourceFiles).map(([p, digest]) => `${digest}  ${p}`).join('\n') + '\n');
  save();
  console.log(`[干净验收] 已复制 ${Object.keys(report.sourceFiles).length} 个发布文件，不复用原仓库依赖与桌面产物`);
  await npm('安装依赖', ['ci', '--include=dev']);
  await npm('依赖审计', ['audit', '--audit-level=moderate']);
  await npm('单测与MCP端到端', ['test']);
  await npm('类型检查', ['run', 'typecheck']);
  await npm('帮助同步', ['run', 'help:sync']);
  const help = 'apps/desktop/src/renderer/src/generated/helpContent.ts';
  if (sha256(join(repo, help)) !== report.sourceFiles[help]) throw new Error('帮助生成文件未同步，请先运行 npm run help:sync');
  // 分发副本由统一源码生成，禁止把旧副本当成第二份维护来源。
  await npm('统一能力包与兼容插件构建', ['run', 'plugin:build']);
  await npm('插件安装验收', ['run', 'plugin:verify']);
  await npm('桌面构建', ['run', 'build:desktop']);
  await run('隔离界面验收', process.execPath, ['apps/desktop/scripts/ui-smoke-demo.mjs'], { env: { ...env, TODODESK_SMOKE_SCREENSHOT: join(logs, 'today.png') } });
  await run('上手课程空库与重启验收', process.execPath, ['apps/desktop/scripts/ui-smoke-onboarding.mjs']);
  await run('弹窗隔离验收', process.execPath, ['apps/desktop/scripts/ui-smoke-modals.mjs']);
  await run('HTML 工具隔离验收', process.execPath, ['apps/desktop/scripts/ui-smoke-tools.mjs']);
  await run('HTML 待办接口隔离验收', process.execPath, ['apps/desktop/scripts/ui-smoke-tool-todos.mjs']);
  await npm('桌面打包', ['run', 'package:desktop']);
  const app = join(repo, 'apps/desktop/release/Dayfolio.app');
  await run('安装包签名验证', '/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  await run('安装包上手课程验收', process.execPath, ['apps/desktop/scripts/ui-smoke-onboarding.mjs'], { env: { ...env, TODODESK_SMOKE_APP: join(app, 'Contents/MacOS/Dayfolio') } });
  await run('安装包弹窗验收', process.execPath, ['apps/desktop/scripts/ui-smoke-modals.mjs'], { env: { ...env, TODODESK_SMOKE_APP: join(app, 'Contents/MacOS/Dayfolio') } });
  await run('安装包 HTML 工具验收', process.execPath, ['apps/desktop/scripts/ui-smoke-tools.mjs'], { env: { ...env, TODODESK_SMOKE_APP: join(app, 'Contents/MacOS/Dayfolio') } });
  await run('安装包 HTML 待办接口验收', process.execPath, ['apps/desktop/scripts/ui-smoke-tool-todos.mjs'], { env: { ...env, TODODESK_SMOKE_APP: join(app, 'Contents/MacOS/Dayfolio') } });
  const version = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
  if (version !== report.version) throw new Error(`安装包版本不一致：${version}`);
  for (const [rel, digest] of Object.entries(report.sourceFiles)) {
    if (!existsSync(join(source, rel)) || sha256(join(source, rel)) !== digest) throw new Error(`验收期间原工作区发生变化，须重新验收：${rel}`);
  }
  for (const [rel, link] of Object.entries(report.sourceLinks)) {
    if (readlinkSync(join(source, rel)) !== link) throw new Error(`验收期间技能链接变化：${rel}`);
  }
  report.artifact = app;
  report.passed = true;
} catch (error) {
  report.error = error.message;
  console.error(`[干净验收] ${error.message}`);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  save();
  console.log(`[干净验收] ${report.passed ? 'PASS' : 'FAIL'}；报告：${reportPath}`);
  console.log('[干净验收] 日志、源码清单与候选包留在上述临时目录，确认完成后可删除该目录');
}
