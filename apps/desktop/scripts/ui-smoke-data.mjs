#!/usr/bin/env node
// 数据面板 UI 冒烟（隔离运行，绝不触碰真实数据）：
//   1. 以临时 TODODESK_DB + TODODESK_USER_DATA + 隔离 HOME 拉起 Electron（CDP 用动态空闲端口，
//      杜绝与残留 Electron/他人 dev 窗口的端口碰撞）——旧版本附着 9223 端口的现有窗口，
//      若那是连着真实库的 dev 窗口，IPC 写操作会直接写进用户真实数据库（红线，已废弃该方式）；
//   2. CDP 纯文本断言（无截图、无图像分析）：数据面板导航/总览/对象浏览/三类型管理渲染，
//      以及数据 IPC 全链路（建自定义类型→改类型→建动作→执行→校验→清理，全部只落临时库）；
//   3. 结束前断言冒烟对象类型在临时库中已清理、且全部写入只发生在临时库。
// 前置：npm run build:web && (cd apps/desktop && node scripts/build.mjs)
// 用法：node apps/desktop/scripts/ui-smoke-data.mjs
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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

  // 1. 进入数据面板
  await waitFor(() => evalJs(`!!document.querySelector('.nav-item')`), 15000, '应用启动');
  await clickUntil(
    `[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('数据'))?.click()`,
    () => evalJs(`document.querySelector('.data-view h2')?.textContent === '存储总览'`),
    15000, '数据面板打开（存储总览）',
  );
  // 幂等：显式切到「总览」子视图（上次可能停留在别的子视图）
  await evalJs(`[...document.querySelectorAll('.help-toc-item')].find(b => b.textContent.includes('总览'))?.click()`);
  await sleep(300);
  assert(await evalJs(`document.querySelector('.data-view h2')?.textContent`) === '存储总览', '总览子视图渲染');

  // 2. 面板往返：点「今日」再点回「数据」
  await evalJs(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('今日'))?.click()`);
  await sleep(300);
  await clickUntil(
    `[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('数据'))?.click()`,
    () => evalJs(`document.querySelector('.data-view h2')?.textContent === '存储总览'`),
    10000, '面板往返（今日 → 数据）',
  );

  // 3. 元数据完整性（临时库内置本体种子：12 对象 / 8 链接 / 5 动作）
  const meta = await evalJs(`window.tododesk.data.listTypes().then(r => r.data)`);
  if (!meta) throw new Error('IPC listTypes 无返回');
  console.log(`  对象类型 ${meta.objects.length} / 链接 ${meta.links.length} / 动作 ${meta.actions.length}`);
  assert(meta.objects.length >= 8 && meta.links.length >= 6 && meta.actions.length >= 5, '元数据完整（内置本体种子齐备）');

  // 4. 对象浏览视图
  await evalJs(`[...document.querySelectorAll('.help-toc-item')].find(b => b.textContent.includes('对象'))?.click()`);
  await sleep(400);
  const sideCount = await evalJs(`document.querySelectorAll('.data-side-item').length`);
  assert(sideCount >= 7, `对象浏览侧栏（${sideCount} 个可浏览类型）`);

  // 5. 三个管理视图渲染
  for (const [label, expect] of [['对象类型', 8], ['链接类型', 6], ['动作类型', 5]]) {
    await evalJs(`[...document.querySelectorAll('.help-toc-item')].find(b => b.textContent.includes('${label}'))?.click()`);
    await sleep(300);
    const rows = await evalJs(`document.querySelectorAll('.data-table > tbody > tr:not(.data-subrow)').length`);
    assert(rows >= expect, `${label} 表格渲染（${rows} 行）`);
  }

  // 6. IPC 全链路（只写临时库）：建自定义类型 → 加属性 → 建动作（create_object + modify_object）→ 执行 → 校验 → 清理
  const api = (expr) => evalJs(`window.tododesk.${expr}`).then((r) => {
    if (!r || r.ok === false) throw new Error(`IPC 失败: ${expr} → ${JSON.stringify(r)}`);
    return r.data;
  });
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
  // 清理：动作 → 类型
  await api(`data.deleteActionType({ apiName: 'smoke_star_note' })`);
  await api(`data.deleteObjectType({ apiName: 'smoke_note' })`);
  const after = await evalJs(`window.tododesk.data.listTypes().then(r => r.data.objects.filter(t => t.apiName.startsWith('smoke_')).length)`);
  if (after !== 0) throw new Error('冒烟数据未清理干净');
  console.log('  ✓ 冒烟数据清理干净');

  ws.close();
  console.log('[smoke] PASS：全部断言通过（隔离实例 + 临时库，纯文本断言，无截图）');
} catch (e) {
  failed = true;
  console.error(`[smoke] FAIL：${e instanceof Error ? e.message : e}`);
} finally {
  await stopAndCleanup(true);
}
process.exitCode = failed ? 1 : 0;
