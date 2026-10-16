#!/usr/bin/env node
// 数据面板 UI 冒烟（隔离运行，绝不触碰真实数据）：
//   1. 以临时 TODODESK_DB + TODODESK_USER_DATA + 隔离 HOME 拉起 Electron（CDP 用动态空闲端口，
//      杜绝与残留 Electron/他人 dev 窗口的端口碰撞）——旧版本附着 9223 端口的现有窗口，
//      若那是连着真实库的 dev 窗口，IPC 写操作会直接写进用户真实数据库（红线，已废弃该方式）；
//   2. CDP 界面断言与可选截图：数据首页、对象类型详情、关系与动作归属、搜索分页与关联跳转，
//      以及数据 IPC 全链路（建自定义类型→改类型→建动作→执行→校验→清理，全部只落临时库）；
//   3. 结束前断言冒烟对象类型在临时库中已清理、且全部写入只发生在临时库。
// 前置：npm run build:web && (cd apps/desktop && node scripts/build.mjs)
// 用法：node apps/desktop/scripts/ui-smoke-data.mjs
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(new URL('../../../', import.meta.url).pathname);

// 动态空闲端口：固定端口会与残留 Electron / 他人调试窗口碰撞（CDP 连错窗口，断言全部失真）
const freePort = () =>
  new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => res(port)); });
    srv.on('error', rej);
  });
const PORT = await freePort();

// ---------- 隔离红线：临时目录硬校验（启动任何子进程之前） ----------
const work = mkdtempSync(join(tmpdir(), 'td-data-smoke-'));
const dbPath = join(work, 'smoke.db');
if (!resolve(dbPath).startsWith(resolve(tmpdir())) || resolve(dbPath).includes('Application Support')) {
  console.error('[smoke] 临时库路径硬校验失败，拒绝启动');
  rmSync(work, { recursive: true, force: true });
  process.exit(2);
}
mkdirSync(join(work, 'home'), { recursive: true });
const isolatedEnv = { PATH: process.env.PATH, HOME: join(work, 'home'), TODODESK_DB: dbPath };

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

// 管道消费者提前关闭时 stdout 收到 SIGPIPE 会杀死本脚本、跳过 finally、残留 Electron——忽略之
process.on('SIGPIPE', () => {});
// 兜底：未捕获异常也要停 App、清临时目录再退出
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
/** 停止 Electron 并清理临时目录（幂等；runDbCheck=true 时先做隔离落库断言再删目录） */
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
    // 隔离落库断言：冒烟对象类型只在临时库出现且已清理（真实库绝无触碰）
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const sdb = new DatabaseSync(dbPath, { readOnly: true });
      const left = sdb.prepare("SELECT COUNT(*) AS n FROM ont_object_types WHERE api_name LIKE 'smoke_%'").get();
      sdb.close();
      if (Number(left?.n ?? 1) === 0) console.log('  ✓ 隔离落库：smoke_* 类型已在临时库中清理干净');
      else { failed = true; console.error(`  ✗ 隔离落库断言失败：临时库残留 smoke_* 类型 ${left?.n} 个`); }
    } catch (e) {
      console.warn(`  ⚠ 临时库只读校验跳过：${e.message}`);
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
  /** 重试点击直到就绪（应用启动初期 React 事件处理器可能尚未挂好） */
  const clickUntil = async (clickExpr, readyFn, ms, label) => {
    const t0 = Date.now();
    for (;;) {
      try { await evalJs(clickExpr); } catch { /* 目标未渲染，稍后重试 */ }
      try { if (await readyFn()) return; } catch { /* 就绪条件评估失败，重试 */ }
      if (Date.now() - t0 > ms) throw new Error(`点击超时：${label}\n${stderrTail}`);
      await sleep(400);
    }
  };
  const setTab = async (key) => {
    await evalJs(`document.getElementById('data-tab-${key}')?.click()`);
    await waitFor(() => evalJs(`document.getElementById('data-tab-${key}')?.getAttribute('aria-selected') === 'true'`), 10000, `切换详情页签 ${key}`);
  };
  const openType = async (apiName) => {
    await evalJs(`document.querySelector('.data-head button')?.textContent.includes('返回') && document.querySelector('.data-head button').click()`);
    await waitFor(() => evalJs(`!document.querySelector('.data-home')?.hidden`), 10000, '返回首页');
    await evalJs(`[...document.querySelectorAll('.data-home .data-table tbody tr')].find(r => r.querySelector('.mono')?.textContent === '${apiName}')?.querySelector('.data-type-link').click()`);
    await waitFor(() => evalJs(`document.querySelector('.data-head .mono')?.textContent === '${apiName}'`), 10000, `打开类型 ${apiName}`);
  };
  const capture = async (name) => {
    if (!process.env.DAYFOLIO_SMOKE_SCREENSHOTS) return;
    mkdirSync(process.env.DAYFOLIO_SMOKE_SCREENSHOTS, { recursive: true });
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (!shot.result?.data) throw new Error('截图失败');
    writeFileSync(join(process.env.DAYFOLIO_SMOKE_SCREENSHOTS, `${name}.png`), Buffer.from(shot.result.data, 'base64'));
  };

  // 1. 进入数据面板
  await waitFor(() => evalJs(`!!document.querySelector('.nav-item')`), 15000, '应用启动');
  await clickUntil(
    `[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('数据'))?.click()`,
    () => evalJs(`!!document.querySelector('.data-view .data-home') && !document.querySelector('.data-home').hidden`),
    15000, '数据面板打开',
  );
  await waitFor(() => evalJs(`document.querySelectorAll('.data-home .data-table tbody tr').length >= 8`), 10000, '首页类型加载');
  const sections = await evalJs(`[...document.querySelectorAll('.data-home-section > h2')].map(h => h.childNodes[0].textContent.trim())`);
  assert(JSON.stringify(sections) === JSON.stringify(['总览', '对象类型', '维护']), '首页依次展示总览、对象类型、维护');
  assert(await evalJs(`!document.querySelector('.data-head-select')`), '取消六视图下拉');
  assert(await evalJs(`getComputedStyle(document.querySelector('.data-home')).overflowY === 'auto'`), '首页可纵向滚动');
  await capture('数据首页');

  // 2. 面板往返：点「今日」再点回「数据」
  await evalJs(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('今日'))?.click()`);
  await sleep(300);
  await clickUntil(
    `[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('数据'))?.click()`,
    () => evalJs(`!!document.querySelector('.data-view .data-home') && !document.querySelector('.data-home').hidden`),
    10000, '面板往返（今日 → 数据）',
  );

  // 3. 元数据完整性（临时库内置本体种子：12 对象 / 8 链接 / 6 动作）
  const meta = await evalJs(`window.tododesk.data.listTypes().then(r => r.data)`);
  if (!meta) throw new Error('IPC listTypes 无返回');
  console.log(`  对象类型 ${meta.objects.length} / 链接 ${meta.links.length} / 动作 ${meta.actions.length}`);
  assert(meta.objects.length >= 8 && meta.links.length >= 6 && meta.actions.length >= 6, '元数据完整（内置本体种子齐备）');

  // 4. 类型详情、关系与动作归属，以及返回时保留首页滚动位置。
  await evalJs(`document.querySelector('.data-home').scrollTop = 160`);
  const scrollBefore = await evalJs(`document.querySelector('.data-home').scrollTop`);
  await openType('todo');
  assert(await evalJs(`document.querySelector('.data-home').hidden`), '类型详情是独立页面');
  assert(await evalJs(`document.querySelectorAll('.data-detail-tabs [role=tab]').length === 4`), '详情有表结构、关系、动作、已有对象四页签');
  assert(await evalJs(`document.querySelector('.data-type-meta')?.textContent.includes('todos')`), '类型详情显示真实物理表');
  assert(await evalJs(`document.querySelector('.data-type-content')?.textContent.includes('主键')`), '表结构标记主键');
  await capture('待办表结构');
  await setTab('relations');
  const todoLinks = meta.links.filter(l => l.leftType === 'todo' || l.rightType === 'todo' || l.linkTable === 'todo');
  assert(await evalJs(`document.querySelectorAll('.data-type-content .data-table > tbody > tr').length`) === todoLinks.length, '关系只展示当前类型的关联');
  await setTab('actions');
  assert(await evalJs(`!document.querySelector('.data-type-content').textContent.includes('delete_study_plan') && document.querySelector('.data-type-content').textContent.includes('complete_todo')`), '待办动作包含完成待办，不混入删除学习计划');
  await evalJs(`[...document.querySelectorAll('.data-type-content button')].find(b => b.textContent === '查看定义').click()`);
  assert(await evalJs(`document.querySelector('.data-type-content .data-subrow')?.textContent.includes('执行规则')`), '可展开查看动作定义');
  await evalJs(`document.querySelector('.data-head button').click()`);
  assert(await evalJs(`document.querySelector('.data-home').scrollTop`) === scrollBefore, '返回首页保留滚动位置');

  // 5. 实例表格与分页搜索使用真实隔离数据。
  for (let i = 0; i < 21; i++) {
    await evalJs(`window.tododesk.todos.add({ title: '类型浏览冒烟 ${i}' })`);
  }
  await openType('todo');
  await setTab('objects');
  await waitFor(() => evalJs(`document.querySelectorAll('.data-main .data-table tbody tr').length === 20`), 10000, '待办首页 20 条');
  assert(await evalJs(`document.querySelectorAll('.data-main .data-table th').length`) > 0, '实例表格渲染');
  await evalJs(`[...document.querySelectorAll('.data-main button')].find(b => b.textContent === '下一页').click()`);
  await waitFor(() => evalJs(`document.querySelectorAll('.data-main .data-table tbody tr').length === 1`), 10000, '下一页剩余一条');
  await evalJs(`(() => { const input = document.querySelector('.data-main .searchbox input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '类型浏览冒烟 20'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(() => evalJs(`document.querySelector('.data-main tbody')?.textContent.includes('类型浏览冒烟 20')`), 10000, '实例搜索');
  assert(await evalJs(`document.querySelector('.data-main .toolbar').textContent.includes('共 1 条')`), '搜索重置分页');
  await evalJs(`document.querySelector('.data-query-controls').open = true`);
  const setQuerySelect = (label, value) => evalJs(`(() => { const input = document.querySelector('[aria-label="${label}"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(input, '${value}'); input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await setQuerySelect('查询显示方式', 'aggregate');
  await waitFor(() => evalJs(`!!document.querySelector('[aria-label="分组字段 1"] option[value="status"]')`), 10000, '字段查询合同加载');
  await setQuerySelect('分组字段 1', 'status');
  await evalJs(`document.querySelector('.data-query-form button.primary').click()`);
  await waitFor(() => evalJs(`document.querySelector('[aria-label="分组统计结果"] tbody')?.textContent.includes('open')`), 10000, '分组统计结果');
  assert(await evalJs(`document.querySelector('.data-main .toolbar').textContent.includes('1 个对象 · 1 组')`), '统计区分对象数与组数，并沿用搜索条件');
  await capture('统一查询分组统计');
  await evalJs(`[...document.querySelectorAll('.data-query-form button')].find(b => b.textContent === '重置查询').click()`);
  await waitFor(() => evalJs(`!document.querySelector('[aria-label="分组统计结果"]') && document.querySelector('.data-main tbody')?.textContent.includes('类型浏览冒烟 20')`), 10000, '重置分组返回对象列表');
  await evalJs(`[...document.querySelectorAll('.data-query-form button')].find(b => b.textContent === '添加条件').click()`);
  await setQuerySelect('筛选字段 1', 'title');
  await setQuerySelect('比较方式 1', 'eq');
  await evalJs(`(() => { const input = document.querySelector('[aria-label="筛选值 1"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '不匹配的值'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evalJs(`document.querySelector('.data-query-form button.primary').click()`);
  await waitFor(() => evalJs(`document.querySelector('.data-main .toolbar').textContent.includes('共 0 条')`), 10000, '筛选空结果');
  assert(await evalJs(`document.querySelector('.data-main tbody').textContent.includes('暂无数据')`), '筛选不匹配显示空结果');
  await evalJs(`[...document.querySelectorAll('.data-query-form button')].find(b => b.textContent === '重置查询').click()`);
  await openType('day');
  await setTab('objects');
  assert(await evalJs(`document.querySelector('.data-type-content').textContent.includes('虚拟对象类型')`), '虚拟类型无物理表说明');
  await capture('虚拟类型说明');

  // 6. IPC 全链路（只写临时库）：建自定义类型 → 加属性 → 建动作（create_object + modify_object）→ 执行 → 校验 → 清理
  const api = (expr) => evalJs(`window.tododesk.${expr}`).then((r) => {
    if (!r || r.ok === false) throw new Error(`IPC 失败: ${expr} → ${JSON.stringify(r)}`);
    return r.data;
  });
  const queryRows = await api(`data.queryObjects({version:1,objectType:'todo',select:['title','tags'],where:{property:'status',op:'in',value:['open']},includeTotal:true})`);
  assert(queryRows.total === 21 && Array.isArray(queryRows.rows[0].tags), 'Electron SQLite 驱动使用同一查询合同并解析 JSON');
  const rejected = await evalJs(`window.tododesk.data.aggregateObjects({version:1,objectType:'news_task',groupBy:['claim_token'],metrics:[{op:'count',as:'n'}]})`);
  assert(!rejected.ok && rejected.code === 'FIELD_NOT_READABLE', 'App 聚合不能利用敏感字段');
  await api(`data.createObjectType({ apiName: 'smoke_note', title: '冒烟笔记', properties: [{ apiName: 'content', dataType: 'string', nullable: false }] })`);
  await api(`data.updateObjectType({ apiName: 'smoke_note', patch: { addProperties: [{ apiName: 'star', dataType: 'boolean' }] } })`);
  const inserted = await evalJs(`window.tododesk.data.listObjects({ apiName: 'smoke_note', limit: 5 }).then(r => r.data)`);
  if (inserted.total !== 0) throw new Error('smoke_note 初始应为空');
  await api(`data.createActionType({
    apiName: 'smoke_star_note', title: '冒烟记星标笔记',
    parameters: [{ name: 'content', dataType: 'string', required: true }],
    operations: [
      { kind: 'create_object', objectType: 'smoke_note', propertyMappings: { content: { source: { parameter: 'content' } } } },
      { kind: 'modify_object', objectType: 'smoke_note', selector: { property: 'content', value: { source: { parameter: 'content' } } }, propertyMappings: { star: { literal: true } } },
    ],
  })`);
  const ran = await api(`data.invokeAction({ apiName: 'smoke_star_note', params: { content: '冒烟内容' } })`);
  if (ran.results.length !== 2 || ran.results[0].kind !== 'create_object') throw new Error('动作执行异常');
  const listed = await evalJs(`window.tododesk.data.listObjects({ apiName: 'smoke_note', limit: 5 }).then(r => r.data)`);
  if (listed.total !== 1 || listed.rows[0].star !== true) throw new Error('写入校验失败');
  console.log('  ✓ 数据 IPC 全链路（建类型→改类型→建动作→执行→写入校验）');
  // 7. 学习计划删除 action 的真实界面：预填 → 取消确认 → 确认连删。
  const date = '2026-10-13';
  const plan = await api(`plans.create({ title: '删除动作冒烟', start_date: '${date}', items: [{ date: '${date}', content: '删除动作待办' }] })`);
  await api(`plans.updateItemStatus({ id: ${plan.items[0].id}, status: 'done' })`);
  await openType('study_plan');
  await setTab('objects');
  await waitFor(() => evalJs(`document.querySelector('.data-main .data-table tbody')?.textContent.includes('删除动作冒烟')`), 10000, '学习计划对象出现');
  await evalJs(`[...document.querySelectorAll('.data-main .data-table tbody tr')].find(r => r.textContent.includes('删除动作冒烟')).click()`);
  await waitFor(() => evalJs(`!!document.querySelector('.data-run select')`), 10000, '对象详情动作出现');
  await evalJs(`[...document.querySelectorAll('.data-link-row')].find(b => b.textContent.includes('(plan_item)'))?.click()`);
  await waitFor(() => evalJs(`document.querySelector('.data-head .mono')?.textContent === 'plan_item' && document.querySelector('.data-detail')?.textContent.includes('删除动作待办')`), 10000, '跨类型关系跳转并打开关联实例');
  await sleep(400);
  assert(await evalJs(`document.querySelector('.data-detail')?.textContent.includes('删除动作待办')`), '关联实例详情不会被列表请求覆盖');
  await openType('study_plan');
  await setTab('objects');
  await waitFor(() => evalJs(`document.querySelector('.data-main tbody')?.textContent.includes('删除动作冒烟')`), 10000, '返回学习计划实例');
  await evalJs(`[...document.querySelectorAll('.data-main tbody tr')].find(r => r.textContent.includes('删除动作冒烟')).click()`);
  await waitFor(() => evalJs(`!!document.querySelector('.data-run select')`), 10000, '重新打开计划实例');
  await evalJs(`(() => {
    const s = document.querySelector('.data-run select');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'delete_study_plan');
    s.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(200);
  assert(await evalJs(`!document.querySelector('.data-main > .data-table-wrap') && !!document.querySelector('.data-detail')`), '打开实例后详情占用主要内容区');
  await capture('学习计划实例与动作');
  const inputs = await evalJs(`[document.querySelector('.data-run .data-param select')?.value,...[...document.querySelectorAll('.data-run input')].filter(i=>i.getAttribute('aria-label')!=='搜索关联对象').map(i=>i.value)]`);
  assert(inputs[0] === String(plan.id) && inputs[1] === 'true', '删除动作预填计划 id，默认连删待办');
  await evalJs(`window.smokeDeletePrompt = ''; window.confirm = text => { window.smokeDeletePrompt = text; return false; }; document.querySelector('.data-run button').click()`);
  await sleep(200);
  assert((await api(`plans.list()`)).some(p => p.id === plan.id), '取消确认不会删除计划');
  assert(await evalJs(`window.smokeDeletePrompt.includes('不可恢复') && window.smokeDeletePrompt.includes('待办')`), '确认框明确显示不可恢复与待办清理范围');
  await evalJs(`window.confirm = () => true; document.querySelector('.data-run button').click()`);
  await waitFor(() => evalJs(`!document.querySelector('.data-detail')`), 10000, '删除后刷新并关闭详情');
  assert(!(await api(`plans.list()`)).some(p => p.id === plan.id), 'action 删除计划成功');
  assert((await api(`todos.list({ tag: 'plan:${plan.id}' })`)).length === 0, 'action 连删自动生成待办');
  assert((await api(`checkins.list({ ref_type: 'plan_item' })`)).length === 0, 'action 清理条目打卡');
  for (const keepTodos of [false, true]) {
    const p = await api(`plans.create({ title: 'IPC 删除冒烟', start_date: '${date}', items: [{ date: '${date}', content: 'IPC 待办' }] })`);
    await api(`plans.delete({ id: ${p.id}, delete_todos: ${!keepTodos} })`);
    const todos = await api(`todos.list({ tag: 'plan:${p.id}' })`);
    assert(todos.length === (keepTodos ? 1 : 0), keepTodos ? '计划 IPC 支持保留待办' : '计划 IPC 默认清理待办');
    if (keepTodos) await api(`todos.delete({ id: ${p.items[0].todo_id} })`);
  }

  await evalJs(`document.querySelector('.data-head button').click(); [...document.querySelectorAll('.data-head button')].find(b => b.textContent === '刷新数据').click()`);
  await waitFor(() => evalJs(`document.querySelector('.data-home').textContent.includes('smoke_note')`), 10000, '自定义类型刷新');
  await openType('smoke_note');
  await setTab('objects');
  await waitFor(() => evalJs(`[...document.querySelectorAll('.data-main button')].some(b => b.textContent === '新增对象')`), 10000, '基础新增动作入口');
  await evalJs(`[...document.querySelectorAll('.data-main button')].find(b => b.textContent === '新增对象').click()`);
  await evalJs(`(() => { const input = document.querySelector('.data-create-object #action-value-values-content'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '表单新增对象'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evalJs(`document.querySelector('.data-create-object button.primary').click()`);
  await waitFor(() => evalJs(`!document.querySelector('.data-create-object') && document.querySelector('.data-main tbody')?.textContent.includes('表单新增对象')`), 10000, '基础动作表单新增成功');
  assert((await api(`data.listObjects({apiName:'smoke_note',search:'表单新增对象'})`)).total === 1, '基础属性表单通过 Action 写入临时库');
  await capture('基础动作新增对象');
  await setTab('actions');
  assert(await evalJs(`document.querySelector('.data-type-content').textContent.includes('smoke_star_note')`), '自定义动作按写规则归属类型');
  await evalJs(`[...document.querySelectorAll('.data-type-content button')].find(b => b.textContent.includes('新建动作')).click()`);
  await waitFor(() => evalJs(`!!document.querySelector('.modal .data-op-card')`), 10000, '组合动作编辑器');
  const setUiInput = (selector, value) => evalJs(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await setUiInput('.modal input[placeholder="如 记一笔读书"]', '界面组合动作');
  await setUiInput('.modal input[placeholder="如 log_reading"]', 'smoke_ui_compound');
  await setQuerySelect('content 值来源', 'literal');
  await setUiInput('.modal [aria-label="content 字面量"]', '界面组合阅读记录');
  await evalJs(`[...document.querySelectorAll('.modal button')].find(b => b.textContent.includes('添加规则')).click()`);
  await setQuerySelect('步骤 2 操作', 'invoke_command');
  await setQuerySelect('步骤 2 命令', 'add_todo');
  assert(await evalJs(`!document.querySelector('[aria-label="步骤 2 命令"] option[value="import_course"]')`), '组合编辑器只展示可组合命令');
  await setQuerySelect('title * 值来源', 'literal');
  await setUiInput('.modal [aria-label="title * 字面量"]', '界面组合复习待办');
  await setQuerySelect('notes 值来源', 'result');
  await capture('界面组合动作与结果引用');
  await evalJs(`document.querySelector('.modal-foot button.primary').click()`);
  await waitFor(() => evalJs(`!document.querySelector('.modal') && document.querySelector('.data-type-content').textContent.includes('smoke_ui_compound')`), 10000, '保存界面组合动作');
  await evalJs(`[...document.querySelectorAll('.data-type-content .data-table tbody tr')].find(row => row.textContent.includes('smoke_ui_compound')).querySelectorAll('button')[2].click()`);
  await waitFor(() => evalJs(`document.querySelector('.modal h3')?.textContent.includes('界面组合动作')`), 10000, '执行组合动作对话框');
  await evalJs(`document.querySelector('.modal-foot button.primary').click()`);
  await waitFor(() => evalJs(`document.querySelector('.data-result')?.textContent.includes('executionId')`), 10000, '组合动作完成并返回执行标识');
  await evalJs(`document.querySelector('.modal-foot button.primary').click()`);
  await waitFor(() => evalJs(`document.querySelector('.data-result')?.textContent.includes('"replayed": true')`), 10000, '重复执行重放原结果');
  assert((await api(`data.listObjects({apiName:'smoke_note',search:'界面组合阅读记录'})`)).total === 1, '界面重试不重复创建阅读记录');
  const generatedTodos = await api(`todos.list({search:'界面组合复习待办'})`);
  assert(generatedTodos.length === 1, '界面组合调用业务待办且幂等');
  await evalJs(`[...document.querySelectorAll('.modal-foot button')].find(b => b.textContent === '关闭').click()`);
  await evalJs(`document.querySelector('.action-history').open = true`);
  await waitFor(() => evalJs(`document.querySelector('.action-history tbody')?.textContent.includes('smoke_ui_compound')`), 10000, '执行记录出现');
  assert(await evalJs(`document.querySelector('.action-history tbody').textContent.includes('App')`), '执行记录保留真实 App 入口');
  await capture('动作执行记录');
  await api(`todos.delete({id:${generatedTodos[0].id}})`);
  await api(`data.deleteActionType({apiName:'smoke_ui_compound'})`);
  await setTab('schema');
  assert(await evalJs(`document.querySelector('.data-type-content').textContent.includes('star')`), '自定义追加字段可见');
  await capture('自定义表结构');
  await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 780, deviceScaleFactor: 1, mobile: false });
  await sleep(200);
  assert(await evalJs(`document.querySelector('.data-type-detail').getBoundingClientRect().right <= innerWidth && document.querySelector('.data-type-content').clientHeight > 150`), '窄窗口详情保持可用宽度和表格高度');
  await capture('窄窗口详情');
  await send('Emulation.clearDeviceMetricsOverride');
  await evalJs(`document.querySelector('.data-head button').click()`);
  await capture('对象类型列表');
  await openType('course');
  assert(await evalJs(`document.querySelector('.data-type-meta')?.textContent.includes('courses')`), '现有课程对象可从统一数据面板浏览');
  await openType('vault_note');
  await setTab('schema');
  assert(await evalJs(`![...document.querySelectorAll('.data-type-content button')].some(b=>b.textContent.includes('添加属性'))`), '只读笔记索引不提供追加字段入口');
  await capture('只读笔记索引');

  // 清理：动作 → 类型
  await api(`data.deleteActionType({ apiName: 'smoke_star_note' })`);
  await api(`data.deleteObjectType({ apiName: 'smoke_note' })`);
  const after = await evalJs(`window.tododesk.data.listTypes().then(r => r.data.objects.filter(t => t.apiName.startsWith('smoke_')).length)`);
  if (after !== 0) throw new Error('冒烟数据未清理干净');
  console.log('  ✓ 冒烟数据清理干净');

  ws.close();
  console.log('[smoke] PASS：全部断言通过（隔离实例 + 临时库，界面断言与可选截图）');
} catch (e) {
  failed = true;
  console.error(`[smoke] FAIL：${e instanceof Error ? e.message : e}`);
} finally {
  await stopAndCleanup(true);
}
process.exitCode = failed ? 1 : 0;
