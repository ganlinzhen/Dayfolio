#!/usr/bin/env node
// 课程×学习计划联动 UI 冒烟（隔离运行，不改真实数据）：
//   1. 打包 core 并在临时库播种两门课：
//      A「冒烟课程」：五天计划，样课确认+请求+认领后导入第 1~2 天（第 3~5 天待生成）；
//      B「上手之旅样课课程」：绑定自己的五天计划，仅导入 Day1 样课（后四天绝不生成），未读未确认；
//   2. 以临时 TODODESK_DB + TODODESK_USER_DATA + 隔离 HOME 拉起 Electron（CDP 用动态空闲端口，
//      杜绝与残留 Electron/他人 dev 窗口 9223 的端口碰撞）；
//   3. CDP DOM 与布局断言（可选输出截图）。侧栏仅「学习计划」，首页左侧「计划 / 课程」切换：
//      默认计划页只显示计划；课程页显示两门测试课程与随 App 自动补入的上手课程；计划详情每日摘要卡（未生成显示待生成）；
//      摘要卡直达当天完整讲义→返回计划详情（选择与滚动位置保留）；「进入课程总览」仍可达（面板内）；
//      总览卡→正文→返回总览；样课后四天待生成；App 只提示对话确认；通过 MCP 确认后切回同步状态；
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
const sampleQuiz = [
  { id: 'q1', question: '课件和计划分别负责什么？', options: ['课件提供材料，计划安排学习', '读过课件就自动完成计划'], answer_index: 0, explanation: '阅读、自测与完成安排分别记录。' },
  { id: 'q2', question: '自测作答代表什么？', options: ['已经掌握全部内容', '提交过学习答案'], answer_index: 1, explanation: '作答属于学习痕迹，不能替代掌握证据。' },
];
const mkPkg = (stage, slug, title, planId, lessons, version, withOverview = true) => {
  fs.mkdirSync(stage + '/lessons', { recursive: true });
  fs.mkdirSync(stage + '/assets', { recursive: true });
  fs.writeFileSync(stage + '/assets/style.css', ':root{--smoke-ink:#10254d}body{margin:0}main{width:820px;max-width:820px;margin:0;padding:24px 16px}.lesson-banner{color:#fff;background:linear-gradient(135deg,#10254d,#1a56db)}');
  if (withOverview) fs.writeFileSync(stage + '/overview.html', '<div style="width:820px;max-width:820px;margin:0"><h1>独立课程总览</h1><p>这不是第一天讲义。</p></div><script>alert(1)</script>');
  for (const l of lessons) fs.writeFileSync(stage + '/lessons/' + l.file, '<main>' + l.html + '</main>');
  fs.writeFileSync(stage + '/course.json', JSON.stringify({
    schema_version: withOverview ? 2 : undefined,
    slug, title, goal: '跑通每日卡片', version: version || '1.0.0', plan_id: planId,
    overview: withOverview ? { html: 'overview.html' } : undefined,
    lessons: lessons.map((l) => ({ day: l.day, title: l.title, html: 'lessons/' + l.file, is_sample: !!l.sample, quiz: l.day === 1 ? sampleQuiz : [] })),
  }));
  return stage;
};
const mkPlan = (title, prefix) => core.plans.create({
  title, goal: '验证课程与计划联动', start_date: '2026-10-10', daily_minutes: 45,
  items: [0,1,2,3,4].map((i) => ({ date: '2026-10-1' + i, content: prefix + '第' + (i+1) + '天任务' + (i === 0 ? '：认识内核、模型与分支解析（目标：画出模块职责图，读懂分支解析器，运行 5 个现有测试。）' : ''), duration_min: 75 })),
});
const styleLink = '<link rel="stylesheet" href="../assets/style.css">';

// 课程 A：五天计划，样课 → 确认 → 请求 → 认领 → 导入 1~2 天（3~5 天待生成）
const planA = mkPlan('冒烟五天计划', '');
const stageA = mkPkg(fs.mkdtempSync(require('node:os').tmpdir() + '/td-smoke-a-'), 'smoke-course', '冒烟课程', planA.id, [
  { day: 1, title: '第一天·样课', file: 'd1.html', sample: true, html: '<h1 style="font-size:40px">Day 1 入门：一条请求进来，先找到哪份模型？</h1>' + styleLink + '<p style="font-size:24px">样课正文。从前端请求出发，读懂一个完整的小方法，再回到 HTTP 响应。</p><h2>学完能解释什么</h2><ol><li>区分模型与记录的职责。</li><li>理解请求上下文中的本体与分支。</li><li>运行测试并说明输入、输出和验证边界。</li></ol><h2>沿着请求阅读源码</h2><p>先定位入口，再跟踪解析方法的输入、两次查找和返回结果。将实际观察与自己的推断分别记录，形成可验证的学习笔记。</p><script>alert(1)</script><img hidden src="https://evil.example.com/x.png">' },
  { day: 2, title: '第二天·进阶', file: 'd2.html', html: '<h1>Day 2 进阶</h1><p>第二课正文。</p>' },
]);
// 课程 B：样课课程——绑定自己的五天计划，仅 Day1 样课，后四天不生成（待用户确认+请求+agent 认领）
const stageB = mkPkg(fs.mkdtempSync(require('node:os').tmpdir() + '/td-smoke-b-'), 'tour-sample', '上手之旅样课课程', undefined, [
  { day: 1, title: 'Dayfolio 上手全景', file: 'tour-d1.html', sample: true, html: '<h1>Tour Day 1</h1>' + styleLink + '<p>样课正文：五分钟核心能力之旅。</p>' },
], undefined, false);
// staging 只是导入源；导入中途抛错也必须在 finally 清掉，绝不残留 td-smoke-a/b-* 临时目录
try {
  let m = JSON.parse(fs.readFileSync(stageA + '/course.json', 'utf8'));
  m.lessons = [m.lessons[0]]; // 先只导样课天
  fs.writeFileSync(stageA + '/course.json', JSON.stringify(m));
  const r1 = core.courses.importCourse(stageA);
  core.courses.markLessonRead(r1.course.id, 1);
  core.commands.human.confirmCourseSample(r1.course.id);
  const req = core.courses.createGenerationRequest(r1.course.id, 'app');
  core.courses.claimRequest(req.id, 'smoke-agent');
  // 认领后导入完整包（第 1~2 天；第 1 天与样课逐字节一致，版本升 1.1.0）
  const manifestFull = JSON.parse(fs.readFileSync(stageA + '/course.json', 'utf8'));
  manifestFull.lessons = [
    { day: 1, title: '第一天·样课', html: 'lessons/d1.html', is_sample: true, quiz: sampleQuiz },
    { day: 2, title: '第二天·进阶', html: 'lessons/d2.html' },
  ];
  manifestFull.version = '1.1.0';
  fs.writeFileSync(stageA + '/course.json', JSON.stringify(manifestFull));
  const r2 = core.courses.importCourse(stageA);

  const rb = core.courses.importCourse(stageB);
  // 课程先导入，再从带 course_id 的草案确认计划，验证真实的关联写回链路。
  const draftB = core.study.draftDateless({
    title: '样课五天计划', course_id: rb.course.id,
    knowledge_points: [1,2,3,4,5].map(day => ({ key: 'smoke-day-' + day, name: '样课 第' + day + '天任务', est_minutes: 45 })),
  });
  const previewB = core.study.previewDraftSchedule(draftB.id, '2026-10-10', 45);
  const confirmBudgetB = { confirmed_over_dates: previewB.over_budget_dates };
  core.study.scheduleDraft(draftB.id, '2026-10-10', 45, confirmBudgetB);
  const { plan: planB } = core.study.confirmDraft(draftB.id, confirmBudgetB);
  if (core.study.confirmDraft(draftB.id).plan.id !== planB.id) throw new Error('重复确认创建了其他计划');
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
const packagedApp = process.env.TODODESK_SMOKE_APP;
if (packagedApp && (!packagedApp.startsWith('/') || !packagedApp.endsWith('.app/Contents/MacOS/Dayfolio') || !existsSync(packagedApp))) {
  rmSync(work, { recursive: true, force: true });
  throw new Error('候选 App 可执行路径不合法');
}
const app = spawn(packagedApp || electronBin, [...(packagedApp ? [] : ['.']), `--remote-debugging-port=${PORT}`], {
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
    return list.find((t) => t.type === 'page' && t.url === 'dayfolio-app://app/index.html');
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
  const send = (method, params = {}, sessionId) =>
    new Promise((res, rej) => {
      const id = ++msgId;
      const timer = setTimeout(() => { pending.delete(id); rej(new Error(`CDP 请求超时：${method}`)); }, 10000);
      pending.set(id, (value) => { clearTimeout(timer); value.error ? rej(new Error(`${method}: ${value.error.message}`)) : res(value); });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error('页面执行失败: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  };
  await send('Page.enable');
  // 模拟用户真正切回 App；后台窗口仍为 hidden 时，课程同步会按设计跳过。
  const returnToApp = async () => {
    await send('Page.bringToFront');
    await evalJs(`window.dispatchEvent(new Event('focus'))`);
  };
  const initialViewport = await evalJs('({ width: innerWidth, height: innerHeight })');
  const assert = (cond, label) => {
    if (!cond) throw new Error('断言失败：' + label);
    console.log(`  ✓ ${label}`);
  };

  // 在 sandbox 子框架中读取真实布局，覆盖课程自身重置 body、固定 main/div 宽度的情况。
  const assertCourseLayout = async (label) => {
    // sandbox 可能运行在独立渲染进程，需附加子目标，不能从父页绕过同源隔离。
    const box = await waitFor(async () => {
      const expectedWidth = await evalJs('document.querySelector(".course-lesson-frame").clientWidth');
      const targets = await send('Target.getTargets');
      const child = targets.result.targetInfos.find((t) => t.type === 'iframe' && t.url === 'about:srcdoc');
      let context;
      if (child) {
        const attached = await send('Target.attachToTarget', { targetId: child.targetId, flatten: true });
        context = { sessionId: attached.result.sessionId };
      } else {
        const tree = await send('Page.getFrameTree');
        const frame = tree.result.frameTree.childFrames?.[0]?.frame;
        if (!frame) return null;
        const world = await send('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'course-layout-smoke' });
        context = { contextId: world.result.executionContextId };
      }
      const result = await send('Runtime.evaluate', {
      ...(context.contextId ? { contextId: context.contextId } : {}), returnByValue: true,
      expression: `(() => {
        const root = document.querySelector('body > main, body > div');
        if (!root) return null;
        const r = root.getBoundingClientRect();
        const body = getComputedStyle(document.body);
        return { viewport: innerWidth, width: r.width, left: r.left, right: innerWidth-r.right,
          padding: parseFloat(body.paddingLeft), overflow: document.documentElement.scrollWidth > innerWidth,
          reading: !!document.querySelector('[data-dayfolio-reading-layout]'), h1Size: parseFloat(getComputedStyle(document.querySelector('h1')).fontSize), paragraphSize: parseFloat(getComputedStyle(document.querySelector('p')).fontSize), align: getComputedStyle(root).textAlign, ink: body.getPropertyValue('--smoke-ink').trim() };
      })()`,
      }, context.sessionId);
      if (context.sessionId) await send('Target.detachFromTarget', { sessionId: context.sessionId });
      const value = result.result?.result?.value;
      return value && Math.abs(value.viewport - expectedWidth) < 2 ? value : null;
    }, 10000, '课程正文完成加载');
    assert(Math.abs(box.width - (box.reading ? Math.min(860, box.viewport - 2 * box.padding) : box.viewport - 2 * box.padding)) < 2 && Math.abs(box.left-box.right) < 2 && !box.overflow,
      `${label}：正文自适应铺开、两侧对称且无页面横向溢出 ${JSON.stringify(box)}`);
    assert(box.align !== 'center', `${label}：段落保留左对齐`);
    if (box.reading) assert(box.h1Size >= 21 && box.h1Size <= 24 && box.paragraphSize === 14, `${label}：讲义标题与正文使用连续阅读字号`);
  };
  const resizeReading = async (width) => {
    await send('Emulation.setDeviceMetricsOverride', { width, height: initialViewport.height, deviceScaleFactor: 1, mobile: false });
    await waitFor(() => evalJs(`innerWidth === ${width}`), 5000, '阅读视口完成缩放');
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
  assert(navTexts.filter((t) => t.includes('学习')).length === 1, '侧栏恰有一个「学习计划」入口');
  assert(!navTexts.some((t) => t === '课程'), '侧栏无独立「课程」菜单');

  // 3b. 首页默认计划，标题右侧切到课程再切回；两页内容互不混排
  await clickUntil(
    `[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('学习'))?.click()`,
    () => evalJs(`document.querySelectorAll('.panel .plan-card:not(.plan-course-entry)').length === 2 && document.querySelectorAll('.plan-course-entry').length === 0`),
    15000, '学习首页默认只显示两个计划',
  );
  assert(await evalJs(`document.querySelector('.study-home-tabs button.active')?.textContent === '计划'`), '默认选中「计划」');
  assert(await evalJs(`document.querySelectorAll('.plan-link').length`) === 2, '计划卡显示课程关联状态');
  assert(await evalJs(`[...document.querySelectorAll('.plan-card')].some(c => c.textContent.includes('样课五天计划') && c.textContent.includes('关联课程：上手之旅样课课程'))`), '草案确认后的计划卡显示关联课程');
  // 计划列表的紧凑卡片，使用长标题和目标检查宽窄窗口。
  await waitFor(() => evalJs(`!!document.querySelector('.learning-plan-card .learning-totals')`), 10000, '列表学习进度加载完成');
  const listOriginal = await evalJs(`({ title: document.querySelector('.learning-plan-card .plan-title').textContent, goal: document.querySelector('.learning-plan-goal').textContent })`);
  await evalJs(`document.querySelector('.learning-plan-card .plan-title').textContent = 'EOS Core 项目入门 | 从一条请求读懂内核'; document.querySelector('.learning-plan-goal').textContent = '面向初级工程师：理解当前 objects 分层，跟踪 GraphQL 与 Flow 调用，运行测试并独立完成一项可验证的小改动。'`);
  for (const width of [1440, 820, 600]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    const card = await evalJs(`(() => { const el = document.querySelector('.learning-plan-card'); return { height: el.getBoundingClientRect().height, overflow: el.scrollWidth > el.clientWidth + 1 }; })()`);
    assert(!card.overflow && (width < 820 || card.height < 260), width + 'px 计划卡紧凑展示完整标题和进度，无横向溢出');
    if (process.env.DAYFOLIO_COURSE_SCREENSHOTS) {
      mkdirSync(process.env.DAYFOLIO_COURSE_SCREENSHOTS, { recursive: true });
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(process.env.DAYFOLIO_COURSE_SCREENSHOTS, 'plan-list-' + width + '.png'), Buffer.from(shot.result.data, 'base64'));
    }
  }
  await evalJs(`document.querySelector('.learning-plan-card .plan-title').textContent = ${JSON.stringify(listOriginal.title)}; document.querySelector('.learning-plan-goal').textContent = ${JSON.stringify(listOriginal.goal)};`);
  await send('Emulation.clearDeviceMetricsOverride');
  await clickUntil(
    `[...document.querySelectorAll('.study-home-tabs button')].find(b => b.textContent === '课程')?.click()`,
    () => evalJs(`document.querySelectorAll('.plan-course-entry').length === 3 && document.querySelectorAll('.plan-card:not(.plan-course-entry)').length === 0`),
    10000, '课程页显示两门测试课程与随包上手课程',
  );
  assert(await evalJs(`document.querySelector('.study-home-tabs button.active')?.textContent === '课程'`), '切换后选中「课程」');
  assert(await evalJs(`[...document.querySelectorAll('.plan-course-entry')].some(c => c.textContent.includes('关联计划「冒烟五天计划」'))`), '课程卡显示计划名称');
  assert(await evalJs(`[...document.querySelectorAll('.plan-course-entry')].some(c => c.textContent.includes('上手之旅样课课程') && c.textContent.includes('关联计划「样课五天计划」'))`), '草案确认后的课程卡显示关联计划');
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
  assert(await evalJs(`document.querySelectorAll('.plan-day-number').length`) === 5, '五个「第 N 天」徽标');
  assert(await evalJs(`document.querySelectorAll('.plan-day-lesson').length`) === 2, '两张每日摘要卡（第 1/2 天）');
  assert(await evalJs(`document.querySelectorAll('.plan-day-pending').length`) === 3, '三行「讲义待生成」（第 3~5 天）');
  assert((await evalJs(`document.querySelector('.plan-day-lesson')?.innerText`)).includes('第一天·样课'), '摘要卡显示讲义标题');
  assert((await evalJs(`document.querySelector('.plan-day-lesson-meta')?.textContent`))?.includes('v1'), '计划每日摘要卡也显示课次版本');
  assert(!(await evalJs(`document.querySelector('.plan-day-lesson-title')?.textContent`))?.includes('（样课）'), '已确认课程的计划摘要不再附加样课标识');
  assert(await evalJs(`[...document.querySelectorAll('.plan-day-lesson-meta')].some(el => el.textContent.includes('已读'))`), '摘要卡显示已读状态');
  assert(await evalJs(`[...document.querySelectorAll('.plan-day-pending')].every(el => el.textContent.includes('待生成'))`), '未生成天显示待生成文案');

  // 计划详情信息层级与窄窗口排版，不写入真实数据。
  assert(await evalJs(`!!document.querySelector('.plan-detail-overview .learning-totals') && !!document.querySelector('.plan-detail-progress [role="progressbar"]')`), '概览集中展示完成与学习进度');
  assert(await evalJs(`!!document.querySelector('.ai-study-action.is-compact') && !document.querySelector('.ai-prompt-preview').open`), '计划级 AI 使用说明默认收起');
  await evalJs(`document.querySelector('.ai-prompt-preview summary').click()`);
  assert(await evalJs(`document.querySelector('.ai-prompt-preview').open && document.querySelector('.ai-prompt-preview').textContent.includes('复制不会自动开始对话')`), 'AI 使用说明可展开且准确说明边界');
  await evalJs(`document.querySelector('.ai-prompt-preview summary').click()`);
  const originalPlanTitle = await evalJs(`document.querySelector('.plan-detail h1').textContent`);
  const originalGoal = await evalJs(`document.querySelector('.plan-detail-goal').textContent`);
  const originalTitle = await evalJs(`document.querySelector('.plan-day-lesson-title').textContent`);
  const originalItem = await evalJs(`document.querySelector('.learning-item-card .plan-item-content').textContent`);
  await evalJs(`document.querySelector('.plan-detail h1').textContent = 'EOS Core 项目入门 | 从一条请求读懂内核'; document.querySelector('.plan-detail-goal').textContent = '面向初级工程师：理解当前 objects 分层，跟踪 GraphQL 与 Flow 调用，运行测试并独立完成一项可验证的小改动。'; document.querySelector('.plan-day-lesson-title').textContent = '模型与分支：一条请求的第一站，理解请求上下文、模块职责与验证边界'; document.querySelector('.learning-item-card .plan-item-content').textContent = '认识内核：模型、模块与分支解析（目标：画出模块职责图，读懂分支解析器，运行 5 个现有测试。）';`);
  for (const width of [1440, 820, 600]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await evalJs(`document.querySelector('.content').scrollTop = 0`);
    const layout = await evalJs(`(() => { const p = document.querySelector('.plan-detail'); const title = document.querySelector('.plan-day-lesson-title'); const item = document.querySelector('.learning-item-card'); return { overflow: p.scrollWidth > p.clientWidth + 1, titleClipped: title.scrollWidth > title.clientWidth + 1 || getComputedStyle(title).whiteSpace === 'nowrap', firstCardTop: item.getBoundingClientRect().top }; })()`);
    assert(!layout.overflow && !layout.titleClipped, width + 'px 窗口内长标题完整换行且页面不溢出');
    if (width === 1440) assert(layout.firstCardTop < 680, '宽窗口首屏可直接看到当天学习卡片');
    if (process.env.DAYFOLIO_COURSE_SCREENSHOTS) {
      mkdirSync(process.env.DAYFOLIO_COURSE_SCREENSHOTS, { recursive: true });
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(process.env.DAYFOLIO_COURSE_SCREENSHOTS, 'plan-layout-' + width + '.png'), Buffer.from(shot.result.data, 'base64'));
    }
  }
  await evalJs(`document.querySelector('.plan-detail h1').textContent = ${JSON.stringify(originalPlanTitle)}; document.querySelector('.plan-detail-goal').textContent = ${JSON.stringify(originalGoal)}; document.querySelector('.plan-day-lesson-title').textContent = ${JSON.stringify(originalTitle)}; document.querySelector('.learning-item-card .plan-item-content').textContent = ${JSON.stringify(originalItem)};`);
  await send('Emulation.clearDeviceMetricsOverride');

  // 3d. 每日摘要卡 → 直达当天完整讲义（原「进入课程」跳转收敛为学习计划面板内直达）
  const scrollTopBefore = await evalJs(`(() => { const el = document.querySelector('.content'); el.scrollTop = 80; return el.scrollTop; })()`);
  await clickUntil(
    `document.querySelector('.plan-day-lesson')?.click()`,
    () => evalJs(`!!document.querySelector('.course-lesson-frame')`),
    10000, '摘要卡直达当天讲义视图',
  );
  assert(await evalJs(`document.querySelector('.embed-frame-title')?.textContent`) === '第一天·样课', '直达第 1 天讲义正文');
  assert((await evalJs(`document.querySelector('.embed-frame-meta')?.textContent`))?.includes('v1'), '讲义阅读页显示课次 v1');
  assert(await evalJs(`document.querySelectorAll('.course-sample-notice').length`) === 0, '已确认的样课讲义不再提示确认');
  assert((await evalJs(`document.querySelector('.backlink')?.textContent`))?.includes('返回计划详情'), '直达讲义的返回指向计划详情');
  assert(await evalJs(`document.querySelector('.nav-item.active')?.textContent.includes('学习')`), '全程仍在「学习计划」入口内');
  // 讲义 iframe：sandbox/CSP/外部资源中和/包内样式内联（与直达路径无关，渲染防护不变）
  const frameInfo = await evalJs(`(() => { const f = document.querySelector('.course-lesson-frame'); const d = f.getAttribute('srcdoc') || ''; return { sandbox: f.getAttribute('sandbox'), hasCsp: d.includes('Content-Security-Policy'), noExternal: !d.includes('evil.example.com'), noLink: !d.includes('<link'), hasInlineCss: d.includes('内联自课程包 assets/style.css'), cssMarker: d.includes('--smoke-ink') }; })()`);
  assert(frameInfo.sandbox === '', 'iframe sandbox 为最严格（空串）');
  assert(frameInfo.hasCsp, 'srcDoc 注入 CSP（default-src none）');
  assert(frameInfo.noExternal, '外部资源已被导入消毒中和（无 evil.example.com）');
  assert(frameInfo.noLink, 'link 标签已不在（剥除或内联）');
  assert(frameInfo.hasInlineCss, '包内样式已内联为 <style>（保留课程排版）');
  assert(frameInfo.cssMarker, '内联样式内容可见（--smoke-ink）');
  for (const width of [1600, 900, 600]) {
    await resizeReading(width);
    await assertCourseLayout(`讲义普通阅读 ${width}px`);
  }
  await resizeReading(1600);
  assert(await evalJs(`[...document.querySelectorAll('.course-embed .embed-fullscreen-button')].some(b => b.textContent.includes('全屏'))`), '讲义提供统一全屏按钮');
  await clickUntil(
    `document.querySelector('.course-embed .embed-fullscreen-button')?.click()`,
    () => evalJs(`document.querySelector('.course-embed')?.classList.contains('is-fullscreen')`),
    10000,
    '讲义进入应用内全屏',
  );
  // 持续滚动条会缩小布局视口；按实际可见视口验收，并等待缩放后的布局稳定。
  let fullscreenBox;
  try {
    await waitFor(async () => {
      fullscreenBox = await evalJs(`(() => { const r = document.querySelector('.course-embed').getBoundingClientRect(); return {left: r.left, top: r.top, right: r.right, bottom: r.bottom, sidebar: document.querySelector('.sidebar').getBoundingClientRect().right, width: document.documentElement.clientWidth, height: document.documentElement.clientHeight, innerWidth, innerHeight}; })()`);
      return Math.abs(fullscreenBox.left - fullscreenBox.sidebar) < 2 && Math.abs(fullscreenBox.top) < 2
        && Math.abs(fullscreenBox.right - fullscreenBox.width) < 2 && Math.abs(fullscreenBox.bottom - fullscreenBox.height) < 2;
    }, 10000, '全屏讲义布局稳定');
  } catch (error) {
    console.error('[全屏布局诊断]', JSON.stringify(fullscreenBox));
    throw error;
  }
  assert(true, `全屏讲义占满侧边栏右侧内容区 ${JSON.stringify(fullscreenBox)}`);
  await assertCourseLayout('讲义全屏');
  if (process.env.DAYFOLIO_COURSE_SCREENSHOTS) {
    mkdirSync(process.env.DAYFOLIO_COURSE_SCREENSHOTS, { recursive: true });
    await evalJs(`[...document.querySelectorAll('.toast-close')].forEach(b => b.click())`);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.env.DAYFOLIO_COURSE_SCREENSHOTS, 'lesson-fullscreen.png'), Buffer.from(shot.result.data, 'base64'));
  }
  await clickUntil(
    `document.querySelector('.course-embed .embed-fullscreen-button')?.click()`,
    () => evalJs(`!document.querySelector('.course-embed')?.classList.contains('is-fullscreen')`),
    10000,
    '退出讲义应用内全屏',
  );
  await resizeReading(initialViewport.width);

  // 3e. 返回计划详情：选择状态与滚动位置保留（无焦点重复消费导致的弹回）
  await clickUntil(
    `document.querySelector('.backlink')?.click()`,
    () => evalJs(`document.querySelector('.panel h1')?.textContent === '冒烟五天计划' && !!document.querySelector('.plan-course-bar')`),
    10000, '返回计划详情',
  );
  assert(await evalJs(`document.querySelectorAll('.plan-day-lesson').length`) === 2, '详情选择状态保留（摘要卡仍在，未弹回列表）');
  const scrollTopAfter = await evalJs(`document.querySelector('.content')?.scrollTop ?? -1`);
  assert(Math.abs(scrollTopAfter - scrollTopBefore) <= 30, `详情滚动位置保留（进入前 ${scrollTopBefore}，返回后 ${scrollTopAfter}）`);

  assert(await evalJs(`document.querySelectorAll('.learning-item-card').length === 5 && !document.querySelector('.learning-item-card .check') && ![...document.querySelectorAll('.learning-item-card button')].some(b => b.textContent === '跳过')`), '每日安排使用卡片，完成和跳过操作移入详情');
  if (process.env.DAYFOLIO_COURSE_SCREENSHOTS) {
    await evalJs(`document.querySelector('.content').scrollTop = 0`);
    await evalJs(`[...document.querySelectorAll('.toast-close')].forEach(b => b.click())`);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.env.DAYFOLIO_COURSE_SCREENSHOTS, 'learning-plan-cards.png'), Buffer.from(shot.result.data, 'base64'));
  }
  // 计划条目主内容进入独立详情；状态操作与返回路径都在同一计划内
  const itemScrollBefore = await evalJs(`(() => { const el = document.querySelector('.content'); el.scrollTop = 80; return el.scrollTop; })()`);
  await clickUntil(
    `document.querySelector('.plan-item-open')?.click()`,
    () => evalJs(`!!document.querySelector('.plan-item-detail')`),
    10000, '点击计划条目进入详情',
  );
  assert((await evalJs(`document.querySelector('.plan-item-detail-content')?.textContent`))?.includes('第1天任务'), '条目详情显示完整安排');
  assert((await evalJs(`document.querySelector('.plan-item-detail-facts')?.textContent`))?.includes('2026-10-10'), '条目详情显示安排日期');
  assert(await evalJs(`!document.querySelector('.plan-item-detail .panel-head') && !document.querySelector('.learning-section-nav') && !document.querySelector('.plan-item-detail').textContent.includes('所属计划：') && ![...document.querySelectorAll('.plan-item-detail .group-label')].some(e => e.textContent === '学习安排')`), '移除顶部重复信息和整排快捷导航');
  assert(await evalJs(`['课件', '评测', '学习笔记', '本项学习状态'].every(title => [...document.querySelectorAll('.plan-item-detail h2')].some(h => h.textContent.startsWith(title)))`), '详情包含课件、评测、笔记与完成操作');
  assert(await evalJs(`document.querySelector('.learning-signals')?.textContent.includes('课件已读')`), '课件已读进度回流到条目详情');
  await waitFor(() => evalJs(`!!document.querySelector('#learning-materials .course-lesson-frame') && document.querySelectorAll('#learning-assessments .course-quiz').length === 2`), 10000, '学习详情直接展示完整讲义与自测');
  assert(await evalJs(`(() => { const frame = document.querySelector('#learning-materials iframe'); return frame.getAttribute('sandbox') === '' && frame.srcdoc.includes('Day 1 入门') && frame.srcdoc.includes('Content-Security-Policy'); })()`), '内嵌讲义使用实际正文、sandbox 与 CSP');
  assert(await evalJs(`!document.querySelector('.study-note-editor input') && !document.querySelector('.study-note-editor').textContent.includes('实际学习用时')`), '笔记不再显示学习用时输入');
  assert(await evalJs(`document.getElementById('learning-assessments').nextElementSibling.id === 'learning-ai' && document.getElementById('learning-ai').nextElementSibling.id === 'learning-notes'`), 'AI 检验紧跟评测并位于笔记之前');
  assert(await evalJs(`!!document.querySelector('.plan-learning-overview .learning-signals') && document.querySelector('.plan-learning-goal')?.textContent.includes('画出模块职责图') && !document.querySelector('.plan-item-detail-content').textContent.includes('目标：')`), '安排标题与明确标注的目标分开，学习进度集中在顶部');
  for (const width of [1440, 820, 600]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await evalJs(`document.querySelector('.content').scrollTop = 0`);
    assert(await evalJs(`(() => { const panel = document.querySelector('.plan-item-detail'); const title = document.querySelector('.embed-frame-title'); return panel.scrollWidth <= panel.clientWidth + 1 && title.scrollWidth <= title.clientWidth + 1 && getComputedStyle(title).whiteSpace !== 'nowrap'; })()`), width + 'px 学习详情与课件标题完整换行，无页面横向溢出');
    await assertCourseLayout('学习详情阅读 ' + width + 'px');
    if (process.env.DAYFOLIO_COURSE_SCREENSHOTS) {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(process.env.DAYFOLIO_COURSE_SCREENSHOTS, 'learning-detail-' + width + '.png'), Buffer.from(shot.result.data, 'base64'));
    }
  }
  await evalJs(`document.querySelector('.embed-fullscreen-button').click()`);
  assert(await evalJs(`document.querySelector('.course-embed').dataset.fullscreen === 'true'`), '学习详情课件可进入全屏');
  await assertCourseLayout('学习详情全屏阅读');
  await evalJs(`document.querySelector('.embed-fullscreen-button').click()`);
  await send('Emulation.clearDeviceMetricsOverride');
  await evalJs(`document.querySelectorAll('#learning-assessments .course-quiz')[0].querySelector('input').click()`);
  assert(await evalJs(`!document.querySelector('.learning-signals').textContent.includes('评测已做')`), '选择但未提交不计入评测进度');
  await clickUntil(
    `document.querySelector('#learning-assessments .lesson-quiz .primary')?.click()`,
    () => evalJs(`document.querySelector('.learning-signals')?.textContent.includes('评测 1/2') && !!document.querySelector('.course-quiz-expl')`),
    10000, '部分题目提交后显示真实已作答数与解析',
  );
  await evalJs(`document.querySelectorAll('#learning-assessments .course-quiz')[1].querySelectorAll('input')[1].click()`);
  await clickUntil(
    `document.querySelector('#learning-assessments .lesson-quiz .primary')?.click()`,
    () => evalJs(`document.querySelector('.learning-signals')?.textContent.includes('评测已做')`),
    10000, '全部题目提交后同步评测进度',
  );
  assert(await evalJs(`document.querySelector('.plan-item-detail-facts')?.textContent.includes('状态 待完成')`), '阅读与自测不自动完成安排');
  await assertCourseLayout('计划学习详情内嵌讲义');
  if (process.env.DAYFOLIO_COURSE_SCREENSHOTS) {
    await evalJs(`document.querySelector('#learning-assessments').scrollIntoView({ block: 'start' })`);
    await evalJs(`[...document.querySelectorAll('.toast-close')].forEach(b => b.click())`);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.env.DAYFOLIO_COURSE_SCREENSHOTS, 'learning-inline-quiz.png'), Buffer.from(shot.result.data, 'base64'));
  }
  const clipboardBefore = spawnSync('/usr/bin/pbpaste').stdout;
  try {
    await clickUntil(
      `document.querySelector('.ai-study-action button')?.click()`,
      () => evalJs(`document.querySelector('.ai-study-action button')?.textContent.includes('再次复制')`),
      10000, '复制当前条目 AI 检验提示词',
    );
    const copiedPrompt = spawnSync('/usr/bin/pbpaste', { encoding: 'utf8' }).stdout;
    assert(copiedPrompt.includes('plan_item_id=') && copiedPrompt.includes('course_id=') && copiedPrompt.includes('get_lesson_html') && copiedPrompt.includes('一次只问一个问题'), '系统剪贴板实际含课程、条目标识与逐题提问指令');
    assert(await evalJs(`document.querySelector('.plan-item-detail-facts')?.textContent.includes('状态 待完成')`), '复制提示词不会自动完成学习安排');
  } finally { spawnSync('/usr/bin/pbcopy', { input: clipboardBefore }); }
  await evalJs(`(() => {
    const note = document.querySelector('.study-note-editor textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(note, '我能用自己的话解释今天的学习内容，并举出一个例子。');
    note.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await clickUntil(
    `document.querySelector('.study-note-editor button')?.click()`,
    () => evalJs(`document.querySelectorAll('.study-note-entry').length === 1 && document.querySelector('.learning-signals')?.textContent.includes('笔记 1 篇')`),
    10000, '学习笔记无需填写用时即可保存并更新真实进度',
  );
  assert(await evalJs(`document.querySelector('.plan-item-detail-facts')?.textContent.includes('状态 待完成')`), '保存笔记不自动标记完成');
  if (process.env.DAYFOLIO_COURSE_SCREENSHOTS) {
    await evalJs(`document.querySelector('.content').scrollTop = 0`);
    await evalJs(`[...document.querySelectorAll('.toast-close')].forEach(b => b.click())`);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.env.DAYFOLIO_COURSE_SCREENSHOTS, 'learning-item-detail.png'), Buffer.from(shot.result.data, 'base64'));
  }
  await clickUntil(
    `[...document.querySelectorAll('.plan-item-detail-actions button')].find(b => b.textContent === '标记完成')?.click()`,
    () => evalJs(`document.querySelector('.plan-item-detail-facts')?.textContent.includes('状态 已完成')`),
    10000, '条目详情可以标记完成',
  );
  await clickUntil(
    `[...document.querySelectorAll('.plan-item-detail-actions button')].find(b => b.textContent === '撤销完成')?.click()`,
    () => evalJs(`document.querySelector('.plan-item-detail-facts')?.textContent.includes('状态 待完成')`),
    10000, '底部撤销完成同步真实状态',
  );
  await clickUntil(
    `[...document.querySelectorAll('.plan-item-detail-actions button')].find(b => b.textContent === '标记完成')?.click()`,
    () => evalJs(`document.querySelector('.plan-item-detail-facts')?.textContent.includes('状态 已完成')`),
    10000, '底部再次标记完成',
  );
  await clickUntil(
    `document.querySelector('.plan-item-detail .backlink')?.click()`,
    () => evalJs(`document.querySelector('.panel h1')?.textContent === '冒烟五天计划' && !!document.querySelector('.plan-item.done')`),
    10000, '条目详情返回计划并同步完成状态',
  );
  const itemScrollAfter = await evalJs(`document.querySelector('.content')?.scrollTop ?? -1`);
  assert(Math.abs(itemScrollAfter - itemScrollBefore) <= 30, `条目返回保留计划滚动位置（进入前 ${itemScrollBefore}，返回后 ${itemScrollAfter}）`);

  await clickUntil(
    `document.querySelector('.plan-item-open')?.click()`,
    () => evalJs(`document.querySelectorAll('#learning-assessments input:checked').length === 2 && document.querySelectorAll('.study-note-entry').length === 1`),
    10000, '重新进入详情后自测答案与笔记持久保留',
  );
  await clickUntil(`document.querySelector('.backlink')?.click()`, () => evalJs(`!!document.querySelector('.plan-course-bar')`), 10000, '返回计划');
  await clickUntil(
    `document.querySelectorAll('.plan-item-open')[1]?.click()`,
    () => evalJs(`!!document.querySelector('#learning-materials .course-lesson-frame') && document.querySelector('.learning-signals')?.textContent.includes('课件已读')`),
    10000, '当前详情加载未读课件后同步已读状态',
  );
  assert(await evalJs(`document.querySelector('#learning-assessments').textContent.includes('当天课件没有自测题')`), '没有自测的课次显示准确说明');
  await clickUntil(`document.querySelector('.backlink')?.click()`, () => evalJs(`!!document.querySelector('.plan-course-bar')`), 10000, '阅读后返回计划');
  assert(await evalJs(`[...document.querySelectorAll('.plan-day-lesson-meta')].filter(el => el.textContent.includes('已读')).length === 2`), '内嵌阅读状态回流计划摘要');
  await clickUntil(
    `document.querySelectorAll('.plan-item-open')[2]?.click()`,
    () => evalJs(`!!document.querySelector('.plan-item-detail') && document.querySelector('#learning-materials')?.textContent.includes('当天课件待生成')`),
    10000, '未生成的课次显示真实空态',
  );
  assert(await evalJs(`!document.querySelector('.course-lesson-frame') && !document.querySelector('.lesson-quiz') && !!document.querySelector('.plan-item-detail-actions button:not(:disabled)')`), '待生成课件不阻塞完成安排');
  await clickUntil(`document.querySelector('.backlink')?.click()`, () => evalJs(`!!document.querySelector('.plan-course-bar')`), 10000, '待生成课次返回计划');

  // 3f. 「进入课程总览」（旧课程跳转兼容）：在学习计划面板内打开总览，侧栏不变
  await clickUntil(
    `[...document.querySelectorAll('.plan-course-bar .btn')].find(b => b.textContent.includes('进入课程总览'))?.click()`,
    () => evalJs(`document.querySelector('.panel h1')?.textContent === '冒烟课程'`),
    10000, '课程总览打开（学习计划面板内）',
  );
  assert(await evalJs(`document.querySelector('.nav-item.active')?.textContent.includes('学习')`), '总览仍挂在「学习计划」入口下');
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
    () => evalJs(`document.querySelector('.embed-frame-title')?.textContent === '课程总览' && !!document.querySelector('.course-lesson-frame')`),
    10000, '打开独立课程总览正文',
  );
  assert(await evalJs(`(() => { const f = document.querySelector('.course-lesson-frame'); const d = f.getAttribute('srcdoc') || ''; return f.getAttribute('sandbox') === '' && d.includes('独立课程总览') && !d.includes('<script'); })()`), '总览正文已消毒并用 sandbox 阅读');
  await assertCourseLayout('独立总览');
  await clickUntil(
    `document.querySelector('.backlink')?.click()`,
    () => evalJs(`document.querySelector('.panel h1')?.textContent === '冒烟课程' && document.querySelectorAll('.course-overview-entry').length === 1`),
    10000, '从独立总览返回课程页面',
  );

  // 3g. 总览卡 → 正文 → 返回总览：卡片与进度保留
  await clickUntil(
    `[...document.querySelectorAll('.course-card:not(.pending)')].find(c => c.textContent.includes('第二天'))?.click()`,
    () => evalJs(`!!document.querySelector('.course-lesson-frame') && (document.querySelector('.embed-frame-title')?.textContent ?? '').includes('第二天')`),
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

  // 3i. 返回计划页 → 切换课程页进入 样课课程：后四天待生成 + 提示对话确认
  await clickUntil(
    `document.querySelector('.backlink')?.click()`,
    () => evalJs(`!!document.querySelector('.study-home-tabs') && document.querySelector('.study-home-tabs button.active')?.textContent === '计划'`),
    10000, '返回计划页',
  );
  await clickUntil(
    `[...document.querySelectorAll('.study-home-tabs button')].find(b => b.textContent === '课程')?.click()`,
    () => evalJs(`document.querySelectorAll('.plan-course-entry').length === 3`),
    10000, '切换到课程页',
  );
  await clickUntil(
    `[...document.querySelectorAll('.plan-course-entry')].find(c => c.textContent.includes('上手之旅样课课程'))?.click()`,
    () => evalJs(`document.querySelector('.panel h1')?.textContent === '上手之旅样课课程'`),
    10000, '课程页打开 样课课程总览',
  );
  await waitFor(() => evalJs(`document.querySelectorAll('.course-card:not(.course-overview-entry)').length === 5 && document.querySelectorAll('.course-card.pending:not(.course-overview-entry)').length === 4`), 10000, '样课课程讲义与计划大纲加载完成');
  assert(await evalJs(`document.querySelectorAll('.course-card:not(.course-overview-entry)').length`) === 5, '五天计划共 5 张卡');
  assert((await evalJs(`document.querySelector('.course-overview-entry')?.textContent`))?.includes('课程总览待生成'), '旧课程缺总览时不借用 D1，明确提示待生成');
  assert(await evalJs(`document.querySelectorAll('.course-card:not(.course-overview-entry):not(.pending)').length`) === 1, '仅 1 张讲义卡（Day1 样课）');
  assert(await evalJs(`document.querySelectorAll('.course-card.pending:not(.course-overview-entry)').length`) === 4, '后四天全部待生成（样课课程不生成后四天）');
  assert((await evalJs(`document.querySelector('.head-meta')?.textContent`))?.includes('计划 5 天'), '头部「计划 5 天」');
  assert((await evalJs(`[...document.querySelectorAll('.group-label')].find(e => e.textContent.includes('每日课程'))?.querySelector('.group-count')?.textContent`))?.includes('1/5'), '分组计数 1/5 天');
  assert(await evalJs(`document.querySelectorAll('.course-confirm-bar button').length`) === 0, 'App 不再提供确认或请求按钮');
  assert(await evalJs(`document.querySelectorAll('.course-sample-badge').length`) === 1, '尚未确认时显示样课标识');
  assert(await evalJs(`document.querySelector('.course-lesson-version')?.textContent`) === 'v1', '初始日课卡片显示 v1');
  assert((await evalJs(`document.querySelector('.course-confirm-bar')?.textContent`))?.includes('回到对话确认'), '未读时提示先阅读再对话确认');

  // 3j. App 阅读 → 对话 MCP 确认 → 切回 App 状态同步，无需点击确认。
  await clickUntil(
    `document.querySelector('.course-card:not(.pending)')?.click()`,
    () => evalJs(`!!document.querySelector('.course-lesson-frame')`),
    10000, '样课讲义视图',
  );
  assert(await evalJs(`(() => { const d = document.querySelector('.course-lesson-frame').getAttribute('srcdoc') || ''; return d.includes('内联自课程包 assets/style.css'); })()`), '样课正文包内样式同样内联');
  assert(await evalJs(`document.querySelectorAll('.course-sample-notice').length`) === 1, '尚未确认时显示讲义确认提示');
  await clickUntil(
    `document.querySelector('.backlink')?.click()`,
    () => evalJs(`document.querySelector('.panel h1')?.textContent === '上手之旅样课课程'`),
    10000, '返回样课总览',
  );
  await waitFor(() => evalJs(`document.querySelector('.course-confirm-bar')?.textContent.includes('样课确认，继续生成完整版')`), 10000, '阅读后提示对话确认');
  assert(await evalJs(`document.querySelectorAll('.course-confirm-bar button').length`) === 0, '阅读后仍无 App 确认按钮');
  if (process.env.DAYFOLIO_COURSE_SCREENSHOTS) {
    await evalJs(`document.querySelector('.content').scrollTop = 0`);
    await send('Page.bringToFront');
    await evalJs(`[...document.querySelectorAll('.toast-close')].forEach(b => b.click())`);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.env.DAYFOLIO_COURSE_SCREENSHOTS, 'chat-confirm.png'), Buffer.from(shot.result.data, 'base64'));
  }
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const chat = new Client({ name: '课程对话确认验收', version: '1.0.0' });
  try {
    await chat.connect(new StdioClientTransport({ command: process.execPath, args: [join(repo, 'apps/mcp/dist/mcp-server.cjs')], env: isolatedEnv }));
    const data = result => JSON.parse(result.content[0].text).data;
    const courses = data(await chat.callTool({ name: 'list_courses', arguments: {} }));
    const sampleCourse = courses.find(c => c.slug === 'tour-sample');
    const lessons = data(await chat.callTool({ name: 'get_course_lessons', arguments: { course_id: sampleCourse.id } }));
    const confirmed = data(await chat.callTool({ name: 'confirm_course_sample', arguments: {
      course_id: sampleCourse.id, sample_content_hash: lessons.find(l => l.is_sample).content_hash, confirmed: true,
    } }));
    assert(confirmed?.status === 'sample_confirmed', '对话 MCP 成功记录已读样课确认');
    await returnToApp();
    await waitFor(() => evalJs(`document.querySelectorAll('.course-sample-badge').length === 0`), 10000, '对话确认后样课标识隐藏');
    await clickUntil(
      `document.querySelector('.course-card:not(.pending)')?.click()`,
      () => evalJs(`!!document.querySelector('.course-lesson-frame')`),
      10000, '确认后重新进入讲义',
    );
    assert(await evalJs(`document.querySelectorAll('.course-sample-notice').length`) === 0, '确认后重新打开讲义不再提示确认');
    await clickUntil(`document.querySelector('.backlink')?.click()`, () => evalJs(`!!document.querySelector('.head-meta')`), 10000, '确认后返回课程');

    // 只在临时库改写样课，验证确认过期后恢复标识与提示。
    const changed = join(work, 'changed-sample');
    mkdirSync(join(changed, 'lessons'), { recursive: true });
    writeFileSync(join(changed, 'lessons/d1.html'), '<main><h1>更新后的样课</h1><p>需要重新阅读确认。</p></main>');
    writeFileSync(join(changed, 'course.json'), JSON.stringify({
      slug: 'tour-sample', title: '上手之旅样课课程', version: '1.1.0',
      lessons: [{ day: 1, title: 'Dayfolio 上手全景', html: 'lessons/d1.html', is_sample: true }],
    }));
    const imported = data(await chat.callTool({ name: 'import_course', arguments: { staging_dir: changed } }));
    assert(imported.confirmation_expired, '样课内容变化使旧确认过期');
    assert(imported.lessons[0].revision === 2, 'MCP 导入更新后返回本课 v2');
    await returnToApp();
    await waitFor(() => evalJs(`document.querySelectorAll('.course-sample-badge').length === 1`), 10000, '确认过期后恢复样课标识');
    assert(await evalJs(`document.querySelector('.course-lesson-version')?.textContent`) === 'v2', '更新后的日课卡片显示 v2');
    await clickUntil(
      `document.querySelector('.course-card:not(.pending)')?.click()`,
      () => evalJs(`!!document.querySelector('.course-lesson-frame')`),
      10000, '阅读更新后的样课',
    );
    assert(await evalJs(`document.querySelectorAll('.course-sample-notice').length`) === 1, '确认过期后恢复讲义确认提示');
    assert((await evalJs(`document.querySelector('.embed-frame-meta')?.textContent`))?.includes('v2'), '更新后的讲义阅读页显示 v2');
    await clickUntil(`document.querySelector('.backlink')?.click()`, () => evalJs(`!!document.querySelector('.head-meta')`), 10000, '更新样课阅读后返回');
    const latest = data(await chat.callTool({ name: 'get_course_lessons', arguments: { course_id: sampleCourse.id } }));
    const reconfirmed = data(await chat.callTool({ name: 'confirm_course_sample', arguments: {
      course_id: sampleCourse.id, sample_content_hash: latest.find(l => l.is_sample).content_hash, confirmed: true,
    } }));
    assert(reconfirmed?.status === 'sample_confirmed', '更新后的样课可重新在对话确认');
  } finally {
    await chat.close();
  }
  await returnToApp();
  await waitFor(() => evalJs(`document.querySelector('.head-meta')?.textContent?.includes('样课已确认')`), 10000, '对话确认后切回 App 同步状态');
  assert(await evalJs(`document.querySelectorAll('.course-sample-badge').length`) === 0, '重新确认后样课标识再次隐藏');
  assert(await evalJs(`document.querySelectorAll('.course-confirm-bar button').length`) === 0, '已确认时也无需 App 请求按钮');
  assert((await evalJs(`document.querySelector('.course-confirm-bar')?.textContent`))?.includes('继续生成完整版'), '已确认时可继续在对话请求完整版');
  if (process.env.DAYFOLIO_COURSE_SCREENSHOTS) {
    await evalJs(`document.querySelector('.content').scrollTop = 0`);
    await send('Page.bringToFront');
    await evalJs(`[...document.querySelectorAll('.toast-close')].forEach(b => b.click())`);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.env.DAYFOLIO_COURSE_SCREENSHOTS, 'sample-confirmed.png'), Buffer.from(shot.result.data, 'base64'));
  }

  // 3k. 返回课程页：课程状态回流，切换视图仍选中课程
  await clickUntil(
    `document.querySelector('.backlink')?.click()`,
    () => evalJs(`!!document.querySelector('.study-home-tabs')`),
    10000, '返回课程页',
  );
  assert(await evalJs(`document.querySelector('.study-home-tabs button.active')?.textContent === '课程'`), '从课程总览返回后仍选中「课程」');
  await waitFor(
    () => evalJs(`[...document.querySelectorAll('.plan-course-entry')].some(c => c.textContent.includes('上手之旅样课课程') && c.textContent.includes('样课已确认'))`),
    10000, '课程页状态回流为「样课已确认」',
  );
  assert(true, '课程页状态回流为「样课已确认」');

  // 3l. 删除只作用于指定课程，计划及其他课程保留。
  await clickUntil(
    `[...document.querySelectorAll('.plan-course-entry')].find(c => c.textContent.includes('冒烟课程'))?.click()`,
    () => evalJs(`!!document.querySelector('.course-delete-button')`),
    10000, '进入待删除课程',
  );
  await clickUntil(
    `document.querySelector('.course-delete-button')?.click()`,
    () => evalJs(`!!document.querySelector('.study-home-tabs') && ![...document.querySelectorAll('.plan-course-entry')].some(c => c.textContent.includes('冒烟课程'))`),
    10000, '确认删除课程后返回课程列表',
  );
  assert(await evalJs(`document.querySelectorAll('.plan-course-entry').length`) === 2, '仅目标课程消失，其他两门课保留');
  await clickUntil(
    `[...document.querySelectorAll('.study-home-tabs button')].find(b => b.textContent === '计划')?.click()`,
    () => evalJs(`document.querySelector('.study-home-tabs button.active')?.textContent === '计划'`),
    10000, '切回计划列表',
  );
  assert(await evalJs(`document.querySelector('.panel').textContent.includes('冒烟五天计划')`), '删除课程后原学习计划保留');

  await clickUntil(
    `[...document.querySelectorAll('.learning-plan-card')].find(c => c.textContent.includes('冒烟五天计划'))?.click()`,
    () => evalJs(`document.querySelector('.panel h1')?.textContent === '冒烟五天计划'`),
    10000, '课程删除后仍可进入原计划',
  );
  await clickUntil(
    `document.querySelector('.plan-item-open')?.click()`,
    () => evalJs(`document.querySelector('#learning-materials')?.textContent.includes('尚未关联课程')`),
    10000, '解除课程关联后显示准确空态',
  );
  assert(await evalJs(`!!document.querySelector('.study-note-entry') && !!document.querySelector('.plan-item-detail-actions button:not(:disabled)')`), '无关联课程时笔记与完成状态仍可使用');

  ws.close();
  console.log('[smoke] PASS：全部 DOM 与布局断言通过');
} catch (e) {
  failed = true;
  console.error(`[smoke] FAIL：${e instanceof Error ? e.message : e}`);
} finally {
  // 停 App →（通过时）隔离落库断言 → 删临时目录
  await stopAndCleanup(true);
}
process.exitCode = failed ? 1 : 0;
