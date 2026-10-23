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
import { dirname, isAbsolute, join, resolve } from 'node:path';
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
  ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
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
  const seedRun = spawn(process.execPath, [seedCjs, dbPath, workAbs, join(repo, 'apps/onboarding')], { env: isolatedEnv, stdio: ['ignore', 'inherit', 'inherit'] });
  seedRun.on('exit', (code) => (code === 0 ? res() : rej(new Error(`播种失败：exit ${code}（demo-seed 入口路径断言拒绝，见上方输出）`))));
}).catch((e) => {
  // 播种失败也必须清理临时目录（此段在主 try 之前，需自行兜底）
  rmSync(work, { recursive: true, force: true });
  console.error(`[smoke] 失败：${e instanceof Error ? e.message : e}`);
  process.exit(1);
});

// ---------- 隔离拉起 Electron ----------
// 指定候选 .app 可复用同一隔离验收，避免只证明开发入口可用。
const packagedExecutable = process.env.TODODESK_SMOKE_APP;
if (packagedExecutable && (!isAbsolute(packagedExecutable) || !packagedExecutable.endsWith('.app/Contents/MacOS/Dayfolio'))) throw new Error('候选 App 可执行路径不合法');
const electronBin = packagedExecutable || join(repo, 'node_modules', '.bin', 'electron');
if (!existsSync(electronBin)) throw new Error('未找到 electron 可执行文件');
const app = spawn(electronBin, [...(packagedExecutable ? [] : ['.']), `--remote-debugging-port=${PORT}`], {
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
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(3000) })).json();
    // 启动偏好迁移也有短生命周期的隐藏页面，只连接正式渲染入口。
    return list.find((t) => t.type === 'page' && t.url === 'dayfolio-app://app/index.html');
  }, 30000, 'CDP 页面 target');
  console.log('[smoke] 已发现隔离页面：' + page.url);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('CDP 连接超时')), 5000);
    ws.onopen = () => { clearTimeout(timer); res(); };
    ws.onerror = (error) => { clearTimeout(timer); rej(error); };
  });
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++msgId;
      const timer = setTimeout(() => { pending.delete(id); rej(new Error('CDP 请求超时：' + method)); }, 10000);
      pending.set(id, (value) => { clearTimeout(timer); res(value); });
      ws.send(JSON.stringify({ id, method, params }));
    });
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

  // 品牌更名：启动后名称与版本可见，侧边栏完整容纳中英文名称。
  const branding = await evalJs(`(() => {
    const brand = document.querySelector('.brand-name');
    return { name: brand?.textContent, title: document.title,
      fits: brand?.getBoundingClientRect().right <= document.querySelector('.sidebar').getBoundingClientRect().right };
  })()`);
  assert(branding.name === 'Dayfolio' && branding.title.startsWith('Dayfolio — ') && branding.fits, '中英文品牌与窗口标题正确，侧边栏未溢出');

  // ---------- 新闻（agent-only） ----------
  console.log('[smoke] 新闻（agent 任务闭环）');
  await clickUntil(nav('新闻'), () => evalJs(`document.querySelectorAll('.news3-row').length === 4`), 15000, '新闻列表（4 条演示数据：2 旧版 + 2 agent）');
  await clickUntil(
    `[...document.querySelectorAll('.news3-toolbar button')].find(b => b.textContent.includes('AI 采集'))?.click()`,
    () => evalJs(`document.querySelectorAll('.news3-request').length === 2`),
    15000, '采集请求卡渲染（已完成 + 待执行）',
  );
  assert(await evalJs(`[...document.querySelectorAll('.news3-request-status')].some(s => s.textContent.includes('未完成'))`), '旧未完成记录可见（未配置 Agent 不自动执行）');
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
  await clickUntil(nav('学习'), () => evalJs(`[...document.querySelectorAll('.plan-card')].some(c => c.textContent.includes('Dayfolio 五天上手计划'))`), 15000, '学习计划页出现演示计划卡');
  await clickUntil(
    `[...document.querySelectorAll('.study-home-tabs button')].find(b => b.textContent === '课程')?.click()`,
    () => evalJs(`[...document.querySelectorAll('.plan-course-entry')].some(c => c.textContent.includes('Dayfolio 上手之旅'))`),
    15000, '课程子视图出现演示课程入口',
  );
  await clickUntil(
    `[...document.querySelectorAll('.plan-course-entry')].find(c => c.textContent.includes('Dayfolio 上手之旅'))?.click()`,
    () => evalJs(`document.querySelector('.panel h1')?.textContent?.includes('Dayfolio 上手之旅')`),
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

  // 各首页以操作和状态定位；大、小窗口分别检查页头并保存真实渲染截图。
  const captureHeader = async (name) => {
    if (!process.env.DAYFOLIO_HEADER_SCREENSHOTS) return;
    const destination = resolve(process.env.DAYFOLIO_HEADER_SCREENSHOTS);
    mkdirSync(destination, { recursive: true });
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (!shot.result?.data) throw new Error('页头截图失败');
    writeFileSync(join(destination, `${name}.png`), Buffer.from(shot.result.data, 'base64'));
  };
  // 本轮功能：导航与时段输入走真实界面，读回走 IPC，所有写入仅在临时库。
  const navItems = await evalJs(`[...document.querySelectorAll('.nav .nav-item')].map(b => b.textContent.trim())`);
  assert(navItems.join('/') === '今日/待办/新闻/学习/知识库/自媒体/工具箱', '导航顺序与学习命名正确，无独立打卡菜单');
  await clickUntil(nav('待办'), () => evalJs(`!!document.querySelector('.todo-toolbar')`), 10000, '待办时段验收');
  const setField = async (label, value, select = false) => {
    await evalJs(`(() => { const el = document.querySelector('[aria-label="${label}"]');
      Object.getOwnPropertyDescriptor(${select ? 'HTMLSelectElement' : 'HTMLInputElement'}.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('${select ? 'change' : 'input'}', { bubbles: true })); })()`);
  };
  assert(await evalJs(`!document.querySelector('.todo-composer-details')`), '新增待办默认收起');
  await evalJs(`document.querySelector('[aria-label="待办标题"]').focus()`);
  await waitFor(() => evalJs(`!!document.querySelector('[aria-label="时间安排"]')`), 10000, '聚焦后展开待办排期');
  assert(await evalJs(`document.querySelector('[aria-label="时间安排"]').value === 'time' && document.querySelectorAll('.todo-schedule input[type=time]').length === 2`), '新增默认时间段，显示开始与结束时间');
  await setField('待办标题', '【验收】09点阅读');
  await evalJs(`document.querySelector('.composer .btn.primary').click()`);
  await waitFor(() => evalJs(`document.querySelector('.notice.error')?.textContent.includes('开始时间')`), 10000, '缺少时间阻止保存并提示');
  const nextDate = await evalJs(`(() => { const d = new Date(); d.setDate(d.getDate()+1); return d.toLocaleDateString('sv-SE'); })()`);
  await setField('安排日期', nextDate);
  await setField('开始时间', '09:00');
  await setField('结束时间', '10:30');
  await evalJs(`document.querySelector('.composer .btn.primary').click()`);
  await waitFor(() => evalJs(`[...document.querySelectorAll('.todo-card')].some(r => r.textContent.includes('【验收】09点阅读') && r.textContent.includes('09:00–10:30'))`), 10000, '新增时段显示');
  const timed = await evalJs(`window.tododesk.todos.list({ search: '【验收】09点阅读' })`);
  assert(timed.ok && timed.data[0].start_time === '09:00' && timed.data[0].end_time === '10:30', '起止时间经 IPC 保存并读回');
  await evalJs(`[...document.querySelectorAll('.todo-title')].find(el => el.textContent === '【验收】09点阅读').click()`);
  await setField('编辑结束时间', '08:00');
  await evalJs(`[...document.querySelectorAll('.todo-editor-actions .btn')].find(b => b.textContent === '保存待办').click()`);
  await waitFor(() => evalJs(`document.querySelector('.notice.error')?.textContent.includes('晚于')`), 10000, '倒序时间提示明确且保留编辑');
  await setField('编辑时间安排', 'date', true);
  await evalJs(`[...document.querySelectorAll('.todo-editor-actions .btn')].find(b => b.textContent === '保存待办').click()`);
  await waitFor(() => evalJs(`!document.querySelector('[aria-label="编辑时间安排"]') && [...document.querySelectorAll('.todo-card')].some(r => r.textContent.includes('【验收】09点阅读') && r.textContent.includes('仅日期'))`), 10000, '编辑切换仅日期');
  await evalJs(`[...document.querySelectorAll('.todo-title')].find(el => el.textContent === '【验收】09点阅读').click()`);
  await setField('编辑时间安排', 'time', true);
  await setField('编辑开始时间', '09:00');
  await setField('编辑结束时间', '10:30');
  await evalJs(`[...document.querySelectorAll('.todo-editor-actions .btn')].find(b => b.textContent === '保存待办').click()`);
  await waitFor(() => evalJs(`!document.querySelector('[aria-label="编辑时间安排"]')`), 10000, '编辑时段保存');
  // 完成另一条时段待办，保留一条未完成时段用于截图检查。
  const doneResult = await evalJs(`window.tododesk.todos.add({ title: '【验收】精确完成时间', due_date: ${JSON.stringify(nextDate)}, start_time: '11:00', end_time: '12:00' })`);
  assert(doneResult.ok, '创建隔离完成任务');
  await evalJs(`window.tododesk.todos.complete({ id: ${doneResult.data.id} })`);
  await evalJs(`[...document.querySelectorAll('.todo-toolbar button')].find(b => b.textContent === '记录').click()`);
  await waitFor(() => evalJs(`document.querySelector('[aria-label="打卡记录"]') && [...document.querySelectorAll('.checkin-card')].some(r => r.textContent.includes('【验收】精确完成时间'))`), 10000, '记录按钮进入现有记录页');
  assert(await evalJs(`[...document.querySelectorAll('.checkin-card')].find(r => r.textContent.includes('【验收】精确完成时间')).querySelector('time').textContent.match(/[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}/) !== null`), '完成记录展示精确到秒的时间');
  await captureHeader('待办-完成记录');
  await evalJs(`[...document.querySelectorAll('button')].find(b => b.textContent === '返回待办').click()`);
  await waitFor(() => evalJs(`!!document.querySelector('.todo-toolbar')`), 10000, '返回待办');

  // 补充隔离的逾期任务与打卡，覆盖实际使用中的列表、状态和长文案。
  await evalJs(`(() => {
    const date = new Date(); date.setDate(date.getDate() - 1);
    return window.tododesk.todos.add({ title: '整理课程笔记，补齐尚未完成的练习与问题记录', priority: 'high', due_date: date.toLocaleDateString('sv-SE'), tags: ['学习', 'plan:88'] });
  })()`);
  await evalJs(`window.tododesk.checkins.checkin({ ref_type: 'day', note: '完成一段学习，记下一个收获' })`);
  const homeReady = {
    今日: '.cal-weekview', 待办: '.todo-toolbar', 学习: '.study-home-tabs',
    新闻: '.news3-toolbar', 知识库: '.kb-toolbar', 自媒体: '.media-subnav',
    工具箱: '.panel', MCP: '.mcp-search', 数据: '.data-home', 帮助: '.help-layout',
  };
  for (const width of [1360, 880]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 680, deviceScaleFactor: 1, mobile: false });
    for (const [label, selector] of Object.entries(homeReady)) {
      await clickUntil(nav(label), () => evalJs(`!!document.querySelector(${JSON.stringify(selector)})`), 15000, `${label}首页`);
      await sleep(150);
      const layout = await evalJs(`(() => {
        const content = document.querySelector('.content');
        const head = content.querySelector('.panel-head, .news3-toolbar');
        const rect = content.getBoundingClientRect();
        return {
          titles: [...content.querySelectorAll('.panel-head h1')].map(el => el.textContent),
          scrollTop: content.scrollTop,
          outerScroll: document.scrollingElement.scrollTop,
          headTop: head?.getBoundingClientRect().top,
          contentTop: rect.top + parseFloat(getComputedStyle(content).paddingTop),
          overflow: head ? [...head.children].some(el => { const r = el.getBoundingClientRect(); return r.right > rect.right + 1 || r.left < rect.left - 1; }) : false,
        };
      })()`);
      if (layout.outerScroll !== 0 || layout.headTop < layout.contentTop - 1) console.log('页面位置诊断', label, width, JSON.stringify(layout));
      assert(layout.titles.length === 0 && !layout.overflow && layout.scrollTop === 0, `${width}px ${label}首页无重复大标题，操作栏无横向溢出且从顶部展示`);
      if (label === 'MCP') {
        assert(await evalJs(`(() => { const groups = [...document.querySelectorAll('.mcp-group')]; const text = document.querySelector('.content').textContent; return !text.includes('打卡与今日') && ![...document.querySelectorAll('.mcp-group-title')].some(h => ['学习计划','打卡'].includes(h.textContent.trim())) && groups.find(g => g.querySelector('.mcp-group-title')?.textContent.trim() === '待办')?.textContent.includes('get_checkin_stats'); })()`), 'MCP 完成记录归待办，无独立打卡与学习计划分组');
        const expectedVersion = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
        const expectedCount = JSON.parse(readFileSync(join(repo, 'apps/mcp/dist/agent-catalog.json'), 'utf8')).tools.length;
        await waitFor(() => evalJs(`document.querySelector('.content').textContent.includes(${JSON.stringify('随包 ' + expectedVersion)})`), 10000, '能力包版本检查');
        assert(await evalJs(`document.querySelectorAll('.mcp-tools li').length === ${expectedCount}`), 'App 工具目录数量与实际 MCP 注册一致');
        assert(await evalJs(`[...document.querySelectorAll('.mcp-group p.mono')].map(p => p.textContent).join(',') === 'dayfolio'`), '只展示一个统一 Dayfolio 技能');
        const kitStatus = await evalJs('window.tododesk.agent.status()');
        assert(kitStatus.ok && kitStatus.data.bundledVersion === expectedVersion && kitStatus.data.exportedVersion === null, '隔离 IPC 读回随包版本，未导出不冒称已安装');
        const search = async value => { await evalJs(`(() => { const el = document.querySelector('.mcp-search input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`); await sleep(100); };
        await search('get_today');
        assert(await evalJs("document.querySelectorAll('.mcp-tools li').length === 1 && document.querySelectorAll('.mcp-group p.mono').length === 0"), '按工具名筛选只显示匹配工具');
        await search('赛事');
        assert(await evalJs("document.querySelectorAll('.mcp-tools li').length === 0 && document.querySelectorAll('.mcp-group p.mono').length === 1 && !document.querySelector('.empty')"), '按内含赛事能力筛选可找到统一技能');
        await search('');
        if (width === 1360 && process.env.TODODESK_AGENT_SCREENSHOT) {
          const capture = await send('Page.captureScreenshot', { format: 'png' });
          writeFileSync(resolve(process.env.TODODESK_AGENT_SCREENSHOT), Buffer.from(capture.result.data, 'base64'));
        }
      }
      if (label === '数据') {
        assert(await evalJs(`!!document.querySelector('.data-home button') && [...document.querySelectorAll('.data-home .data-table tbody tr')].some(r => r.textContent.includes('todo') && r.textContent.includes('完成记录')) && ![...document.querySelectorAll('.data-home .data-table tbody tr')].some(r => r.querySelector('td.mono')?.textContent === 'checkin')`), '数据完成记录归待办行，不单列打卡');
      }
      if (label === '帮助') {
        assert(await evalJs(`(() => { const names = [...document.querySelectorAll('.help-toc-title')].map(b => b.textContent.trim()); return !names.some(n => n.includes('打卡')) && names.some(n => n.includes('学习')) && !names.some(n => n.includes('学习计划')); })()`), '帮助目录合并打卡，学习命名同步');
      }
      await captureHeader(`${width}-${label}`);
    }
  }

  // 调整后的关键控件仍能完成筛选，低频管理默认收起且可展开。
  await clickUntil(nav('待办'), () => evalJs(`!!document.querySelector('.todo-toolbar')`), 10000, '优先级筛选验收');
  await evalJs(`document.querySelector('[aria-label="待办标题"]').focus()`);
  await waitFor(() => evalJs(`!!document.querySelector('[aria-label="时间安排"]')`), 10000, '重新展开新增表单');
  await evalJs(`(() => { const el = document.querySelector('[aria-label="待办标题"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, '界面验收临时待办'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await setField('时间安排', 'date', true);
  await evalJs(`document.querySelector('.composer .btn.primary').click()`);
  await waitFor(() => evalJs(`[...document.querySelectorAll('.todo-title')].some(el => el.textContent === '界面验收临时待办')`), 10000, '新增输入区保存待办');
  await evalJs(`[...document.querySelectorAll('.todo-card')].find(el => el.querySelector('.todo-title')?.textContent === '界面验收临时待办').querySelector('.check').click()`);
  await waitFor(() => evalJs(`![...document.querySelectorAll('.todo-title')].some(el => el.textContent === '界面验收临时待办')`), 10000, '完成待办后列表刷新');
  assert(true, '新增输入与行式列表完成动作均可用');
  await evalJs(`(() => { const el = document.querySelector('[aria-label="筛选优先级"]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(el, 'high'); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(() => evalJs(`document.querySelectorAll('.todo-card').length === 1`), 10000, '高优先级过滤');
  assert(await evalJs(`document.querySelector('.todo-title')?.textContent.includes('整理课程笔记') && !document.querySelector('.todo-card-meta').textContent.includes('plan:88')`), '优先级下拉生效，列表隐藏自动关联标记');
  await clickUntil(nav('知识库'), () => evalJs(`!!document.querySelector('.kb-settings')`), 10000, '知识库管理验收');
  assert(await evalJs(`!document.querySelector('.kb-settings').open`), '知识库低频管理默认收起');
  await evalJs(`document.querySelector('.kb-settings summary').click()`);
  assert(await evalJs(`document.querySelector('.kb-settings').open && document.querySelector('.kb-settings-body').getBoundingClientRect().height > 0`), '管理展开后可见目录与管理操作');
  await evalJs(`document.querySelector('.kb-settings summary').click()`);
  await evalJs(`(() => { const el = document.querySelector('[aria-label="筛选知识层级"]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(el, 'fa'); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(() => evalJs(`document.querySelectorAll('.kb-note-row').length === 1`), 10000, '知识层级过滤');
  assert(await evalJs(`document.querySelector('.kb-note-title').textContent.includes('价值公式')`), '知识层级下拉生效');
  await clickUntil(nav('帮助'), () => evalJs(`!!document.querySelector('.help-layout')`), 10000, '帮助独立滚动复验');

  // 目录和正文的滚动互不影响；切换章节只重置正文，容器外部保持不滚动。
  await clickUntil(
    `[...document.querySelectorAll('.help-toc-item')].find(b => b.textContent.includes('MCP 与 AI 接入'))?.click()`,
    () => evalJs(`document.querySelector('.help-doc-title')?.textContent === 'MCP 与 AI 接入'`),
    10000, '独立滚动验收章节',
  );
  const scroll = await evalJs(`(() => {
    const toc = document.querySelector('.help-toc');
    const article = document.querySelector('.help-article');
    toc.scrollTop = 100;
    const tocBefore = toc.scrollTop;
    article.scrollTop = 180;
    const articleBefore = article.scrollTop;
    const tocAfterArticle = toc.scrollTop;
    toc.scrollTop = 160;
    return { tocBefore, tocAfterArticle, articleBefore, articleAfterToc: article.scrollTop, tocFinal: toc.scrollTop,
      outer: document.querySelector('.content').scrollTop, focusable: article.tabIndex === 0 };
  })()`);
  assert(scroll.tocBefore > 0 && scroll.articleBefore > 0 && scroll.tocBefore === scroll.tocAfterArticle && scroll.articleBefore === scroll.articleAfterToc && scroll.outer === 0 && scroll.focusable, '目录与正文独立滚动，正文可用键盘聚焦');
  await evalJs(`[...document.querySelectorAll('.help-toc-item')].find(b => b.textContent.includes('课程'))?.click()`);
  await waitFor(() => evalJs(`document.querySelector('.help-doc-title')?.textContent === '课程'`), 10000, '切换课程帮助');
  await sleep(100);
  assert(await evalJs(`document.querySelector('.help-article').scrollTop === 0 && document.querySelector('.help-toc').scrollTop === ${scroll.tocFinal}`), '切换章节正文回顶，目录位置保持');
  await captureHeader('880-帮助独立滚动');
  await send('Emulation.clearDeviceMetricsOverride');

  // ---------- 日历（今日页置顶：默认周视图，种子 4 条演示日程） ----------
  await clickUntil(nav('今日'), () => evalJs(`!!document.querySelector('.cal-weekview')`), 15000, '日历周视图渲染');
  await sleep(500);
  const calInfo = await evalJs(`(() => {
    const panel = document.querySelector('[aria-label=今日]');
    const cal = panel.querySelector('.cal-section');
    const firstGroup = panel.querySelector('.group:not(.cal-section)');
    const cols = [...document.querySelectorAll('.cal-col')];
    const today = new Date().toLocaleDateString('sv-SE');
    return {
      calendarFirst: !!cal && !!firstGroup && (cal.compareDocumentPosition(firstGroup) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      statRow: !!panel.querySelector('.stat-row'),
      dayCheckinBtn: [...panel.querySelectorAll('button')].some(b => b.textContent.includes('每日打卡')),
      weekview: !!document.querySelector('.cal-weekview'),
      cols: cols.length,
      modeSwitch: [...cal.querySelectorAll('.cal-toolbar .cal-mode-switch button')].map(b => b.textContent),
      agendaModes: [...cal.querySelectorAll('.cal-agenda-tabs button')].map(b => b.textContent),
      nowline: !!document.querySelector('.cal-nowline'),
      todayColHeads: document.querySelectorAll('.cal-wd-col.today-col').length,
      todayBlockText: cols[cols.findIndex(c => c.getAttribute('aria-label')?.startsWith(today))] ?.textContent ?? '',
      alldayText: document.querySelector('.cal-allday-lane')?.textContent ?? '',
      checkinPanelDayBtn: null,
    };
  })()`);
  console.log('日历周视图:', JSON.stringify(calInfo));
  assert(calInfo.calendarFirst, '日历置顶（行动列表在其后）');
  assert(!calInfo.statRow && !calInfo.dayCheckinBtn, '统计条与每日打卡按钮已移除');
  assert(calInfo.weekview && calInfo.cols === 7 && calInfo.modeSwitch.join('/') === '周/月', '默认周视图，7 列，周/月切换');
  assert(calInfo.agendaModes.join('/') === '今日/本周/本月', '事项范围切换独立于日历周/月视图');
  assert(calInfo.nowline && calInfo.todayColHeads === 1, '当前时刻红线与今天列标记');
  // 当前时刻尽量居中；凌晨和深夜须遵守滚动边界（先测，避免后续滚动破坏定位）。
  const centering = await evalJs(`(() => {
    const scroll = document.querySelector('.cal-scroll'); const line = document.querySelector('.cal-nowline');
    if (!scroll || !line) return null;
    const sr = scroll.getBoundingClientRect(); const lr = line.getBoundingClientRect();
    return { offset: Math.round(lr.top - (sr.top + sr.height / 2)),
      visible: lr.top >= sr.top && lr.top <= sr.bottom,
      atStart: scroll.scrollTop <= 1,
      atEnd: scroll.scrollTop >= scroll.scrollHeight - scroll.clientHeight - 1 };
  })()`);
  console.log('当前时刻居中偏差:', JSON.stringify(centering));
  assert(centering !== null && centering.visible && (Math.abs(centering.offset) < 60
    || (centering.atStart && centering.offset <= 0)
    || (centering.atEnd && centering.offset >= 0)), '当前时刻可见，空间允许时居中，边界处不越界');
  assert(await evalJs(`Math.abs(document.querySelector('.cal-scroll').getBoundingClientRect().height - 480) < 2`), '日历高度已调低（480px）');
  // 刻度轴在滚动容器内并随滚动 1:1 联动（测完还原原始滚动位置）
  // 从顶部滚固定距离：打开时当前时刻自动居中，下午/晚间初始位置已接近底部，
  // 若按「原位置 +400」滚动会被钳制到 maxScroll，剩余行程不足 100px 造成按时段误报
  const axisSync = await evalJs(`(() => {
    const scroll = document.querySelector('.cal-scroll');
    const axis = document.querySelector('.cal-axis');
    if (!scroll || !axis || !scroll.contains(axis)) return { inside: false };
    const original = scroll.scrollTop;
    scroll.scrollTop = 0;
    const before = axis.getBoundingClientRect().top;
    scroll.scrollTop = 400;
    const after = axis.getBoundingClientRect().top;
    const scrollDelta = scroll.scrollTop;
    scroll.scrollTop = original;
    return { inside: true, moved: Math.round(before - after), scrollDelta: Math.round(scrollDelta), maxScroll: Math.round(scroll.scrollHeight - scroll.clientHeight) };
  })()`);
  console.log('刻度联动诊断:', JSON.stringify(axisSync));
  assert(axisSync.inside && axisSync.scrollDelta > 100 && Math.abs(axisSync.moved - axisSync.scrollDelta) <= 1, `时间刻度轴随滚动 1:1 同步（轴 ${axisSync.moved}px / 滚动 ${axisSync.scrollDelta}px）`);
  assert(calInfo.todayBlockText.includes('【演示】晨会') && calInfo.todayBlockText.includes('09:30'), '今天列有定时日程块（晨会 09:30）');
  assert(calInfo.alldayText.includes('【演示】家庭日') && calInfo.alldayText.includes('【演示】外出培训'), '全天区有当天与跨天事件条');
  // 打卡面板：每日打卡入口移除（热力/记录保留）
  await clickUntil(nav('待办'), () => evalJs(`!!document.querySelector('.todo-toolbar')`), 10000, '待办页');
  await evalJs(`[...document.querySelectorAll('.todo-toolbar button')].find(b => b.textContent === '记录').click()`);
  await waitFor(() => evalJs(`!!document.querySelector('.checkin-hero')`), 10000, '待办完成记录页');
  assert(await evalJs(`!document.querySelector('.day-checkin') && !!document.querySelector('.heat-row')`), '打卡面板保留热力，无每日打卡入口');
  await clickUntil(nav('今日'), () => evalJs(`!!document.querySelector('.cal-weekview')`), 10000, '回到今日');
  // 当日明细统一通过标题进入业务编辑，验证实际表单和保留字段。
  await waitFor(() => evalJs(`[...document.querySelectorAll('.cal-ev-row')].some(r => r.textContent.includes('【演示】晨会') && r.textContent.includes('09:30') && r.querySelector('.cal-item-open'))`), 10000, '当日明细与日历查询就绪');
  assert(true, '当日明细可打开日程编辑');
  await evalJs(`[...document.querySelectorAll('.cal-ev-row')].find(r => r.textContent.includes('【演示】晨会')).querySelector('.cal-item-open').click()`);
  await clickUntil(`[...document.querySelectorAll('.cal-event-preview button')].find(b => b.textContent === '编辑日程')?.click()`, () => evalJs(`document.querySelector('.cal-form')?.getAttribute('aria-label') === '编辑日程'`), 10000, '详情浮层进入编辑');
  await waitFor(() => evalJs(`document.querySelector('.cal-form')?.getAttribute('aria-label') === '编辑日程'`), 10000, '既有日程编辑表单');
  assert(await evalJs(`document.querySelector('[aria-label="日程备注"]').value === '演示定时日程' && document.querySelector('[aria-label="开始时间"]').value === '09:30'`), '既有日程备注和钟点保留');
  await evalJs(`[...document.querySelectorAll('.cal-form .btn')].find(b => b.textContent.includes('取消')).click()`);
  // 周视图键盘新建草稿；指针点击与拖动由日历浮层专项验收覆盖。
  await evalJs(`(() => { const col = [...document.querySelectorAll('.cal-col')][3]; col.focus(); col.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await waitFor(() => evalJs(`!!document.querySelector('.cal-form')`), 10000, '空档草稿浮层');
  const slotForm = await evalJs(`(() => { const f = document.querySelector('.cal-form'); if (!f) return null; const allDay = f.querySelector('input[type=checkbox]'); const times = [...f.querySelectorAll('input[type=time]')].map(i => i.value); return { allDay: allDay.checked, times }; })()`);
  console.log('空档预填表单:', JSON.stringify(slotForm));
  assert(slotForm && slotForm.allDay === false && slotForm.times[0] === '09:00' && slotForm.times[1] === '09:15', '空档草稿预填 15 分钟时段');
  await evalJs(`[...document.querySelectorAll('.cal-form .btn')].find(b => b.textContent.includes('取消')).click()`);
  // 新建 → 出现 → 删除 → 消失（走真实 IPC）
  const calTitle = `【演示】冒烟日程 ${new Date().toLocaleTimeString('sv-SE')}`;
  await evalJs(`[...document.querySelectorAll('.cal-toolbar .btn')].find(b => b.textContent.includes('新建日程')).click()`);
  await waitFor(() => evalJs(`!!document.querySelector('.cal-form')`), 10000, '日程表单展开');
  await evalJs(`(() => { const el = document.querySelector('.cal-title-input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, ${JSON.stringify(calTitle)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evalJs(`(() => { const el = document.querySelector('.cal-form input[type=checkbox]'); el.click(); })()`); // 切回全天（不依赖时间粒度）
  await evalJs(`[...document.querySelectorAll('.cal-form .btn')].find(b => b.textContent.includes('创建日程')).click()`);
  await waitFor(() => evalJs(`[...document.querySelectorAll('.cal-ev-row')].some(r => r.textContent.includes(${JSON.stringify(calTitle)}))`), 10000, '新建日程落库并显示');
  assert(await evalJs(`document.querySelector('.cal-allday-lane').textContent.includes(${JSON.stringify(calTitle)})`), '全天日程进入周视图全天区');
  await evalJs(`[...document.querySelectorAll('.cal-ev-row')].find(r => r.textContent.includes(${JSON.stringify(calTitle)})).querySelector('.cal-item-open').click()`);
  await clickUntil(`[...document.querySelectorAll('.cal-event-preview button')].find(b => b.textContent === '编辑日程')?.click()`, () => evalJs(`document.querySelector('.cal-form')?.getAttribute('aria-label') === '编辑日程'`), 10000, '详情浮层进入编辑');
  await waitFor(() => evalJs(`document.querySelector('.cal-form')?.getAttribute('aria-label') === '编辑日程'`), 10000, '新建日程编辑入口');
  await evalJs(`[...document.querySelectorAll('.cal-form .btn')].find(b => b.textContent.includes('删除')).click()`);
  await waitFor(() => evalJs(`![...document.querySelectorAll('.cal-ev-row')].some(r => r.textContent.includes(${JSON.stringify(calTitle)}))`), 10000, '删除日程后消失');
  // 切月视图复验
  await evalJs(`[...document.querySelectorAll('.cal-mode-switch button')].find(b => b.textContent === '月').click()`);
  await waitFor(() => evalJs(`!!document.querySelector('.cal-grid')`), 10000, '切换月视图');
  assert(await evalJs(`document.querySelectorAll('.cal-cell').length >= 35`), '月视图网格渲染');
  await evalJs(`[...document.querySelectorAll('.cal-mode-switch button')].find(b => b.textContent === '周').click()`);
  await waitFor(() => evalJs(`!!document.querySelector('.cal-weekview')`), 10000, '切回周视图');
  await captureHeader('880-日历周视图');

  if (process.env.TODODESK_SMOKE_SCREENSHOT) {
    await clickUntil(nav('今日'), () => evalJs(`!!document.querySelector('[aria-label=今日] .cal-weekview')`), 15000, '今日演示页');
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
