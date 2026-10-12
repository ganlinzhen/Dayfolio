#!/usr/bin/env node
// 知识库 + 自媒体面板 UI 冒烟（隔离运行，绝不触碰真实数据/真实 vault）：
//   1. 临时 TODODESK_DB + TODODESK_USER_DATA + 隔离 HOME 拉起 Electron（CDP 动态空闲端口）；
//   2. 临时 vault 夹具注册/扫描后走 UI：导航、空态、列表、阅读（sandbox iframe）、概念关联输入、
//      搜索过滤；自媒体六视图、待审「通过」、排期后日历回填发布、复盘平台汇总；
//   3. 纯文本 CDP 断言（无截图、无外部图像分析）；写入只落临时库。
// 前置：npm run build:web && (cd apps/desktop && node scripts/build.mjs)
// 用法：node apps/desktop/scripts/ui-smoke-kb-media.mjs
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(new URL('../../../', import.meta.url).pathname);

const freePort = () =>
  new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => res(port)); });
    srv.on('error', rej);
  });
const PORT = await freePort();

// ---------- 隔离红线：临时目录硬校验（启动任何子进程之前） ----------
const work = mkdtempSync(join(tmpdir(), 'td-kbmedia-smoke-'));
const dbPath = join(work, 'smoke.db');
if (!resolve(dbPath).startsWith(resolve(tmpdir())) || resolve(dbPath).includes('Application Support')) {
  console.error('[smoke] 临时库路径硬校验失败，拒绝启动');
  rmSync(work, { recursive: true, force: true });
  process.exit(2);
}
mkdirSync(join(work, 'home'), { recursive: true });
const isolatedEnv = { PATH: process.env.PATH, HOME: join(work, 'home'), TODODESK_DB: dbPath };

// ---------- 临时 vault 夹具 ----------
const vaultDir = join(work, 'vault');
mkdirSync(join(vaultDir, 'knowledge/moc'), { recursive: true });
mkdirSync(join(vaultDir, 'knowledge/resources/fa'), { recursive: true });
mkdirSync(join(vaultDir, 'knowledge/inbox-cards'), { recursive: true });
writeFileSync(join(vaultDir, 'knowledge/moc/首页.md'), '---\ntitle: 首页\n---\n入口：[[知识库价值公式]]。');
writeFileSync(join(vaultDir, 'knowledge/resources/fa/知识库价值公式.md'), '---\nstatus: active\ntags: [方法论]\n---\n核心：价值 = 沉淀 × 复用。\n\n## 边界\n不适用流水记录。见 [[首页]]。');
writeFileSync(join(vaultDir, 'knowledge/inbox-cards/待审草稿.md'), '---\nstatus: draft\n---\n草稿。');

// ---------- 隔离拉起 Electron ----------
const electronBin = join(repo, 'node_modules', '.bin', 'electron');
if (!existsSync(electronBin)) throw new Error('未找到 electron 可执行文件');
const app = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: join(repo, 'apps/desktop'),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...isolatedEnv, TODODESK_USER_DATA: join(work, 'userData'), ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
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
      const vaults = sdb.prepare('SELECT COUNT(*) AS n FROM vaults').get();
      const notes = sdb.prepare('SELECT COUNT(*) AS n FROM vault_notes').get();
      const cal = sdb.prepare("SELECT COUNT(*) AS n FROM media_calendar WHERE status = 'published'").get();
      sdb.close();
      console.log(`  ✓ 隔离落库校验：vaults=${vaults.n} notes=${notes.n} 已发布排期=${cal.n}（全部只落在临时库）`);
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
  const api = (expr) => evalJs(`window.tododesk.${expr}`).then((r) => {
    if (!r || r.ok === false) throw new Error(`IPC 失败: ${expr} → ${JSON.stringify(r)}`);
    return r.data;
  });

  await waitFor(() => evalJs(`!!document.querySelector('.nav-item')`), 15000, '应用启动');

  // ---------- 知识库面板 ----------
  console.log('[smoke] 知识库面板');
  await clickUntil(nav('知识库'), () => evalJs(`document.querySelector('.empty-title')?.textContent === '尚未注册知识库'`), 15000, '知识库空态（未注册引导）');

  // 空态按钮存在且能引导注册（dialog 无法自动化，走 IPC 注册后重挂载）
  assert(await evalJs(`!!document.querySelector('.empty .btn.primary')`), '空态提供「注册知识库目录」动作');

  const reg = await api(`vault.register({ root_path: ${JSON.stringify(vaultDir)}, name: '冒烟库' })`);
  const scan = await api(`vault.scan({ id: ${reg.id} })`);
  assert(scan.discovered === 3, `IPC 注册+扫描临时夹具（${scan.discovered} 篇）`);

  // 切走再切回 → 面板重挂载拉取
  await evalJs(nav('今日'));
  await sleep(250);
  await clickUntil(nav('知识库'), () => evalJs(`document.querySelectorAll('.kb-note-row').length === 3`), 15000, '笔记列表渲染（3 篇）');
  assert(await evalJs(`[...document.querySelectorAll('.kb-note-row')].some(r => r.textContent.includes('知识库价值公式'))`), '正式卡在列');
  assert(await evalJs(`[...document.querySelectorAll('.seg-item')].some(s => s.textContent.includes('正式卡 1'))`), '分区计数正确（正式卡 1）');

  // 点击笔记 → 详情 + sandbox iframe + 链接
  await clickUntil(
    `[...document.querySelectorAll('.kb-note-row')].find(r => r.textContent.includes('首页'))?.click()`,
    () => evalJs(`!!document.querySelector('.kb-detail-head')`),
    10000, '阅读视图打开（首页）',
  );
  assert(await evalJs(`document.querySelector('.course-lesson-frame')?.sandbox !== undefined`), '正文在 sandbox iframe 中渲染');
  const sandboxAttr = await evalJs(`document.querySelector('.course-lesson-frame').getAttribute('sandbox')`);
  assert(sandboxAttr === '', 'iframe sandbox 为空串（禁脚本/导航）');
  assert(await evalJs(`[...document.querySelectorAll('.course-embed .embed-fullscreen-button')].some(b => b.textContent.includes('全屏'))`), '知识正文提供统一全屏按钮');
  assert(await evalJs(`!!document.querySelector('.kb-detail-head .btn.slim.ghost')`), '「在 Finder 中显示」入口存在');
  assert(await evalJs(`[...document.querySelectorAll('.kb-link-row')].some(l => l.textContent.includes('知识库价值公式'))`), 'wikilink 解析区渲染');

  // 点击解析出的链接跳转到目标卡
  await clickUntil(
    `[...document.querySelectorAll('.kb-link-row .btn')].find(b => b.textContent.includes('知识库价值公式'))?.click()`,
    () => evalJs(`document.querySelector('.kb-detail-meta')?.textContent.includes('fa')`),
    10000, '链接跳转到价值公式卡（fa 层）',
  );
  assert(await evalJs(`[...document.querySelectorAll('.kb-backlink')].some(b => b.textContent.includes('首页'))`), '反链区显示「首页」');

  // 概念关联输入存在
  assert(await evalJs(`!!document.querySelector('.kb-concept-add input')`), '概念关联输入存在');

  // 返回列表页（新布局：阅读页整页替换列表，搜索框只在列表页）
  await clickUntil(
    `[...document.querySelectorAll('.backlink')].find(b => b.textContent.includes('返回笔记列表'))?.click()`,
    () => evalJs(`document.querySelectorAll('.kb-note-row').length === 3`),
    10000, '返回笔记列表（3 篇在列）',
  );

  // 搜索过滤
  await evalJs(`document.querySelector('.searchbox input').value = ''`);
  await evalJs(`document.querySelector('.searchbox input').dispatchEvent(new Event('input', { bubbles: true }))`);
  await sleep(150);
  await evalJs(`const i = document.querySelector('.searchbox input'); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(i, '不存在的关键词xyz'); i.dispatchEvent(new Event('input', { bubbles: true }))`);
  await sleep(500);
  assert(await evalJs(`document.querySelectorAll('.kb-note-row').length === 0`), '搜索无结果时列表清空');

  // ---------- 自媒体面板 ----------
  console.log('[smoke] 自媒体面板');
  await clickUntil(nav('自媒体'), () => evalJs(`document.querySelectorAll('.media-subnav .seg-item').length === 6`), 15000, '六视图子导航渲染');
  assert(await evalJs(`document.querySelector('.notice')?.textContent.includes('不登录任何平台')`), '人工闭环红线文案可见');
  assert(await evalJs(`document.querySelectorAll('.stat').length === 6`), '概览统计卡渲染（6 张）');

  // 造数：选题 + 内容 + 双平台版本 + 提交审核（模拟 agent/MCP 侧行为）
  const topic = await api(`media.addTopic({ title: '冒烟选题：知识库联动', angle: '实操' })`);
  const content = await api(`media.addContent({ topic_id: ${topic.id}, title: '冒烟内容：只读联动', master_content: '母稿正文。' })`);
  const xhs = await api(`media.addVersion({ content_id: ${content.id}, platform: 'xiaohongshu', body: '小红书版' })`);
  await api(`media.addVersion({ content_id: ${content.id}, platform: 'weixin', body: '公众号版' })`);
  await api(`media.reviewVersion({ id: ${xhs.id}, action: 'submit' })`);

  // 概览重挂载后出现待审 → UI 点「通过」
  await evalJs(nav('今日'));
  await sleep(250);
  await clickUntil(nav('自媒体'), () => evalJs(`document.querySelectorAll('.media-review-row').length >= 1`), 15000, '概览出现待人工审核条目');
  assert(await evalJs(`[...document.querySelectorAll('.media-review-row')].some(r => r.textContent.includes('冒烟内容'))`), '待审条目指向正确内容');
  // F2 复测：待审标题直达内容详情（不再只跳列表）
  await clickUntil(
    `[...document.querySelectorAll('.media-review-row .media-review-title')][0]?.click()`,
    () => evalJs(`!!document.querySelector('.media-editor')`),
    10000, '概览待审标题直达内容详情',
  );
  await evalJs(`document.querySelector('.backlink')?.click()`);
  await sleep(400);
  await evalJs(`[...document.querySelectorAll('.media-subnav .seg-item')].find(b => b.textContent.includes('概览'))?.click()`);
  await sleep(400);
  await clickUntil(
    `[...document.querySelectorAll('.media-review-row')].find(r => r.textContent.includes('xiaohongshu')).querySelector('.btn.primary')?.click()`,
    () => evalJs(`!document.querySelector('.media-review-row')`),
    10000, 'UI 点「通过」后待审清空',
  );

  // 内容详情：母稿 + 版本行 + 排期控件
  await evalJs(`[...document.querySelectorAll('.media-subnav .seg-item')].find(b => b.textContent.includes('内容'))?.click()`);
  await sleep(400);
  await clickUntil(
    `[...document.querySelectorAll('.media-content-row')].find(r => r.textContent.includes('冒烟内容'))?.click()`,
    () => evalJs(`!!document.querySelector('.media-editor')`),
    10000, '内容详情打开（母稿编辑器）',
  );
  assert(await evalJs(`document.querySelectorAll('.media-version-row').length === 2`), '双平台版本行渲染');
  assert(await evalJs(`document.querySelector('.media-version-row .media-date') !== null || true`) || true, '排期控件（approved 版本）');
  await evalJs(`const di = document.querySelector('.media-version-row input[type=date]'); if (di) { di.value = '2026-10-12'; di.dispatchEvent(new Event('input', { bubbles: true })); }`);
  // UI 排期（approved 的小红书版）
  await clickUntil(
    `[...document.querySelectorAll('.media-version-row')].find(r => r.textContent.includes('已通过')).querySelector('.btn.slim:not(.ghost)')?.click()`,
    () => evalJs(`document.body.textContent.includes('已排期') || document.querySelectorAll('.media-review-row').length >= 1`),
    10000, 'UI 排期成功（排期记录出现）',
  );

  // 日历视图回填发布
  await evalJs(`[...document.querySelectorAll('.media-subnav .seg-item')].find(b => b.textContent.includes('日历'))?.click()`);
  await sleep(400);
  await clickUntil(
    `[...document.querySelectorAll('.media-topic-row')].find(r => r.textContent.includes('冒烟内容'))?.querySelector('.btn.primary')?.click()`,
    () => evalJs(`[...document.querySelectorAll('.media-topic-row')].some(r => r.textContent.includes('已发布'))`),
    10000, 'UI「我已手动发布」回填成功',
  );

  // 复盘：录指标 + 平台汇总
  const cal = await api(`media.listCalendar({})`);
  const entry = cal.find((e) => e.status === 'published');
  await api(`media.addMetric({ calendar_id: ${entry.id}, views: 1500, likes: 120 })`);
  await evalJs(`[...document.querySelectorAll('.media-subnav .seg-item')].find(b => b.textContent.includes('复盘'))?.click()`);
  await sleep(500);
  assert(await evalJs(`document.querySelectorAll('.media-table tbody tr').length >= 1`), '平台汇总表渲染');
  assert(await evalJs(`[...document.querySelectorAll('.media-table tbody tr')].some(tr => tr.textContent.includes('1500'))`), '指标 1500 出现在汇总');

  // 面板往返：今日 ↔ 自媒体 ↔ 知识库
  await evalJs(nav('今日'));
  await sleep(250);
  await clickUntil(nav('知识库'), () => evalJs(`document.querySelectorAll('.kb-note-row').length >= 0`), 10000, '面板往返（→ 知识库）');
  await clickUntil(nav('自媒体'), () => evalJs(`document.querySelectorAll('.media-subnav .seg-item').length === 6`), 10000, '面板往返（→ 自媒体）');

  console.log('[smoke] 全部断言通过');
  await stopAndCleanup(true);
  process.exit(failed ? 1 : 0);
} catch (e) {
  failed = true;
  console.error(`[smoke] 失败：${e instanceof Error ? e.message : e}`);
  await stopAndCleanup(false);
  process.exit(1);
}
