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
// 候选包：TODODESK_SMOKE_APP=/绝对路径/Dayfolio.app/Contents/MacOS/Dayfolio node apps/desktop/scripts/ui-smoke-data.mjs
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

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
const executable = process.env.TODODESK_SMOKE_APP;
if (executable && (!isAbsolute(executable) || !executable.endsWith('.app/Contents/MacOS/Dayfolio') || !existsSync(executable))) {
  rmSync(work, { recursive: true, force: true });
  throw new Error('候选 App 可执行路径不合法或不存在');
}
// macOS 直接启动原生进程，使 app.pid 可用于精确激活本轮隔离窗口。
const electronBin = process.platform === 'darwin'
  ? join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : join(repo, 'node_modules', '.bin', 'electron');
if (!executable && !existsSync(electronBin)) throw new Error('未找到 electron 可执行文件');
const debugArgs = [`--remote-debugging-port=${PORT}`, '--remote-debugging-address=127.0.0.1'];
console.log(`[smoke] 启动隔离${executable ? '候选 App' : '开发 Electron'}，CDP 端口 ${PORT}`);
const app = spawn(executable || electronBin, executable ? debugArgs : ['.', ...debugArgs], {
  cwd: join(repo, 'apps/desktop'),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...isolatedEnv, TODODESK_USER_DATA: join(work, 'userData'), ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
});
let stderrTail = '';
app.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-2000); });
app.stdout.resume();
let socket = null;
const pending = new Map();
const rejectPending = (reason) => {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error(`${reason}：${request.method}`));
  }
  pending.clear();
};

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
  let lastError;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { lastError = e; }
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${label}${lastError ? `\n最后一次错误：${lastError instanceof Error ? lastError.message : lastError}` : ''}\n${stderrTail}`);
    await new Promise((r) => setTimeout(r, 300));
  }
};

let failed = false;
let stoppedOnce = false;
/** 停止 Electron 并清理临时目录（幂等；runDbCheck=true 时先做隔离落库断言再删目录） */
const stopAndCleanup = async (runDbCheck = false) => {
  if (stoppedOnce) return;
  stoppedOnce = true;
  rejectPending('隔离验收正在关闭');
  socket?.close();
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
  console.log('[smoke] 等待主窗口完成导航');
  const page = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(1500) })).json();
    return list.find((t) => t.type === 'page' && t.url === 'dayfolio-app://app/index.html');
  }, 30000, 'CDP 页面 target');
  console.log(`[smoke] 连接主窗口 ${page.url}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  socket = ws;
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('CDP WebSocket 连接超时')), 10000);
    ws.onopen = () => { clearTimeout(timer); res(); };
    ws.onerror = () => { clearTimeout(timer); rej(new Error('CDP WebSocket 连接失败')); };
    ws.onclose = () => { clearTimeout(timer); rej(new Error('CDP WebSocket 在握手期间关闭')); };
  });
  let msgId = 0;
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    const request = pending.get(m.id);
    if (!request) return;
    pending.delete(m.id);
    clearTimeout(request.timer);
    if (m.error) request.reject(new Error(`CDP ${request.method} 失败：${m.error.message}`));
    else request.resolve(m);
  };
  ws.onclose = () => rejectPending('CDP WebSocket 已关闭');
  ws.onerror = () => rejectPending('CDP WebSocket 发生错误');
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      if (ws.readyState !== WebSocket.OPEN) return rej(new Error(`CDP 连接未就绪：${method}`));
      const id = ++msgId;
      const timer = setTimeout(() => {
        pending.delete(id);
        rej(new Error(`CDP 请求超时（10 秒）：${method}`));
      }, 10000);
      pending.set(id, { resolve: res, reject: rej, timer, method });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        pending.delete(id);
        clearTimeout(timer);
        rej(e);
      }
    });
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error('页面执行失败: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  console.log('[smoke] CDP 已就绪，等待应用导航入口');
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
  console.log('[smoke] 应用导航已就绪，打开数据面板');
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

  // 分组只调整浏览结构：每种类型均保留入口，完成记录继续收在待办行内。
  const groups = await evalJs(`(() => [...document.querySelectorAll('.data-home .data-type-group-heading')].map(heading => {
    const button = heading.querySelector('.data-type-group-toggle');
    const rows = document.getElementById(button.getAttribute('aria-controls'));
    return {
      id: heading.dataset.group,
      count: Number(heading.dataset.typeCount),
      expanded: button.getAttribute('aria-expanded'),
      controls: button.getAttribute('aria-controls'),
      rowGroup: rows?.dataset.group,
      hidden: rows?.hidden,
      types: [...(rows?.querySelectorAll('tr[data-object-type]') ?? [])].map(row => row.dataset.objectType),
      completedLinks: rows?.querySelectorAll('[data-object-type-link="checkin"]').length ?? 0,
    };
  }))()`);
  assert(groups.length >= 8, '对象类型按菜单功能与基础功能分组');
  assert(groups.every(group => group.id === group.rowGroup && group.controls && group.expanded === 'true' && !group.hidden), '分组默认展开，按钮关联对应表体');
  assert(groups.every(group => group.count === group.types.length + group.completedLinks), '每组种数包含行内完成记录，与实际入口一致');
  assert(groups.reduce((total, group) => total + group.count, 0) === meta.objects.length, '分组种数合计与完整元数据一致');
  const groupedTypes = groups.flatMap(group => group.types);
  assert(new Set(groupedTypes).size === groupedTypes.length && JSON.stringify([...groupedTypes].sort()) === JSON.stringify(meta.objects.filter(type => type.apiName !== 'checkin').map(type => type.apiName).sort()), '全部对象类型唯一归组，不遗漏、不重复');
  assert(groups.find(group => group.id === 'todos')?.types.includes('todo') && groups.find(group => group.id === 'todos')?.completedLinks === 1, '待办组保留完成记录入口');
  if (process.platform === 'darwin') {
    await new Promise((res, rej) => {
      const activate = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit');$.NSRunningApplication.runningApplicationWithProcessIdentifier(${app.pid}).activateWithOptions(3);`]);
      const timer = setTimeout(() => {
        activate.kill('SIGTERM');
        rej(new Error('激活隔离窗口超时'));
      }, 10000);
      activate.once('error', (e) => { clearTimeout(timer); rej(e); });
      activate.once('exit', (code) => {
        clearTimeout(timer);
        code === 0 ? res() : rej(new Error('无法激活本轮隔离窗口'));
      });
    });
  }
  await send('Page.bringToFront');
  await waitFor(() => evalJs('document.hasFocus()'), 10000, '隔离窗口获取键盘焦点');
  await evalJs(`(() => {
    const home = document.querySelector('.data-home');
    const title = document.getElementById('data-types-title');
    home.scrollTop += title.getBoundingClientRect().top - home.getBoundingClientRect().top;
  })()`);
  await capture('对象类型分组');
  const collapsedGroup = groups.find(group => group.types.length > 0 && !group.types.includes('todo'));
  assert(!!collapsedGroup, '存在可独立折叠的功能组');
  await evalJs(`document.querySelector('.data-type-group-heading[data-group="${collapsedGroup.id}"] .data-type-group-toggle').focus()`);
  assert(await evalJs(`document.activeElement === document.querySelector('.data-type-group-heading[data-group="${collapsedGroup.id}"] .data-type-group-toggle')`), '分组按钮可获取键盘焦点');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 36 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 36 });
  await waitFor(() => evalJs(`document.getElementById('${collapsedGroup.controls}')?.hidden && document.querySelector('.data-type-group-heading[data-group="${collapsedGroup.id}"] .data-type-group-toggle')?.getAttribute('aria-expanded') === 'false'`), 10000, '键盘折叠功能组');
  assert(await evalJs(`document.getElementById('${collapsedGroup.controls}').getClientRects().length === 0`), '折叠后组内对象行不占据布局');
  await capture('对象类型分组折叠');

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
  assert(await evalJs(`document.getElementById('${collapsedGroup.controls}')?.hidden && document.querySelector('.data-type-group-heading[data-group="${collapsedGroup.id}"] .data-type-group-toggle')?.getAttribute('aria-expanded') === 'false'`), '返回首页保留功能组折叠状态');
  await evalJs(`document.querySelector('.data-type-group-heading[data-group="${collapsedGroup.id}"] .data-type-group-toggle').click()`);
  await waitFor(() => evalJs(`!document.getElementById('${collapsedGroup.controls}')?.hidden`), 10000, '恢复功能组展开');

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
  assert(await evalJs(`document.querySelector('.data-home tr[data-object-type="smoke_note"]')?.closest('tbody')?.dataset.group === 'custom'`), '新建类型自动显示在自定义组');
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
  await waitFor(() => evalJs(`document.querySelector('.modal-heading h2')?.textContent.includes('界面组合动作')`), 10000, '执行组合动作对话框');
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
  await evalJs(`document.querySelector('.data-head button').click()`);
  await waitFor(() => evalJs(`!document.querySelector('.data-home')?.hidden`), 10000, '窄窗口返回对象类型首页');
  assert(await evalJs('document.documentElement.scrollWidth <= innerWidth'), '窄窗口首页不产生整页横向溢出');
  const narrowGroup = await evalJs(`(() => {
    const heading = document.querySelector('.data-home .data-type-group-heading');
    const button = heading.querySelector('.data-type-group-toggle');
    const home = document.querySelector('.data-home');
    home.scrollTop += heading.getBoundingClientRect().top - home.getBoundingClientRect().top;
    heading.closest('.data-table-wrap').scrollLeft = 0;
    const label = button.querySelector('span').getBoundingClientRect();
    const rect = button.getBoundingClientRect();
    return {
      id: heading.dataset.group,
      controls: button.getAttribute('aria-controls'),
      expanded: button.getAttribute('aria-expanded') === 'true',
      visible: rect.left >= 0 && rect.top >= 0 && rect.bottom <= innerHeight && label.right <= innerWidth,
      x: (label.left + label.right) / 2,
      y: (label.top + label.bottom) / 2,
    };
  })()`);
  assert(narrowGroup.visible, '窄窗口分组名称及点击区域保持可见');
  const clickNarrowGroup = async () => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: narrowGroup.x, y: narrowGroup.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: narrowGroup.x, y: narrowGroup.y, button: 'left', clickCount: 1 });
  };
  await clickNarrowGroup();
  await waitFor(() => evalJs(`document.getElementById('${narrowGroup.controls}')?.hidden === ${narrowGroup.expanded}`), 10000, '窄窗口点击切换分组');
  await clickNarrowGroup();
  await waitFor(() => evalJs(`document.getElementById('${narrowGroup.controls}')?.hidden === ${!narrowGroup.expanded}`), 10000, '窄窗口恢复分组原状态');
  await capture('窄窗口对象类型分组');
  await send('Emulation.clearDeviceMetricsOverride');
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
