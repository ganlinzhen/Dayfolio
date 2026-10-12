#!/usr/bin/env node
// 课程×学习计划联动 UI 冒烟（隔离运行，不改真实数据）：
//   1. 打包 core 并在临时库播种两门课：
//      A「冒烟课程」：五天计划，样课确认+请求+认领后导入第 1~2 天（第 3~5 天待生成）；
//      B「上手之旅样课课程」：绑定自己的五天计划，仅导入 Day1 样课（后四天绝不生成），未读未确认；
//   2. 以临时 TODODESK_DB + TODODESK_USER_DATA + 隔离 HOME 拉起 Electron（CDP 用动态空闲端口，
//      杜绝与残留 Electron/他人 dev 窗口 9223 的端口碰撞）；
//   3. CDP 纯文本断言（无截图、无图像分析）。侧栏仅「学习计划」，首页右侧「计划 / 课程」切换：
//      默认计划页只显示计划；课程页集中显示两门课程；计划详情每日摘要卡（未生成显示待生成）；
//      摘要卡直达当天完整讲义→返回计划详情（选择与滚动位置保留）；「进入课程总览」仍可达（面板内）；
//      总览卡→正文→返回总览；样课后四天待生成；样课确认入口仍在（window.confirm 由 CDP 自动接受）；
//      以及确认只落临时库的隔离断言。
// 前置：npm run build:web && (cd apps/desktop && node scripts/build.mjs)
// 用法：node apps/desktop/scripts/ui-smoke-course.mjs
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(new URL('../../../', import.meta.url).pathname);

// 动态空闲端口：固定端口会与残留 Electron / 他人调试窗口碰撞（CDP 连错窗口，断言全部失真）。
// 取口后到 Electron 绑定之间存在毫秒级 TOCTOU 窗口，碰撞概率可忽略；若绑定失败启动断言会拦下。
const freePort = () =>
  new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => res(port)); });
    srv.on('error', rej);
  });
const PORT = await freePort();

// ---------- 隔离红线：临时目录硬校验（启动任何子进程之前） ----------
const work = mkdtempSync(join(tmpdir(), 'td-app-smoke-'));
const dbPath = join(work, 'smoke.db');
if (!resolve(dbPath).startsWith(resolve(tmpdir())) || resolve(dbPath).includes('Application Support')) {
  console.error('[smoke] 临时库路径硬校验失败，拒绝启动');
  rmSync(work, { recursive: true, force: true });
  process.exit(2);
}
// 每级子进程统一显式环境：临时 TODODESK_DB + 独立 HOME（Chromium 配置/缓存全进临时家目录）
const isolatedEnv = { PATH: process.env.PATH, HOME: join(work, 'home'), TODODESK_DB: dbPath };
mkdirSync(join(work, 'home'), { recursive: true });

// ---------- 1. 打包 core 并播种 ----------
const coreBundle = join(work, 'core.cjs');
const esbuildBin = join(repo, 'node_modules', '.bin', 'esbuild');
const b = spawnSync(esbuildBin, [
  join(repo, 'packages/core/src/index.ts'), '--bundle', '--platform=node', '--format=cjs',
  `--outfile=${coreBundle}`, '--external:node:*', '--log-level=error',
], { env: isolatedEnv });
if (b.status !== 0) throw new Error(`core 打包失败: ${b.stderr}`);

const seed = `
const { createCore, openNodeSqliteDb } = require(${JSON.stringify(coreBundle)});
const core = createCore(openNodeSqliteDb(${JSON.stringify(dbPath)}), { dbPath: ${JSON.stringify(dbPath)} });
const fs = require('node:fs');
const mkPkg = (stage, slug, title, planId, lessons, version, withOverview = true) => {
  fs.mkdirSync(stage + '/lessons', { recursive: true });
  fs.mkdirSync(stage + '/assets', { recursive: true });
  fs.writeFileSync(stage + '/assets/style.css', ':root{--smoke-ink:#10254d}.lesson-banner{color:#fff;background:linear-gradient(135deg,#10254d,#1a56db)}');
  if (withOverview) fs.writeFileSync(stage + '/overview.html', '<h1>独立课程总览</h1><p>这不是第一天讲义。</p><script>alert(1)</script>');
  for (const l of lessons) fs.writeFileSync(stage + '/lessons/' + l.file, l.html);
  fs.writeFileSync(stage + '/course.json', JSON.stringify({
    schema_version: withOverview ? 2 : undefined,
    slug, title, goal: '跑通每日卡片', version: version || '1.0.0', plan_id: planId,
    overview: withOverview ? { html: 'overview.html' } : undefined,
    lessons: lessons.map((l) => ({ day: l.day, title: l.title, html: 'lessons/' + l.file, is_sample: !!l.sample })),
  }));
  return stage;
};
const mkPlan = (title, prefix) => core.plans.create({
  title, goal: '验证课程与计划联动', start_date: '2026-10-10', daily_minutes: 45,
  items: [0,1,2,3,4].map((i) => ({ date: '2026-10-1' + i, content: prefix + '第' + (i+1) + '天任务' })),
});
const styleLink = '<link rel="stylesheet" href="../assets/style.css">';

// 课程 A：五天计划，样课 → 确认 → 请求 → 认领 → 导入 1~2 天（3~5 天待生成）
const planA = mkPlan('冒烟五天计划', '');
const stageA = mkPkg(fs.mkdtempSync(require('node:os').tmpdir() + '/td-smoke-a-'), 'smoke-course', '冒烟课程', planA.id, [
  { day: 1, title: '第一天·样课', file: 'd1.html', sample: true, html: '<h1>Day 1 入门</h1>' + styleLink + '<p>样课正文。</p><script>alert(1)</script><img src="https://evil.example.com/x.png">' },
  { day: 2, title: '第二天·进阶', file: 'd2.html', html: '<h1>Day 2 进阶</h1><p>第二课正文。</p>' },
]);
// 课程 B：样课课程——绑定自己的五天计划，仅 Day1 样课，后四天不生成（待用户确认+请求+agent 认领）
const planB = mkPlan('样课五天计划', '样课 ');
const stageB = mkPkg(fs.mkdtempSync(require('node:os').tmpdir() + '/td-smoke-b-'), 'tour-sample', '上手之旅样课课程', planB.id, [
  { day: 1, title: 'TodoDesk 上手全景', file: 'tour-d1.html', sample: true, html: '<h1>Tour Day 1</h1>' + styleLink + '<p>样课正文：五分钟核心能力之旅。</p>' },
], undefined, false);
// staging 只是导入源；导入中途抛错也必须在 finally 清掉，绝不残留 td-smoke-a/b-* 临时目录
try {
  let m = JSON.parse(fs.readFileSync(stageA + '/course.json', 'utf8'));
  m.lessons = [m.lessons[0]]; // 先只导样课天
  fs.writeFileSync(stageA + '/course.json', JSON.stringify(m));
  const r1 = core.courses.importCourse(stageA);
  core.courses.markLessonRead(r1.course.id, 1);
  core.courses.confirmSample(r1.course.id);
  const req = core.courses.createGenerationRequest(r1.course.id, 'app');
  core.courses.claimRequest(req.id, 'smoke-agent');
  // 认领后导入完整包（第 1~2 天；第 1 天与样课逐字节一致，版本升 1.1.0）
  const manifestFull = JSON.parse(fs.readFileSync(stageA + '/course.json', 'utf8'));
  manifestFull.lessons = [
    { day: 1, title: '第一天·样课', html: 'lessons/d1.html', is_sample: true },
    { day: 2, title: '第二天·进阶', html: 'lessons/d2.html' },
  ];
  manifestFull.version = '1.1.0';
  fs.writeFileSync(stageA + '/course.json', JSON.stringify(manifestFull));
  const r2 = core.courses.importCourse(stageA);
  core.courses.markLessonRead(r2.course.id, 2);

  const rb = core.courses.importCourse(stageB);
  console.log('SEED_OK', JSON.stringify({ planA: planA.id, planB: planB.id, courseA: r2.course.id, courseB: rb.course.id, lessonsA: r2.lessons.length, lessonsB: rb.lessons.length, request: req.id }));
} finally {
  for (const s of [stageA, stageB]) fs.rmSync(s, { recursive: true, force: true });
}
`;
const seedPath = join(work, 'seed.cjs');
writeFileSync(seedPath, seed);
const seeded = spawnSync(process.execPath, [seedPath], { encoding: 'utf8', timeout: 60000, env: isolatedEnv });
if (seeded.status !== 0 || !seeded.stdout.includes('SEED_OK')) {
  rmSync(work, { recursive: true, force: true }); // 播种失败也要清掉自己的临时目录（含 td-smoke-a/b 由 seed 的 finally 兜底）
  throw new Error(`播种失败: ${seeded.stderr || seeded.stdout}`);
}
console.log(`[smoke] 播种完成：${seeded.stdout.trim().split('\n').pop()}`);

// ---------- 2. 隔离拉起 Electron（CDP 9224） ----------
const electronBin = join(repo, 'node_modules', '.bin', 'electron');
if (!existsSync(electronBin)) throw new Error('未找到 electron 可执行文件');
const app = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: join(repo, 'apps/desktop'),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...isolatedEnv, TODODESK_USER_DATA: join(work, 'userData'), ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
});
let stderrTail = '';
app.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-2000); });

// 管道消费者（head 等）提前关闭时 stdout 收到 SIGPIPE 会杀死本脚本、跳过 finally、残留 Electron——
// 忽略之，让脚本跑完自己的停机与清理
process.on('SIGPIPE', () => {});
// 兜底：未捕获异常也要停 App、清临时目录再退出（幂等，正常路径由 finally 负责）
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
/** 停止 Electron 并清理临时目录（幂等；runDbCheck=true 时先做隔离落库断言再删目录） */
let stoppedOnce = false;
const stopAndCleanup = async (runDbCheck = false) => {
  if (stoppedOnce) return;
  stoppedOnce = true;
  // 可靠停止：SIGTERM → 等待退出（5s 兜底 SIGKILL）。
  // 绝不在停止完成前 process.exit（会跳过清理，曾因此残留 Electron 进程与 td-app-smoke 目录）
  await new Promise((resolveStop) => {
    if (app.exitCode !== null || app.signalCode !== null) return resolveStop();
    const killTimer = setTimeout(() => { try { app.kill('SIGKILL'); } catch { /* 已退出 */ } }, 5000);
    app.once('exit', () => { clearTimeout(killTimer); resolveStop(); });
    app.kill('SIGTERM');
  });
  if (runDbCheck && !failed) {
    // 隔离落库断言：样课确认只写进了临时 smoke.db（真实库绝无触碰）
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const sdb = new DatabaseSync(dbPath, { readOnly: true });
      const row = sdb.prepare("SELECT status, sample_confirmed_at IS NOT NULL AS ok FROM courses WHERE slug = 'tour-sample'").get();
      sdb.close();
      if (row?.status === 'sample_confirmed' && row?.ok === 1) console.log('  ✓ 隔离落库：tour-sample 在临时库中为 sample_confirmed');
      else { failed = true; console.error(`  ✗ 隔离落库断言失败：status=${row?.status}`); }
    } catch (e) {
      console.warn(`  ⚠ 临时库只读校验跳过：${e.message}`);
    }
  }
  rmSync(work, { recursive: true, force: true });
  console.log('[smoke] Electron 已停止，临时目录已清理');
};
try {
  // CDP 就绪
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
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    // window.confirm 会阻塞渲染进程：自动接受对话框，让确认流程走完（冒烟环境内等价用户点「好」）
    if (m.method === 'Page.javascriptDialogOpening') {
      console.log(`  · 对话框自动接受：${m.params?.message?.slice(0, 40)}…`);
      void send('Page.handleJavaScriptDialog', { accept: true });
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error('页面执行失败: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  };
  await send('Page.enable');
  const assert = (cond, label) => {
    if (!cond) throw new Error('断言失败：' + label);
    console.log(`  ✓ ${label}`);
  };

  /** 重试点击直到就绪条件成立（应用启动初期 React 事件处理器可能尚未挂好，一次性 click 会丢失） */
  const clickUntil = async (clickExpr, readyFn, ms, label) => {
    const state = async () => {
      try {
        return await evalJs(`(() => JSON.stringify({ t: document.title, h1: document.querySelector('.panel h1')?.textContent ?? null, cards: [...document.querySelectorAll('.plan-card')].map((c) => c.textContent.slice(0, 24)) }))()`);
      } catch (e) { return 'EVAL_ERR: ' + String(e instanceof Error ? e.message : e).slice(0, 300); }
    };
    const t0 = Date.now();
    for (;;) {
      try { await evalJs(clickExpr); } catch { /* 目标未渲染，稍后重试 */ }
      try {
        if (await readyFn()) return;
      } catch { /* 就绪条件评估失败，重试 */ }
      if (Date.now() - t0 > ms) throw new Error(`点击超时：${label}（${await state()}）\n${stderrTail}`);
      if (process.env.SMOKE_DEBUG) console.log(`[dbg] ${label} 等待中（${await state()}）`);
      await new Promise((r) => setTimeout(r, 400));
    }
  };

  // 3a. 应用启动：侧栏仅「学习计划」一个学习入口，不再有独立「课程」菜单
  await waitFor(() => evalJs(`!!document.querySelector('.nav-item')`), 15000, '应用启动');
  const navTexts = await evalJs(`[...document.querySelectorAll('.nav-item')].map((b) => b.textContent.trim())`);
  assert(navTexts.filter((t) => t.includes('学习计划')).length === 1, '侧栏恰有一个「学习计划」入口');
  assert(!navTexts.some((t) => t === '课程'), '侧栏无独立「课程」菜单');

  // 3b. 首页默认计划，标题右侧切到课程再切回；两页内容互不混排
  await clickUntil(
    `[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('学习计划'))?.click()`,
    () => evalJs(`document.querySelectorAll('.panel .plan-card:not(.plan-course-entry)').length === 2 && document.querySelectorAll('.plan-course-entry').length === 0`),
    15000, '学习首页默认只显示两个计划',
  );
  assert(await evalJs(`document.querySelector('.study-home-tabs button.active')?.textContent === '计划'`), '默认选中「计划」');
  assert(await evalJs(`document.querySelectorAll('.plan-link').length`) === 2, '计划卡显示课程关联状态');
  await clickUntil(
    `[...document.querySelectorAll('.study-home-tabs button')].find(b => b.textContent === '课程')?.click()`,
    () => evalJs(`document.querySelectorAll('.plan-course-entry').length === 2 && document.querySelectorAll('.plan-card:not(.plan-course-entry)').length === 0`),
    10000, '课程页只显示两门课程',
  );
  assert(await evalJs(`document.querySelector('.study-home-tabs button.active')?.textContent === '课程'`), '切换后选中「课程」');
  assert(await evalJs(`[...document.querySelectorAll('.plan-course-entry')].some(c => c.textContent.includes('关联计划「冒烟五天计划」'))`), '课程卡显示计划名称');
  await clickUntil(
    `[...document.querySelectorAll('.study-home-tabs button')].find(b => b.textContent === '计划')?.click()`,
    () => evalJs(`document.querySelectorAll('.plan-card:not(.plan-course-entry)').length === 2 && document.querySelectorAll('.plan-course-entry').length === 0`),
    10000, '切回计划页',
  );

  // 3c. 打开「冒烟五天计划」详情：每日摘要卡与「待生成」（两门计划并存，按标题精确定位）
  await clickUntil(
    `[...document.querySelectorAll('.plan-card:not(.plan-course-entry)')].find(c => c.textContent.includes('冒烟五天计划'))?.click()`,
    () => evalJs(`!!document.querySelector('.plan-course-bar')`),
    15000, '打开「冒烟五天计划」详情（关联课程条出现）',
  );
  assert(await evalJs(`document.querySelectorAll('.group-day-chip').length`) === 5, '五个「第 N 天」徽标');
  assert(await evalJs(`document.querySelectorAll('.plan-day-lesson').length`) === 2, '两张每日摘要卡（第 1/2 天）');
  assert(await evalJs(`document.querySelectorAll('.plan-day-pending').length`) === 3, '三行「讲义待生成」（第 3~5 天）');
  assert((await evalJs(`document.querySelector('.plan-day-lesson')?.innerText`)).includes('第一天·样课'), '摘要卡显示讲义标题');
  assert(await evalJs(`[...document.querySelectorAll('.plan-day-lesson-meta')].some(el => el.textContent.includes('已读'))`), '摘要卡显示已读状态');
  assert(await evalJs(`[...document.querySelectorAll('.plan-day-pending')].every(el => el.textContent.includes('待生成'))`), '未生成天显示待生成文案');

  // 3d. 每日摘要卡 → 直达当天完整讲义（原「进入课程」跳转收敛为学习计划面板内直达）
  const scrollTopBefore = await evalJs(`(() => { const el = document.querySelector('.content'); el.scrollTop = 80; return el.scrollTop; })()`);
  await clickUntil(
    `document.querySelector('.plan-day-lesson')?.click()`,
    () => evalJs(`!!document.querySelector('.course-lesson-frame')`),
    10000, '摘要卡直达当天讲义视图',
  );
  assert(await evalJs(`document.querySelector('.panel h1')?.textContent`) === '第一天·样课', '直达第 1 天讲义正文');
  assert((await evalJs(`document.querySelector('.backlink')?.textContent`))?.includes('返回计划详情'), '直达讲义的返回指向计划详情');
  assert(await evalJs(`document.querySelector('.nav-item.active')?.textContent.includes('学习计划')`), '全程仍在「学习计划」入口内');
  // 讲义 iframe：sandbox/CSP/外部资源中和/包内样式内联（与直达路径无关，渲染防护不变）
  const frameInfo = await evalJs(`(() => { const f = document.querySelector('.course-lesson-frame'); const d = f.getAttribute('srcdoc') || ''; return { sandbox: f.getAttribute('sandbox'), hasCsp: d.includes('Content-Security-Policy'), noExternal: !d.includes('evil.example.com'), noLink: !d.includes('<link'), hasInlineCss: d.includes('内联自课程包 assets/style.css'), cssMarker: d.includes('--smoke-ink') }; })()`);
  assert(frameInfo.sandbox === '', 'iframe sandbox 为最严格（空串）');
  assert(frameInfo.hasCsp, 'srcDoc 注入 CSP（default-src none）');
  assert(frameInfo.noExternal, '外部资源已被导入消毒中和（无 evil.example.com）');
  assert(frameInfo.noLink, 'link 标签已不在（剥除或内联）');
  assert(frameInfo.hasInlineCss, '包内样式已内联为 <style>（保留课程排版）');
  assert(frameInfo.cssMarker, '内联样式内容可见（--smoke-ink）');
  assert(await evalJs(`[...document.querySelectorAll('.course-embed .embed-fullscreen-button')].some(b => b.textContent.includes('全屏'))`), '讲义提供统一全屏按钮');
  await clickUntil(
    `document.querySelector('.course-embed .embed-fullscreen-button')?.click()`,
    () => evalJs(`document.querySelector('.course-embed')?.classList.contains('is-fullscreen')`),
    10000,
    '讲义进入应用内全屏',
  );
  assert(await evalJs(`(() => { const frame = document.querySelector('.course-embed'); const sidebar = document.querySelector('.sidebar'); if (!frame || !sidebar) return false; const r = frame.getBoundingClientRect(); return Math.abs(r.left - sidebar.getBoundingClientRect().right) < 2 && r.top === 0 && Math.abs(r.bottom - window.innerHeight) < 2; })()`), '全屏讲义占满侧边栏右侧内容区');
  await clickUntil(
    `document.querySelector('.course-embed .embed-fullscreen-button')?.click()`,
    () => evalJs(`!document.querySelector('.course-embed')?.classList.contains('is-fullscreen')`),
    10000,
    '退出讲义应用内全屏',
  );

  // 3e. 返回计划详情：选择状态与滚动位置保留（无焦点重复消费导致的弹回）
  await clickUntil(
    `document.querySelector('.backlink')?.click()`,
    () => evalJs(`document.querySelector('.panel h1')?.textContent === '冒烟五天计划' && !!document.querySelector('.plan-course-bar')`),
    10000, '返回计划详情',
  );
  assert(await evalJs(`document.querySelectorAll('.plan-day-lesson').length`) === 2, '详情选择状态保留（摘要卡仍在，未弹回列表）');
  const scrollTopAfter = await evalJs(`document.querySelector('.content')?.scrollTop ?? -1`);
  assert(Math.abs(scrollTopAfter - scrollTopBefore) <= 30, `详情滚动位置保留（进入前 ${scrollTopBefore}，返回后 ${scrollTopAfter}）`);

  // 计划条目主内容进入独立详情；状态操作与返回路径都在同一计划内
  const itemScrollBefore = await evalJs(`(() => { const el = document.querySelector('.content'); el.scrollTop = 80; return el.scrollTop; })()`);
  await clickUntil(
    `document.querySelector('.plan-item-open')?.click()`,
    () => evalJs(`document.querySelector('.panel h1')?.textContent === '计划条目'`),
    10000, '点击计划条目进入详情',
  );
  assert((await evalJs(`document.querySelector('.plan-item-detail-content')?.textContent`))?.includes('第1天任务'), '条目详情显示完整安排');
  assert((await evalJs(`document.querySelector('.plan-item-detail-facts')?.textContent`))?.includes('2026-10-10'), '条目详情显示安排日期');
  assert((await evalJs(`document.querySelector('.group-label')?.textContent`))?.includes('学习安排'), '条目详情显示安排信息');
  await clickUntil(
    `[...document.querySelectorAll('.plan-item-detail-actions button')].find(b => b.textContent === '标记完成')?.click()`,
    () => evalJs(`document.querySelector('.plan-item-detail .head-meta')?.textContent === '已完成'`),
    10000, '条目详情可以标记完成',
  );
  await clickUntil(
    `document.querySelector('.plan-item-detail .backlink')?.click()`,
    () => evalJs(`document.querySelector('.panel h1')?.textContent === '冒烟五天计划' && !!document.querySelector('.plan-item.done')`),
    10000, '条目详情返回计划并同步完成状态',
  );
  const itemScrollAfter = await evalJs(`document.querySelector('.content')?.scrollTop ?? -1`);
  assert(Math.abs(itemScrollAfter - itemScrollBefore) <= 30, `条目返回保留计划滚动位置（进入前 ${itemScrollBefore}，返回后 ${itemScrollAfter}）`);

  // 3f. 「进入课程总览」（旧课程跳转兼容）：在学习计划面板内打开总览，侧栏不变
  await clickUntil(
    `[...document.querySelectorAll('.plan-course-bar .btn')].find(b => b.textContent.includes('进入课程总览'))?.click()`,
    () => evalJs(`document.querySelector('.panel h1')?.textContent === '冒烟课程'`),
    10000, '课程总览打开（学习计划面板内）',
  );
  assert(await evalJs(`document.querySelector('.nav-item.active')?.textContent.includes('学习计划')`), '总览仍挂在「学习计划」入口下');
  assert((await evalJs(`document.querySelector('.backlink')?.textContent`))?.includes('返回计划详情'), '总览返回指向计划详情');
  assert(await evalJs(`document.querySelectorAll('.course-card:not(.course-overview-entry)').length`) === 5, '课程每日卡片共 5 张（= 计划天数）');
  assert(await evalJs(`document.querySelectorAll('.course-card:not(.course-overview-entry):not(.pending)').length`) === 2, '其中 2 张讲义卡（第 1/2 天）');
  assert(await evalJs(`document.querySelectorAll('.course-card.pending:not(.course-overview-entry)').length`) === 3, '其中 3 张待生成卡（第 3~5 天）');
  assert((await evalJs(`[...document.querySelectorAll('.group-label')].find(e => e.textContent.includes('每日课程'))?.querySelector('.group-count')?.textContent`))?.includes('2/5'), '分组计数 2/5 天');
  assert((await evalJs(`[...document.querySelectorAll('.group-label')].find(e => e.textContent.includes('每日课程'))?.querySelector('.group-count')?.textContent`))?.includes('3 天待生成'), '分组计数提示 3 天待生成');
  assert((await evalJs(`document.querySelector('.head-meta')?.textContent`))?.includes('计划 5 天'), '头部「计划 5 天」');
  assert(await evalJs(`document.querySelectorAll('.course-overview-entry').length`) === 1, '独立课程总览与每日课程分组展示');
  assert(await evalJs(`document.querySelectorAll('.course-card:not(.course-overview-entry)').length`) === 5, '独立总览不计入五天日课');
  await clickUntil(
    `document.querySelector('.course-overview-entry')?.click()`,
    () => evalJs(`document.querySelector('.panel h1')?.textContent === '课程总览' && !!document.querySelector('.course-lesson-frame')`),
    10000, '打开独立课程总览正文',
  );
  assert(await evalJs(`(() => { const f = document.querySelector('.course-lesson-frame'); const d = f.getAttribute('srcdoc') || ''; return f.getAttribute('sandbox') === '' && d.includes('独立课程总览') && !d.includes('<script'); })()`), '总览正文已消毒并用 sandbox 阅读');
  await clickUntil(
    `document.querySelector('.backlink')?.click()`,
    () => evalJs(`document.querySelector('.panel h1')?.textContent === '冒烟课程' && document.querySelectorAll('.course-overview-entry').length === 1`),
    10000, '从独立总览返回课程页面',
  );

  // 3g. 总览卡 → 正文 → 返回总览：卡片与进度保留
  await clickUntil(
    `[...document.querySelectorAll('.course-card:not(.pending)')].find(c => c.textContent.includes('第二天'))?.click()`,
    () => evalJs(`!!document.querySelector('.course-lesson-frame') && (document.querySelector('.panel h1')?.textContent ?? '').includes('第二天')`),
    10000, '从总览打开第 2 天讲义',
  );
  await clickUntil(
    `document.querySelector('.backlink')?.click()`,
    () => evalJs(`document.querySelector('.panel h1')?.textContent === '冒烟课程' && document.querySelectorAll('.course-card:not(.course-overview-entry)').length === 5`),
    10000, '返回课程总览',
  );
  assert(true, '总览卡→正文→返回 总览恢复');

  // 3h. 总览返回计划详情：第 2 天已读状态回流到每日摘要卡
  await clickUntil(
    `document.querySelector('.backlink')?.click()`,
    () => evalJs(`document.querySelector('.panel h1')?.textContent === '冒烟五天计划'`),
    10000, '总览返回计划详情',
  );
  await waitFor(
    () => evalJs(`[...document.querySelectorAll('.plan-day-lesson-meta')].filter(el => el.textContent.includes('已读')).length === 2`),
    10000, '已读状态回流到两张摘要卡',
  );
  assert(true, '已读状态回流到两张摘要卡');

  // 3i. 返回计划页 → 切换课程页进入 样课课程：后四天待生成 + 确认入口仍在
  await clickUntil(
    `document.querySelector('.backlink')?.click()`,
    () => evalJs(`document.querySelector('.panel h1')?.textContent === '学习计划' && document.querySelector('.study-home-tabs button.active')?.textContent === '计划'`),
    10000, '返回计划页',
  );
  await clickUntil(
    `[...document.querySelectorAll('.study-home-tabs button')].find(b => b.textContent === '课程')?.click()`,
    () => evalJs(`document.querySelectorAll('.plan-course-entry').length === 2`),
    10000, '切换到课程页',
  );
  await clickUntil(
    `[...document.querySelectorAll('.plan-course-entry')].find(c => c.textContent.includes('上手之旅样课课程'))?.click()`,
    () => evalJs(`document.querySelector('.panel h1')?.textContent === '上手之旅样课课程'`),
    10000, '课程页打开 样课课程总览',
  );
  assert(await evalJs(`document.querySelectorAll('.course-card:not(.course-overview-entry)').length`) === 5, '五天计划共 5 张卡');
  assert((await evalJs(`document.querySelector('.course-overview-entry')?.textContent`))?.includes('课程总览待生成'), '旧课程缺总览时不借用 D1，明确提示待生成');
  assert(await evalJs(`document.querySelectorAll('.course-card:not(.course-overview-entry):not(.pending)').length`) === 1, '仅 1 张讲义卡（Day1 样课）');
  assert(await evalJs(`document.querySelectorAll('.course-card.pending:not(.course-overview-entry)').length`) === 4, '后四天全部待生成（样课课程不生成后四天）');
  assert((await evalJs(`document.querySelector('.head-meta')?.textContent`))?.includes('计划 5 天'), '头部「计划 5 天」');
  assert((await evalJs(`[...document.querySelectorAll('.group-label')].find(e => e.textContent.includes('每日课程'))?.querySelector('.group-count')?.textContent`))?.includes('1/5'), '分组计数 1/5 天');
  assert(await evalJs(`(() => { const b = document.querySelector('.course-confirm-bar .btn'); return !!b && b.disabled; })()`), '未阅读样课：确认按钮锁定');
  assert((await evalJs(`document.querySelector('.course-confirm-bar')?.textContent`))?.includes('先阅读样课后解锁确认'), '提示先阅读后解锁');

  // 3j. 样课确认交互：读样课 → 返回总览 → 解锁 → 确认（CDP 自动接受 dialog）→ 状态翻转
  await clickUntil(
    `document.querySelector('.course-card:not(.pending)')?.click()`,
    () => evalJs(`!!document.querySelector('.course-lesson-frame')`),
    10000, '样课讲义视图',
  );
  assert(await evalJs(`(() => { const d = document.querySelector('.course-lesson-frame').getAttribute('srcdoc') || ''; return d.includes('内联自课程包 assets/style.css'); })()`), '样课正文包内样式同样内联');
  await clickUntil(
    `document.querySelector('.backlink')?.click()`,
    () => evalJs(`document.querySelector('.panel h1')?.textContent === '上手之旅样课课程'`),
    10000, '返回样课总览',
  );
  await waitFor(() => evalJs(`(() => { const b = document.querySelector('.course-confirm-bar .btn'); return !!b && !b.disabled; })()`), 10000, '阅读后确认按钮解锁');
  assert(true, '阅读样课后确认按钮解锁');
  await evalJs(`(() => { const b = document.querySelector('.course-confirm-bar .btn'); if (!b || b.disabled) return false; setTimeout(() => b.click(), 0); return true; })()`);
  await waitFor(() => evalJs(`document.querySelector('.head-meta')?.textContent?.includes('样课已确认')`), 10000, '确认后状态翻转');
  assert(true, '确认后状态 → 样课已确认');
  assert(await evalJs(`[...document.querySelectorAll('.course-confirm-bar .btn')].some(b => b.textContent.includes('请求完整版'))`), '出现「请求完整版」入口');

  // 3k. 返回课程页：课程状态回流，切换视图仍选中课程
  await clickUntil(
    `document.querySelector('.backlink')?.click()`,
    () => evalJs(`document.querySelector('.panel h1')?.textContent === '学习计划'`),
    10000, '返回课程页',
  );
  assert(await evalJs(`document.querySelector('.study-home-tabs button.active')?.textContent === '课程'`), '从课程总览返回后仍选中「课程」');
  await waitFor(
    () => evalJs(`[...document.querySelectorAll('.plan-course-entry')].some(c => c.textContent.includes('上手之旅样课课程') && c.textContent.includes('样课已确认'))`),
    10000, '课程页状态回流为「样课已确认」',
  );
  assert(true, '课程页状态回流为「样课已确认」');

  ws.close();
  console.log('[smoke] PASS：全部断言通过（纯文本断言，无截图）');
} catch (e) {
  failed = true;
  console.error(`[smoke] FAIL：${e instanceof Error ? e.message : e}`);
} finally {
  // 停 App →（通过时）隔离落库断言 → 删临时目录
  await stopAndCleanup(true);
}
process.exitCode = failed ? 1 : 0;
