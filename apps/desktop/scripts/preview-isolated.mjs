#!/usr/bin/env node
// TodoDesk 隔离预览（一次性沙盒，供用户手动启动体验；绝不触碰真实数据）：
//   - 严格临时三件套 HOME / TODODESK_DB / TODODESK_USER_DATA，vault / 课程包 staging 也在同一临时目录内，
//     课程/工具资产根随 dirname(TODODESK_DB) 推导；启动前以 realpath + 段级包含做硬校验
//     （防同级前缀绕过），命中真实 HOME、Application Support、真实 knowledge-base 或真实课程资产路径即拒绝；
//   - 演示数据（四模块闭环，全部标注「演示」，只落临时库）：新闻（agent 任务闭环）· 知识库演示 vault（只读索引）·
//     自媒体一母多版+人工审核+发布占位+指标 · 内置「TodoDesk 上手之旅」演示样课（自包含，不依赖外部资产）；
//     演示内不确认样课（确认入口留给用户体验）；
//   - 使用**已构建**的 Electron 产物（out/main + out/renderer），不运行 npm run dev、不打开生产 App；
//   - 退出码：隔离/前置断言失败 = 2；构建或播种失败 = 3；未捕获异常 = 1；Electron 真实退出码透传
//     （信号死亡 = 1、启动失败 = 2）；正常/异常退出均清理临时目录（SIGKILL 除外）。
//
// 用法（仓库根目录，在真实用户 shell 中运行——脚本按当前 HOME 定位真实样课资产）：
//   node apps/desktop/scripts/preview-isolated.mjs
// 前置（如未构建过）：npm run build:web && (cd apps/desktop && node scripts/build.mjs)
// 退出：关闭预览窗口后应用仍驻留菜单栏托盘（macOS 行为）——请从托盘菜单选「退出」（或 Dock 右键退出），
//       也可直接在终端按 Ctrl+C；Electron 进程退出后临时目录自动清理。
//       想保留现场检查：KEEP=1 node apps/desktop/scripts/preview-isolated.mjs（脚本会打印临时目录路径，手动删除即可）。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { build } from 'esbuild';

const repo = resolve(new URL('../../../', import.meta.url).pathname);

// ---------- 隔离红线：同一新建临时目录 + realpath 段级硬断言（启动任何子进程之前） ----------
const work = mkdtempSync(join(tmpdir(), 'td-preview-'));
const dbPath = join(work, 'preview.db');
const home = join(work, 'home');
const userData = join(work, 'userData');
const vaultRoot = join(work, 'demo-vault');
const workReal = realpathSync(work);
const realHome = realpathSync(homedir());
const realTmp = realpathSync(resolve(tmpdir()));
const realOrNull = (p) => (existsSync(p) ? realpathSync(p) : null);
const realAppSupport = realOrNull(join(realHome, 'Library', 'Application Support'));
const realKb = realOrNull(join(realHome, 'Desktop', 'knowledge-base'));
const realCourses = realOrNull(join(realHome, 'Library', 'Application Support', 'tododesk', 'courses'));

const keep = process.env.KEEP === '1';
let electronApp = null;
const cleanup = () => {
  if (electronApp) { try { electronApp.kill('SIGKILL'); } catch { /* 已退出 */ } }
  if (!keep) rmSync(work, { recursive: true, force: true });
  console.log(keep ? `[preview] 已保留现场：${work}（检查后手动删除）` : '[preview] 临时目录已清理');
};
// 未捕获异常处理器在任何可能抛错的步骤之前注册：任何崩溃都清理临时目录并以非零退出
process.on('uncaughtException', (e) => {
  console.error(`[preview] 未捕获异常：${e instanceof Error ? e.message : e}`);
  cleanup();
  process.exit(1);
});

// 段级包含：child 必须真在 parent 之内（同一字符串空间），同级前缀目录（td-preview-x-evil）不通过
const inside = (child, parent) => {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};
const failFast = (msg, code = 2) => {
  console.error(`[preview] ${msg}`);
  rmSync(work, { recursive: true, force: true });
  process.exit(code);
};

// 区域校验（realpath 空间，防符号链接绕过）
if (!inside(workReal, realTmp)) failFast(`隔离断言失败：临时目录不在系统临时区（realpath=${workReal}）`);
if (inside(workReal, realHome) || workReal === realHome) failFast(`隔离断言失败：临时目录位于真实 HOME 内（${workReal}）`);
for (const [label, forbidden] of [['Application Support', realAppSupport], ['真实 knowledge-base vault', realKb], ['真实课程资产目录', realCourses]]) {
  if (forbidden && (inside(workReal, forbidden) || workReal === forbidden)) failFast(`隔离断言失败：临时目录命中${label}（${forbidden}）`);
}
// 同目录校验（lexical 空间：各路径均由同一 work 字符串拼接）
for (const p of [dbPath, home, userData, vaultRoot]) {
  if (!inside(p, work)) failFast(`隔离断言失败：${p} 不在同一临时目录（段级校验未通过）`);
}
mkdirSync(home, { recursive: true });
mkdirSync(userData, { recursive: true });
const isolatedEnv = {
  PATH: process.env.PATH,
  TMPDIR: process.env.TMPDIR, // 透传：子进程 os.tmpdir() 需与主进程同一临时区，路径断言才不误判
  HOME: home,
  TODODESK_DB: dbPath,
  TODODESK_USER_DATA: userData,
};
if (isolatedEnv.HOME === realHome || !inside(isolatedEnv.TODODESK_DB, work)) {
  failFast('隔离断言失败：子进程环境断言未通过（隔离缺失即拒绝启动）');
}

// ---------- 前置检查：必须使用已构建产物（不跑 dev、不开生产 App） ----------
const builtMain = join(repo, 'apps/desktop/out/main/index.js');
const builtRenderer = join(repo, 'apps/desktop/out/renderer/index.html');
if (!existsSync(builtMain) || !existsSync(builtRenderer)) {
  failFast('未找到已构建产物（out/main/index.js 或 out/renderer/index.html）。请先构建：npm run build:web && (cd apps/desktop && node scripts/build.mjs)');
}

// ---------- 演示数据播种（共享模块 demo-seed；构建或播种失败也清理并以非零退出） ----------
try {
  const seedCjs = join(work, 'demo-seed.cjs');
  await build({
    entryPoints: [join(repo, 'apps/desktop/scripts/demo-seed.ts')],
    outfile: seedCjs,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['node:*'],
    logLevel: 'silent',
  });
  await new Promise((res, rej) => {
    const seedRun = spawn(process.execPath, [seedCjs, dbPath, work], { env: isolatedEnv, stdio: ['ignore', 'inherit', 'inherit'] });
    seedRun.on('exit', (code) => (code === 0 ? res() : rej(new Error(`演示数据写入失败：exit ${code}`))));
  });
} catch (e) {
  console.error(`[preview] ${e instanceof Error ? e.message : e}`);
  cleanup();
  process.exit(3);
}

// ---------- 启动已构建 Electron（隔离环境） ----------
const electronBin = join(repo, 'node_modules', '.bin', 'electron');
if (!existsSync(electronBin)) failFast('未找到 electron 可执行文件');
electronApp = spawn(electronBin, ['.'], { cwd: join(repo, 'apps/desktop'), stdio: ['ignore', 'inherit', 'inherit'], env: isolatedEnv });

console.log('━━━━━━━━ TodoDesk 隔离预览（四模块演示沙盒） ━━━━━━━━');
console.log('  临时目录 ：' + work + '（库/家目录/演示 vault/课程资产全在其中）');
console.log('  样课来源 ：内置「TodoDesk 上手之旅」演示课程（自包含，不依赖任何外部资产）');
console.log('  演示内容 ：');
console.log('    · 新闻：旧闻 2 条（含 1 收藏）· 已完成任务（2 条 agent 新闻）· 待执行任务（可在面板亲手「新建任务」）');
console.log('    · 知识库：「演示知识库」vault 已注册并扫描（3 篇笔记，wikilink 互联；只读索引，不写真实 Obsidian）');
console.log('    · 自媒体：选题→母稿→双平台版本；小红书版已审核通过并排期+手动发布占位+指标；公众号版停在「待人工审核」等你亲自通过/拒绝');
console.log('    · 课程：内置演示样课已导入，绑定「【演示】TodoDesk 五天上手计划」，样课未确认——确认入口留给你体验');
console.log('  看什么   ：左侧导航「新闻 / 知识库 / 自媒体」；课程入口在「学习计划」页对应计划的「关联课程」区');
console.log('  退出     ：关闭窗口后应用仍驻留菜单栏托盘（macOS）——请从托盘菜单「退出」，');
console.log('            或在本终端按 Ctrl+C；退出后临时目录自动清理' + (keep ? '（KEEP=1：保留，需手动删除）' : '') + '。');

process.on('SIGINT', () => {
  if (electronApp) {
    try { electronApp.kill('SIGTERM'); } catch { /* 已退出 */ }
    setTimeout(() => { try { electronApp.kill('SIGKILL'); } catch { /* 已退出 */ } }, 4000);
  }
});
electronApp.on('error', (e) => {
  console.error(`[preview] Electron 启动失败：${e instanceof Error ? e.message : e}`);
  cleanup();
  process.exit(2);
});
electronApp.on('exit', (code) => {
  cleanup();
  // 真实退出码透传；被信号杀死（code === null）按非零处理，绝不把异常退出报成 0
  const real = code === null ? 1 : code;
  console.log(`[preview] Electron 已退出（code ${code ?? 'signal'}），预览结束`);
  process.exit(real);
});
