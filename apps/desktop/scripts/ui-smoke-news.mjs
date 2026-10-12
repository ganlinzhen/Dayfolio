#!/usr/bin/env node
// 新闻面板（agent-only）UI 冒烟（隔离运行，绝不触碰真实数据）：
//   1. 临时 TODODESK_DB + TODODESK_USER_DATA + 隔离 HOME；先用 core（临时打包）按真实服务路径造数：
//      旧版历史新闻（含收藏）+ 已完成任务（2 条 agent 新闻）+ 待执行任务；
//   2. 拉起 Electron（CDP 动态空闲端口），纯文本断言：AI 采集页/请求卡、发布时间倒序、
//      单行工具栏、滚动分页、收藏视图保留旧收藏、采集结果过滤、列表/详情独立切换、内嵌原文安全属性、
//      **无任何抓取/源配置/定时入口**；
//   3. 无截图、无外部图像分析；写入只落临时库。
// 前置：npm run build:web && (cd apps/desktop && node scripts/build.mjs)
// 用法：node apps/desktop/scripts/ui-smoke-news.mjs
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const repo = resolve(new URL('../../../', import.meta.url).pathname);

const freePort = () =>
  new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => res(port)); });
    srv.on('error', rej);
  });
const PORT = await freePort();

// ---------- 隔离红线：临时目录硬校验（启动任何子进程之前） ----------
const work = mkdtempSync(join(tmpdir(), 'td-news-smoke-'));
const dbPath = join(work, 'smoke.db');
if (!resolve(dbPath).startsWith(resolve(tmpdir())) || resolve(dbPath).includes('Application Support')) {
  console.error('[smoke] 临时库路径硬校验失败，拒绝启动');
  rmSync(work, { recursive: true, force: true });
  process.exit(2);
}
mkdirSync(join(work, 'home'), { recursive: true });
const isolatedEnv = {
  PATH: process.env.PATH,
  TMPDIR: process.env.TMPDIR,
  HOME: join(work, 'home'),
  TODODESK_DB: dbPath,
  TODODESK_USER_DATA: join(work, 'userData'),
};
if (!isolatedEnv.HOME.startsWith(tmpdir()) || !isolatedEnv.TODODESK_USER_DATA.startsWith(tmpdir())) {
  console.error('[smoke] 子进程环境断言失败（隔离缺失即拒绝启动）');
  rmSync(work, { recursive: true, force: true });
  process.exit(2);
}

// ---------- 造数（真实服务路径：createTask → claim → submit → complete + 旧版历史行） ----------
const seedSrc = join(work, 'seed.ts');
writeFileSync(
  seedSrc,
  `
import { DatabaseSync } from 'node:sqlite';
import { openNodeSqliteDb } from '${join(repo, 'packages/core/src/adapters/node-sqlite')}';
import { createCore } from '${join(repo, 'packages/core/src/index')}';
const dbPath = process.argv[2];
if (dbPath !== ${JSON.stringify(dbPath)}) process.exit(3);
const core = createCore(openNodeSqliteDb(dbPath), { dbPath });
// 旧版历史行：一条 3 天前的收藏 + 一条 2 天前的普通（均无精确发布时间，模拟旧抓取数据）
const raw = new DatabaseSync(dbPath);
const daysAgo = (n: number) => {
  const d = new Date(Date.now() - n * 86400_000);
  return d.toISOString().slice(0, 10);
};
raw.prepare("INSERT INTO news (source, title, url, summary, published_date, fetched_at, dedup_key, is_starred) VALUES ('zhihu_daily', ?, 'https://old.example.com/starred', '旧收藏摘要', ?, '2026-10-01T00:00:00.000', 'smoke:legacy:starred', 1)").run('冒烟旧闻：值得收藏的一条', daysAgo(3));
raw.prepare("INSERT INTO news (source, title, url, summary, published_date, fetched_at, dedup_key) VALUES ('hacker_news', ?, 'https://old.example.com/plain', '旧普通摘要', ?, '2026-10-01T00:00:00.000', 'smoke:legacy:plain')").run('冒烟旧闻：普通的一条', daysAgo(2));
for (let i = 0; i < 35; i++) {
  raw.prepare("INSERT INTO news (source, title, url, summary, published_date, fetched_at, dedup_key) VALUES ('hacker_news', ?, ?, '分页旧闻摘要', ?, '2026-10-01T00:00:00.000', ?)").run(
    '冒烟分页旧闻 ' + String(i + 1).padStart(2, '0'),
    'https://old.example.com/page-' + (i + 1),
    daysAgo(10 + i),
    'smoke:legacy:page:' + (i + 1),
  );
}
raw.close();
// 已完成任务：2 条 agent 新闻（真实提交路径）
const task = core.news.createTask({ title: '冒烟任务：已完成收录', instructions: '冒烟规则', max_items: 5 });
const claim = core.news.claimTask(task.id, 'smoke-agent');
core.news.submitItems(task.id, claim.claim_token, [
  { title: '冒烟 agent 新闻一', summary: '近一小时的核实摘要。', source_url: 'https://example.com/smoke-1', source_name: 'Example News', published_at: new Date(Date.now() - 3600_000).toISOString() },
  { title: '冒烟 agent 新闻二', summary: '近两小时的核实摘要。', source_url: 'https://example.com/smoke-2', source_name: 'Example News', published_at: new Date(Date.now() - 7200_000).toISOString() },
]);
core.news.completeTask(task.id, claim.claim_token, '冒烟完成');
// 待执行任务（离线保持待执行，App 只展示）
core.news.createTask({ title: '冒烟任务：待执行', instructions: '等待下一会话认领' });
core.db.close();
console.log('seeded');
`,
);
const seedCjs = join(work, 'seed.cjs');
await build({ entryPoints: [seedSrc], outfile: seedCjs, bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['node:*'], logLevel: 'silent' });
await new Promise((res, rej) => {
  const seedRun = spawn(process.execPath, [seedCjs, dbPath], { env: isolatedEnv, stdio: ['ignore', 'inherit', 'inherit'] });
  seedRun.on('exit', (code) => (code === 0 ? res() : rej(new Error(`造数失败：exit ${code}`))));
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
      const news = sdb.prepare('SELECT COUNT(*) AS n FROM news').get();
      const starred = sdb.prepare('SELECT COUNT(*) AS n FROM news WHERE is_starred = 1').get();
      const agent = sdb.prepare("SELECT COUNT(*) AS n FROM news WHERE source = 'agent'").get();
      const tasks = sdb.prepare("SELECT COUNT(*) AS n FROM news_tasks WHERE status = 'completed'").get();
      const fps = sdb.prepare('SELECT COUNT(*) AS n FROM news_deleted_fingerprints').get();
      sdb.close();
      if (agent.n !== 0 || fps.n !== 4) {
        failed = true;
        console.error(`  ✗ 隔离落库校验失败：删除后应 agent=0、指纹=4，实际 agent=${agent.n} 指纹=${fps.n}`);
      }
      console.log(`  ✓ 隔离落库校验：news=${news.n}（agent ${agent.n}，已全删）starred=${starred.n} 已完成任务=${tasks.n} 删除指纹=${fps.n}（全部只落在临时库）`);
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
  const clickChip = (label) =>
    `[...document.querySelectorAll('.news3-toolbar .seg .seg-item')].find(b => b.textContent.includes('${label}'))?.click()`;

  await waitFor(() => evalJs(`!!document.querySelector('.nav-item')`), 15000, '应用启动');

  // ---------- 新闻面板（agent-only） ----------
  console.log('[smoke] 新闻面板（agent-only）');
  await clickUntil(nav('新闻'), () => evalJs(`document.querySelectorAll('.news3-row').length === 30`), 15000, '默认按发布时间倒序并加载第一页（30 条）');
  assert(await evalJs(`document.querySelectorAll('.news3-row .ref-badge')[0]?.textContent.includes('Example News')`), 'agent 条目展示来源站点名');
  assert(await evalJs(`document.querySelectorAll('.news3-row-title')[0]?.textContent.includes('冒烟 agent 新闻一')`), '同日新闻按精确发布时间倒序');
  assert(await evalJs(`![...document.querySelectorAll('.news3-toolbar .seg .seg-item')].some(s => s.textContent.includes('近 24 小时') || s.textContent.includes('历史'))`), '无近 24 小时 / 历史时间筛选');
  assert(await evalJs(`![...document.querySelectorAll('button')].some(b => b.textContent.includes('刷新列表'))`), '无手动刷新列表按钮');
  assert(await evalJs(`(() => { const chips = document.querySelector('.news3-toolbar .seg')?.getBoundingClientRect(); const search = document.querySelector('.news3-search')?.getBoundingClientRect(); return !!chips && !!search && Math.abs(chips.top + chips.height / 2 - (search.top + search.height / 2)) < 3; })()`), '筛选与搜索合并在同一行');
  assert(await evalJs(`!!document.querySelector('[aria-label="新闻列表页"]') && !document.querySelector('[aria-label="新闻详情页"]')`), '初始只显示完整列表页');
  assert(await evalJs(`(() => { const panel = document.querySelector('.news3').getBoundingClientRect(); const list = document.querySelector('.news3-list').getBoundingClientRect(); return Math.abs(panel.width - list.width) < 2; })()`), '列表页占满新闻内容区宽度');

  // AI 采集是独立页面，不再混入新闻筛选 chips
  assert(await evalJs(`![...document.querySelectorAll('.news3-toolbar .seg .seg-item')].some(s => s.textContent.includes('任务'))`), '采集入口不与新闻筛选混排');
  await clickUntil(
    `[...document.querySelectorAll('.news3-toolbar button')].find(b => b.textContent.includes('AI 采集'))?.click()`,
    () => evalJs(`!!document.querySelector('[aria-label="AI 采集页"]') && !document.querySelector('[aria-label="新闻列表页"]')`),
    10000,
    '打开独立 AI 采集页',
  );
  assert(await evalJs(`document.querySelectorAll('.news3-request').length === 2`), '采集请求卡渲染（等待 AI + 已完成）');
  assert(await evalJs(`[...document.querySelectorAll('.news3-request-status')].some(s => s.textContent.includes('等待 AI'))`), '等待 AI 状态可见（离线保持等待）');
  assert(await evalJs(`[...document.querySelectorAll('.news3-request-status')].some(s => s.textContent.includes('已完成'))`), '已完成状态可见');
  assert(await evalJs(`[...document.querySelectorAll('.news3-request-count')].some(s => s.textContent.includes('已收录 2 篇') && s.textContent.includes('上限 5 篇'))`), '采集结果进度显示（已收录 2 篇 / 上限 5 篇）');
  assert(await evalJs(`document.body.textContent.includes('不联网抓取') || document.body.textContent.includes('AI 助手')`), 'agent-only 说明文案可见');

  // 无抓取/源配置/定时入口（结构性断言）
  assert(await evalJs(`!document.querySelector('.news3-drawer')`), '无源与定时设置抽屉');
  assert(await evalJs(`![...document.querySelectorAll('button')].some(b => b.textContent.includes('联网抓取'))`), '无「联网抓取」按钮');
  assert(await evalJs(`![...document.querySelectorAll('button')].some(b => b.textContent.includes('源与定时'))`), '无「源与定时设置」入口');

  // 用户在 App 创建采集请求（发起走同一 core 硬校验；执行仍是 agent 经 MCP）
  await clickUntil(
    `[...document.querySelectorAll('button')].find(b => b.textContent.includes('新建采集'))?.click()`,
    () => evalJs(`!!document.querySelector('[aria-label="新建 AI 采集请求"]')`),
    10000, '新建采集表单打开',
  );
  await evalJs(`(() => { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; const i = document.querySelector('[aria-label="采集主题"]'); s.call(i, '冒烟：用户在 App 创建的采集'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evalJs(`(() => { const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; const t = document.querySelector('[aria-label="给 AI 的要求"]'); s.call(t, '只要一手来源'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await clickUntil(
    `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '创建采集请求')?.click()`,
    () => evalJs(`[...document.querySelectorAll('.news3-request')].some(t => t.textContent.includes('用户在 App 创建的采集') && t.textContent.includes('等待 AI'))`),
    10000, '采集请求创建成功并显示「等待 AI」（App 发起，同一 core 硬校验）',
  );
  assert(await evalJs(`document.body.textContent.includes('采集请求已创建')`), '创建后提示：等待下一次 AI 会话执行');
  assert(await evalJs(`[...document.querySelectorAll('.news3-request')].some(t => t.textContent.includes('来自 App'))`), '采集卡标注「来自 App」来源');
  assert(await evalJs(`![...document.querySelectorAll('button')].some(b => b.textContent.includes('认领') || b.textContent.includes('提交新闻'))`), 'App 无认领/提交入口（执行是 agent 经 MCP 的专属动作）');
  await clickUntil(
    `[...document.querySelectorAll('.news3-back')].find(b => b.textContent.includes('返回新闻'))?.click()`,
    () => evalJs(`!!document.querySelector('[aria-label="新闻列表页"]') && !document.querySelector('[aria-label="AI 采集页"]')`),
    10000,
    '返回新闻列表',
  );

  // 滚动到底部自动加载第二页；总数不足两整页时停在 39 条
  await evalJs(`document.querySelector('.news3-scroll')?.scrollTo({ top: 1000000, behavior: 'instant' })`);
  await waitFor(() => evalJs(`document.querySelectorAll('.news3-row').length === 39`), 10000);
  console.log('  ✓ 滚动到底部自动加载第二页（39 条）');

  // 收藏视图：旧收藏保留可见
  await clickUntil(clickChip('收藏'), () => evalJs(`document.querySelectorAll('.news3-row').length === 1 && document.querySelectorAll('.news3-row')[0].textContent.includes('值得收藏')`), 10000, '收藏视图保留旧收藏（1 条）');

  // 回到 24h 视图（先重置筛选为全部），点任务 → 任务过滤
  await clickUntil(clickChip('全部'), () => evalJs(`document.querySelectorAll('.news3-row').length === 30`), 10000, '切回全部并重置分页');
  await clickUntil(
    `[...document.querySelectorAll('.news3-toolbar button')].find(b => b.textContent.includes('AI 采集'))?.click()`,
    () => evalJs(`!!document.querySelector('[aria-label="AI 采集页"]')`),
    10000,
    '重新打开 AI 采集页',
  );
  await clickUntil(
    `[...document.querySelectorAll('.news3-request')].find(t => t.textContent.includes('已完成收录'))?.querySelector('.news3-request-actions button')?.click()`,
    () => evalJs(`!!document.querySelector('.news3-collection-filter')`),
    10000, '点击「查看 N 篇」→ 只看该次采集结果',
  );
  assert(await evalJs(`document.querySelector('.news3-collection-filter').textContent.includes('来自采集') && document.querySelector('.news3-collection-filter').textContent.includes('2 篇')`), '列表显示来自采集的过滤条');

  // 阅读详情：标题 + 摘要 + 内嵌原文 + 外部打开兜底
  await clickUntil(
    `[...document.querySelectorAll('.news3-row')].find(r => r.textContent.includes('冒烟 agent 新闻一'))?.click()`,
    () => evalJs(`!!document.querySelector('.news3-title')`),
    10000, '阅读详情打开',
  );
  assert(await evalJs(`document.querySelector('.news3-title').textContent.includes('冒烟 agent 新闻一')`), '详情标题正确');
  assert(await evalJs(`document.querySelector('.news3-title').getBoundingClientRect().top < document.querySelector('.news3-detail-meta').getBoundingClientRect().top`), '新闻标题位于来源时间行上方');
  assert(await evalJs(`!!document.querySelector('[aria-label="新闻详情页"]') && !document.querySelector('[aria-label="新闻列表页"]')`), '详情页独立显示，列表页不占宽度');
  assert(await evalJs(`(() => { const panel = document.querySelector('.news3').getBoundingClientRect(); const detail = document.querySelector('.news3-detail').getBoundingClientRect(); return Math.abs(panel.width - detail.width) < 2; })()`), '详情页占满新闻内容区宽度');
  assert(await evalJs(`[...document.querySelectorAll('.news3-detail .btn')].some(b => b.textContent.includes('打开原文'))`), '原始来源入口存在');
  assert(await evalJs(`(() => { const view = document.querySelector('.news3-source-view'); return !!view && view.getAttribute('src') === 'https://example.com/smoke-1'; })()`), '详情页内嵌原文 webview 存在并指向原始来源');
  assert(await evalJs(`(() => { const view = document.querySelector('.news3-source-view'); return view?.getAttribute('partition') === 'news-source' && view.getAttribute('allowpopups') !== 'true'; })()`), '原文 webview 使用隔离会话且未开启弹窗');
  assert(await evalJs(`(() => { const frame = document.querySelector('.news-source-embed'); const toolbar = frame?.querySelector('.embed-frame-toolbar'); const body = frame?.querySelector('.embed-frame-body'); const view = frame?.querySelector('.news3-source-view'); if (!frame || !toolbar || !body || !view) return false; const a = frame.getBoundingClientRect(); const t = toolbar.getBoundingClientRect(); const b = body.getBoundingClientRect(); const c = view.getBoundingClientRect(); return a.height > 300 && Math.abs(a.height - t.height - b.height) < 3 && Math.abs(b.height - c.height) < 3; })()`), '原文 webview 占满内嵌容器剩余高度');
  assert(await evalJs(`[...document.querySelectorAll('.news-source-embed .embed-fullscreen-button')].some(b => b.textContent.includes('全屏'))`), '原文区域提供统一全屏按钮');
  const webviewViewport = await evalJs(`document.querySelector('.news3-source-view')?.executeJavaScript('({ innerHeight: window.innerHeight, scrollHeight: document.documentElement.scrollHeight })')`);
  const embedFrameBox = await evalJs(`document.querySelector('.news-source-embed')?.getBoundingClientRect().toJSON()`);
  const webviewHostBox = await evalJs(`document.querySelector('.news3-source-view')?.getBoundingClientRect().toJSON()`);
  const appViewportHeight = await evalJs(`window.innerHeight`);
  assert(embedFrameBox.bottom > appViewportHeight * 0.92 && embedFrameBox.bottom <= appViewportHeight, `原文容器延伸到视口底部、下方无大片空白（bottom ${Math.round(embedFrameBox.bottom)} / ${appViewportHeight}px）`);
  assert(Math.abs(webviewHostBox.height - webviewViewport.innerHeight) <= 2, `guest 视口跟随容器高度（host ${Math.round(webviewHostBox.height)}px / guest ${webviewViewport.innerHeight}px）`);
  await clickUntil(
    `document.querySelector('.news-source-embed .embed-fullscreen-button')?.click()`,
    () => evalJs(`document.querySelector('.news-source-embed')?.classList.contains('is-fullscreen')`),
    10000,
    '原文进入应用内全屏',
  );
  assert(await evalJs(`(() => { const frame = document.querySelector('.news-source-embed'); const sidebar = document.querySelector('.sidebar'); if (!frame || !sidebar) return false; const r = frame.getBoundingClientRect(); return Math.abs(r.left - sidebar.getBoundingClientRect().right) < 2 && r.top === 0 && Math.abs(r.bottom - window.innerHeight) < 2; })()`), '全屏原文占满侧边栏右侧内容区');
  await clickUntil(
    `document.querySelector('.news-source-embed .embed-fullscreen-button')?.click()`,
    () => evalJs(`!document.querySelector('.news-source-embed')?.classList.contains('is-fullscreen')`),
    10000,
    '退出原文应用内全屏',
  );
  await clickUntil(
    `[...document.querySelectorAll('.news3-back')].find(b => b.textContent.includes('返回列表'))?.click()`,
    () => evalJs(`!!document.querySelector('[aria-label="新闻列表页"]') && !document.querySelector('[aria-label="新闻详情页"]')`),
    10000, '返回独立列表页',
  );
  assert(await evalJs(`!!document.querySelector('.news3-collection-filter') && document.querySelectorAll('.news3-row').length === 2`), '返回后保留采集筛选与列表结果');

  // ---------- 自适应高度与窗口尺寸变化（列表容器吃满剩余高度，无底部大片空白） ----------
  console.log('[smoke] 自适应高度与窗口尺寸变化');
  await clickUntil(
    `document.querySelector('.news3-collection-filter .icon-btn')?.click()`,
    () => evalJs(`document.querySelectorAll('.news3-row').length === 30`),
    10000, '清除采集筛选回到全部列表',
  );
  assert(await evalJs(`(() => { const c = document.querySelector('.content'); const l = document.querySelector('.news3-list'); return !!c && !!l && c.clientHeight > 400 && Math.abs(c.clientHeight - l.clientHeight) < 2; })()`), '列表容器吃满内容区高度（去掉底部固定占位空白）');
  // Electron CDP 不支持 Browser.setWindowBounds，无法脚本化改窗口尺寸；
  // 改为断言高度链由视口驱动（无固定像素高容器）：任意窗口尺寸下列表都吃满剩余高度并内部滚动。
  assert(await evalJs(`(() => { const c = document.querySelector('.content'); return c.clientHeight === window.innerHeight; })()`), '内容区高度与视口一致（无固定像素高度，随窗口尺寸自适应）');
  assert(await evalJs(`(() => { const cs = getComputedStyle(document.querySelector('.content')); const ns = getComputedStyle(document.querySelector('.news3-scroll')); return cs.display === 'flex' && cs.overflow === 'hidden' && ns.overflowY === 'auto'; })()`), '列表滚动发生在内部容器（内容区不整体滚动）');
  assert(await evalJs(`(() => { const sc = document.querySelector('.news3-scroll'); return sc.scrollHeight > sc.clientHeight; })()`), '长列表在内部滚动（窗口缩小同样适用：高度链全部由视口推导）');

  // ---------- 返回列表保留滚动位置 ----------
  await evalJs(`document.querySelector('.news3-scroll')?.scrollTo({ top: 480, behavior: 'instant' })`);
  await sleep(300);
  await clickUntil(
    `[...document.querySelectorAll('.news3-row')][0]?.click()`,
    () => evalJs(`!!document.querySelector('.news3-title')`),
    10000, '打开详情（记录滚动位置）',
  );
  await clickUntil(
    `[...document.querySelectorAll('.news3-back')].find(b => b.textContent.includes('返回列表'))?.click()`,
    () => evalJs(`!!document.querySelector('[aria-label="新闻列表页"]')`),
    10000, '返回列表',
  );
  await waitFor(() => evalJs(`Math.abs(document.querySelector('.news3-scroll')?.scrollTop - 480) < 30`), 5000);
  console.log('  ✓ 返回列表后保留滚动位置（约 480px）');

  // ---------- 删除：详情入口 + 列表入口 + 空列表 + 筛选安全（只删临时库造数条目） ----------
  console.log('[smoke] 删除新闻（列表/详情入口）');
  await clickUntil(
    `[...document.querySelectorAll('.news3-toolbar button')].find(b => b.textContent.includes('AI 采集'))?.click()`,
    () => evalJs(`!!document.querySelector('[aria-label="AI 采集页"]')`),
    10000, '打开 AI 采集页',
  );
  await clickUntil(
    `[...document.querySelectorAll('.news3-request')].find(t => t.textContent.includes('已完成收录'))?.querySelector('.news3-request-actions button')?.click()`,
    () => evalJs(`!!document.querySelector('.news3-collection-filter') && document.querySelectorAll('.news3-row').length === 2`),
    10000, '回到该采集的 2 条结果',
  );
  await clickUntil(
    `[...document.querySelectorAll('.news3-row')].find(r => r.textContent.includes('冒烟 agent 新闻二'))?.click()`,
    () => evalJs(`!!document.querySelector('.news3-title')`),
    10000, '打开新闻二详情（准备从详情删除）',
  );
  assert(await evalJs(`[...document.querySelectorAll('.news3-detail-meta .btn')].some(b => b.textContent.trim() === '删除')`), '详情页有删除入口');
  assert(await evalJs(`!document.body.textContent.includes('摘要由提交任务的 AI 助手核实撰写')`), '详情页无固定「摘要由 AI 核实」说明文案');
  await evalJs(`window.confirm = () => true`); // 冒烟环境自动同意「不可恢复」确认框
  await clickUntil(
    `[...document.querySelectorAll('.news3-detail-meta .btn')].find(b => b.textContent.trim() === '删除')?.click()`,
    () => evalJs(`!!document.querySelector('[aria-label="新闻列表页"]') && document.querySelectorAll('.news3-row').length === 1`),
    10000, '详情删除后自动返回列表（该采集剩 1 条）',
  );
  assert(await evalJs(`!!document.querySelector('.news3-collection-filter')`), '删除返回后仍保留采集筛选');
  await waitFor(() => evalJs(`document.body.textContent.includes('已删除该新闻')`), 4000);
  console.log('  ✓ 删除成功提示可见');
  assert(await evalJs(`document.querySelectorAll('.news3-row-del').length === 1`), '列表行悬停删除按钮存在');
  await clickUntil(
    `document.querySelectorAll('.news3-row-del')[0]?.click()`,
    () => evalJs(`document.querySelectorAll('.news3-row').length === 0 && !!document.querySelector('.news3-scroll .empty')`),
    10000, '列表删除最后一条 → 空列表占位',
  );
  await clickUntil(
    `document.querySelector('.news3-collection-filter .icon-btn')?.click()`,
    () => evalJs(`document.querySelectorAll('.news3-row').length === 30`),
    10000, '清除筛选：旧新闻仍在（删除只影响目标条目）',
  );

  console.log('[smoke] 全部断言通过');
  await stopAndCleanup(true);
  process.exit(failed ? 1 : 0);
} catch (e) {
  failed = true;
  console.error(`[smoke] 失败：${e instanceof Error ? e.message : e}`);
  await stopAndCleanup(false);
  process.exit(1);
}
