#!/usr/bin/env node
// 预览沙盒演示数据 UI 冒烟（隔离运行，绝不触碰真实数据）：
//   用共享播种模块 demo-seed 预置四模块闭环 → 拉起已构建 Electron（CDP 动态空闲端口）→
//   纯文本断言：新闻（任务/24h）、知识库（3 篇演示笔记）、自媒体（六视图/待审/复盘指标）、
//   课程（内置演示样课入口/正文/未确认）、隔离落库校验；可指定 TODODESK_SMOKE_SCREENSHOT 保存演示截图。
// 前置：npm run build:web && (cd apps/desktop && node scripts/build.mjs)
// 用法：node apps/desktop/scripts/ui-smoke-demo.mjs
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { homedir } from 'node:os';

const repo = resolve(new URL('../../../', import.meta.url).pathname);

const freePort = () =>
  new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => res(port)); });
    srv.on('error', rej);
  });
const PORT = await freePort();

// ---------- 隔离红线：同一临时目录 + 硬断言（启动任何子进程之前） ----------
const work = mkdtempSync(join(tmpdir(), 'td-demo-smoke-'));
const workAbs = resolve(work);
const dbPath = join(work, 'smoke.db');
const realHome = homedir();
if (
  !workAbs.startsWith(resolve(tmpdir())) ||
  workAbs.startsWith(join(realHome, 'Library', 'Application Support')) ||
  workAbs === realHome ||
  workAbs.startsWith(join(realHome, 'Desktop', 'knowledge-base'))
) {
  console.error('[smoke] 隔离断言失败：临时目录异常或命中真实数据区，拒绝启动');
  rmSync(work, { recursive: true, force: true });
  process.exit(2);
}
mkdirSync(join(work, 'home'), { recursive: true });
mkdirSync(join(work, 'userData'), { recursive: true });
const isolatedEnv = {
  PATH: process.env.PATH,
  TMPDIR: process.env.TMPDIR, // 透传：子进程 os.tmpdir() 需与主进程同一临时区，路径断言才不误判
  HOME: join(work, 'home'),
  TODODESK_DB: dbPath,
  TODODESK_USER_DATA: join(work, 'userData'),
};
if (isolatedEnv.HOME === realHome || !isolatedEnv.TODODESK_DB.startsWith(workAbs)) {
  console.error('[smoke] 子进程环境断言失败（隔离缺失即拒绝启动）');
  rmSync(work, { recursive: true, force: true });
  process.exit(2);
}

// ---------- 播种（共享模块 demo-seed；内置演示课程，不依赖机器真实资产） ----------
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
  const seedRun = spawn(process.execPath, [seedCjs, dbPath, workAbs], { env: isolatedEnv, stdio: ['ignore', 'inherit', 'inherit'] });
  seedRun.on('exit', (code) => (code === 0 ? res() : rej(new Error(`播种失败：exit ${code}（demo-seed 入口路径断言拒绝，见上方输出）`))));
}).catch((e) => {
  // 播种失败也必须清理临时目录（此段在主 try 之前，需自行兜底）
  rmSync(work, { recursive: true, force: true });
  console.error(`[smoke] 失败：${e instanceof Error ? e.message : e}`);
  process.exit(1);
});

// ---------- 隔离拉起 Electron ----------
const electronBin = join(repo, 'node_modules', '.bin', 'electron');
if (!existsSync(electronBin)) throw new Error('未找到 electron 可执行文件');
const app = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: join(repo, 'apps/desktop'),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: isolatedEnv,
});
let stderrTail = '';
app.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-2000); });
process.on('SIGPIPE', () => {});
let emergency = null;
process.on('uncaughtException', (e) => {
  console.error(`[smoke] 未捕获异常：${e instanceof Error ? e.message : e}`);
  if (!emergency) emergency = stopAndCleanup();
  emergency.finally(() => process.exit(1));
});

const waitFor = async (fn, ms, label) => {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* 重试 */ }
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${label}\n${stderrTail}`);
    await new Promise((r) => setTimeout(r, 300));
  }
};

let failed = false;
let stoppedOnce = false;
const stopAndCleanup = async (runDbCheck = false) => {
  if (stoppedOnce) return;
  stoppedOnce = true;
  await new Promise((resolveStop) => {
    if (app.exitCode !== null || app.signalCode !== null) return resolveStop();
    const killTimer = setTimeout(() => { try { app.kill('SIGKILL'); } catch { /* 已退出 */ } }, 5000);
    app.once('exit', () => { clearTimeout(killTimer); resolveStop(); });
    app.kill('SIGTERM');
  });
  if (runDbCheck && !failed) {
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const sdb = new DatabaseSync(dbPath, { readOnly: true });
      const one = (sql) => Number(sdb.prepare(sql).get().n);
      const vaults = one('SELECT COUNT(*) AS n FROM vaults');
      const notes = one('SELECT COUNT(*) AS n FROM vault_notes');
      const published = one("SELECT COUNT(*) AS n FROM media_calendar WHERE status = 'published'");
      const inReview = one("SELECT COUNT(*) AS n FROM media_content_versions WHERE status = 'in_review'");
      const news = one('SELECT COUNT(*) AS n FROM news');
      const courses = one('SELECT COUNT(*) AS n FROM courses');
      const confirmed = one('SELECT COUNT(*) AS n FROM courses WHERE sample_confirmed_at IS NOT NULL');
      const assetOk = existsSync(join(workAbs, 'courses/tododesk-tour/lessons/0001-quick-tour.html'));
      sdb.close();
      console.log(`  ✓ 隔离落库校验：vaults=${vaults} notes=${notes} 已发布排期=${published} 待审版本=${inReview} news=${news} courses=${courses}（样课已确认=${confirmed}，须为 0；课程资产在临时区=${assetOk}）`);
      if (confirmed !== 0 || !assetOk) throw new Error('红线校验失败');
    } catch (e) {
      failed = true;
      console.error(`  ✗ 隔离落库校验失败：${e.message}`);
    }
  }
  rmSync(work, { recursive: true, force: true });
  console.log('[smoke] Electron 已停止，临时目录已清理');
};

try {
  const page = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    return list.find((t) => t.type === 'page');
  }, 30000, 'CDP 页面 target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) =>
    new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error('页面执行失败: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  };
  await send('Page.enable');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const assert = (cond, label) => {
    if (!cond) throw new Error('断言失败：' + label);
    console.log(`  ✓ ${label}`);
  };
  const clickUntil = async (clickExpr, readyFn, ms, label) => {
    const t0 = Date.now();
    for (;;) {
      try { await evalJs(clickExpr); } catch { /* 目标未渲染，稍后重试 */ }
      try { if (await readyFn()) return; } catch { /* 就绪条件评估失败，重试 */ }
      if (Date.now() - t0 > ms) throw new Error(`点击超时：${label}\n${stderrTail}`);
      await sleep(400);
    }
  };
  const nav = (label) =>
    `[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('${label}'))?.click()`;
  await waitFor(() => evalJs(`!!document.querySelector('.nav-item')`), 15000, '应用启动');

  // ---------- 新闻（agent-only） ----------
  console.log('[smoke] 新闻（agent 任务闭环）');
  await clickUntil(nav('新闻'), () => evalJs(`document.querySelectorAll('.news3-row').length === 4`), 15000, '新闻列表（4 条演示数据：2 旧版 + 2 agent）');
  await clickUntil(
    `[...document.querySelectorAll('.news3-toolbar button')].find(b => b.textContent.includes('AI 采集'))?.click()`,
    () => evalJs(`document.querySelectorAll('.news3-request').length === 2`),
    15000, '采集请求卡渲染（已完成 + 待执行）',
  );
  assert(await evalJs(`[...document.querySelectorAll('.news3-request-status')].some(s => s.textContent.includes('等待 AI'))`), '待执行任务可见（离线不唤醒）');
  await clickUntil(
    `[...document.querySelectorAll('.news3-back')].find(b => b.textContent.includes('返回新闻'))?.click()`,
    () => evalJs(`!!document.querySelector('[aria-label="新闻列表页"]')`),
    10000, '返回新闻列表',
  );

  // ---------- 知识库（演示 vault 只读索引） ----------
  console.log('[smoke] 知识库（演示 vault）');
  await clickUntil(nav('知识库'), () => evalJs(`document.querySelectorAll('.kb-note-row').length === 3`), 15000, '演示笔记列表（3 篇）');
  assert(await evalJs(`[...document.querySelectorAll('.kb-note-row')].some(r => r.textContent.includes('演示·知识库价值公式'))`), '演示卡片在列');

  // ---------- 自媒体（一母多版 + 人工审核 + 发布占位 + 指标） ----------
  console.log('[smoke] 自媒体（人工闭环）');
  await clickUntil(nav('自媒体'), () => evalJs(`document.querySelectorAll('.media-subnav .seg-item').length === 6`), 15000, '六视图子导航渲染');
  await clickUntil(nav('今日'), () => Promise.resolve(true), 5000, '面板切换');
  await sleep(250);
  await clickUntil(nav('自媒体'), () => evalJs(`document.querySelectorAll('.media-review-row').length >= 1`), 15000, '概览出现待人工审核（演示公众号版）');
  assert(await evalJs(`[...document.querySelectorAll('.media-review-row')].some(r => r.textContent.includes('演示'))`), '待审条目为演示内容');
  await evalJs(`[...document.querySelectorAll('.media-subnav .seg-item')].find(b => b.textContent.includes('复盘'))?.click()`);
  await sleep(500);
  assert(await evalJs(`document.body.textContent.includes('1500')`), '已发布占位的演示指标（1500 阅读）出现在复盘');

  // ---------- 课程（内置演示样课，未确认） ----------
  console.log('[smoke] 课程（内置演示样课）');
  await clickUntil(nav('学习计划'), () => evalJs(`[...document.querySelectorAll('.plan-card')].some(c => c.textContent.includes('TodoDesk 五天上手计划'))`), 15000, '学习计划页出现演示计划卡');
  await clickUntil(
    `[...document.querySelectorAll('.study-home-tabs button')].find(b => b.textContent === '课程')?.click()`,
    () => evalJs(`[...document.querySelectorAll('.plan-course-entry')].some(c => c.textContent.includes('TodoDesk 上手之旅'))`),
    15000, '课程子视图出现演示课程入口',
  );
  await clickUntil(
    `[...document.querySelectorAll('.plan-course-entry')].find(c => c.textContent.includes('TodoDesk 上手之旅'))?.click()`,
    () => evalJs(`document.querySelector('.panel h1')?.textContent?.includes('TodoDesk 上手之旅')`),
    15000, '进入演示课程页',
  );
  assert(await evalJs(`document.body.textContent.includes('第 1 天') || document.body.textContent.includes('Day 1') || document.querySelectorAll('.course-card').length >= 1`), 'Day1 样课卡在列');
  assert(await evalJs(`!document.body.textContent.includes('已确认样课')`), '样课未确认（确认入口留给用户，演示不代确认）');

  // ---------- 公开接入说明与构建版本 ----------
  const { version } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  assert(await evalJs(`document.querySelector('.nav-item-version')?.textContent?.trim() === ${JSON.stringify(`v${version}`)}`), '界面版本来自当前 package.json');
  await clickUntil(nav('帮助'), () => evalJs(`!!document.querySelector('.help-toc')`), 15000, '帮助面板');
  await clickUntil(
    `[...document.querySelectorAll('.help-toc-item')].find(b => b.textContent.includes('MCP 与 AI 接入'))?.click()`,
    () => evalJs(`document.querySelector('.help-doc-title')?.textContent === 'MCP 与 AI 接入'`),
    10000, 'MCP 接入帮助',
  );
  assert(await evalJs(`document.querySelector('.help-article')?.textContent?.includes('Node 22.13+') && !document.querySelector('.help-article')?.textContent?.includes('本机已完成注册')`), '公开帮助说明运行要求，不冒称已注册');

  if (process.env.TODODESK_SMOKE_SCREENSHOT) {
    await clickUntil(nav('今日'), () => evalJs(`document.querySelector('.panel h1')?.textContent === '今日'`), 15000, '今日演示页');
    await sleep(500);
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    if (!screenshot.result?.data) throw new Error('演示截图失败');
    const destination = resolve(process.env.TODODESK_SMOKE_SCREENSHOT);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, Buffer.from(screenshot.result.data, 'base64'));
    console.log(`[smoke] 演示截图：${destination}`);
  }
  console.log('[smoke] 全部断言通过');
  await stopAndCleanup(true);
  process.exit(failed ? 1 : 0);
} catch (e) {
  failed = true;
  console.error(`[smoke] 失败：${e instanceof Error ? e.message : e}`);
  await stopAndCleanup(false);
  process.exit(1);
}
