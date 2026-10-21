#!/usr/bin/env node
// 空库启动正式入口：自动导入、快捷入口、离线阅读、重启保留进度；只使用临时库。
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'dayfolio-modals-'));
const env = {
  PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
  HOME: join(work, 'home'), TODODESK_DB: join(work, 'test.db'), TODODESK_USER_DATA: join(work, 'userData'),
};
mkdirSync(env.HOME);
mkdirSync(env.TODODESK_USER_DATA);
const executable = process.env.TODODESK_SMOKE_APP;
if (executable && (!isAbsolute(executable) || !executable.endsWith('.app/Contents/MacOS/Dayfolio'))) {
  rmSync(work, { recursive: true, force: true });
  throw new Error('候选 App 可执行路径不合法');
}
let child, socket;
let stderr = '';
let inspectorUrl;
const pause = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms));
const assert = (condition, label) => {
  if (!condition) throw new Error(`断言失败：${label}`);
  console.log(`  ✓ ${label}`);
};
const until = async (fn, label) => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { const result = await fn(); if (result) return result; } catch { /* 启动中重试 */ }
    await pause(200);
  }
  throw new Error(`等待超时：${label}\n${stderr}`);
};
async function stop() {
  socket?.close();
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolveStop) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => { clearTimeout(timer); resolveStop(); });
    child.kill('SIGTERM');
  });
}
async function launch() {
  const port = await new Promise((resolvePort) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const value = server.address().port;
      server.close(() => resolvePort(value));
    });
  });
  const args = ['--inspect=0', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'];
  child = spawn(executable || join(repo, 'node_modules/.bin/electron'), executable ? args : [join(repo, 'apps/desktop'), ...args], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', (value) => { stderr = (stderr + value).slice(-4000); inspectorUrl = stderr.match(/Debugger listening on (ws:\/\/[^\s]+)/)?.[1] ?? inspectorUrl; });
  const target = await until(async () => {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) })).json();
    return pages.find((page) => page.type === 'page' && page.url === 'dayfolio-app://app/index.html');
  }, '主窗口');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveSocket, reject) => {
    socket.onopen = resolveSocket;
    socket.onerror = reject;
  });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    pending.get(message.id)?.(message);
  };
  const send = (method, params = {}) => new Promise((resolveMessage, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`协议超时：${method}`)); }, 10000);
    pending.set(id, (message) => { pending.delete(id); clearTimeout(timer); message.error ? reject(new Error(message.error.message)) : resolveMessage(message.result); });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression: `(async () => (${expression}))()`, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  await until(() => evaluate('!!window.tododesk && !!document.querySelector(".nav-item")'), '渲染界面');
  return { send, evaluate };
}
const capture = async (send, name) => {
  if (!process.env.DAYFOLIO_MODAL_SCREENSHOTS) return;
  const dir = resolve(process.env.DAYFOLIO_MODAL_SCREENSHOTS);
  mkdirSync(dir, { recursive: true });
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(dir, `${name}.png`), Buffer.from(shot.data, 'base64'));
};

// 只替代系统目录选择，权限预览、授权和安装仍走真实宿主业务。
async function mainEvaluate(expression) {
  const url = await until(() => inspectorUrl, '主进程调试连接');
  const inspector = new WebSocket(url);
  await new Promise((resolveSocket, reject) => { inspector.onopen = resolveSocket; inspector.onerror = reject; });
  try { await new Promise((resolveEval, reject) => {
    const timer = setTimeout(() => reject(new Error("主进程调用超时")), 10000);
    inspector.onmessage = ({data}) => {
      const message = JSON.parse(data);
      if (message.id !== 1) return;
      clearTimeout(timer);
      if (message.result?.exceptionDetails || message.error) reject(new Error(JSON.stringify(message))); else resolveEval();
    };
    inspector.send(JSON.stringify({id: 1, method: 'Runtime.evaluate', params: {expression}}));
  }); } finally { inspector.close(); }
}
try {
  const { send, evaluate } = await launch();
  const click = async (label, selector = 'button') => {
    await evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.textContent.trim() === ${JSON.stringify(label)}); if (!b) throw new Error('找不到按钮：' + ${JSON.stringify(label)}); b.focus(); window.modalOpener = b; b.click(); })()`);
  };
  const escape = async () => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' }); await until(() => evaluate('!document.querySelector(".modal")'), '关闭弹窗'); };
  const layout = async (footer = true) => {
    await until(() => evaluate('!!document.querySelector(".modal")'), '弹窗已渲染');
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const result = await evaluate(`(() => {
      const m = document.querySelector('.modal'), h = m.querySelector('.modal-head'), b = m.querySelector('.modal-body'), c = m.querySelector('.modal-close'), f = m.querySelector('.modal-foot');
      const r = m.getBoundingClientRect(), cr = c.getBoundingClientRect(), br = b.getBoundingClientRect(), fr = f?.getBoundingClientRect();
      return {label: !!document.getElementById(m.getAttribute('aria-labelledby'))?.textContent, inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, closeRight: r.right - cr.right < 28, headLine: getComputedStyle(h).borderBottomWidth === '0px', scroll: b.scrollWidth <= b.clientWidth, footer: !!fr && fr.top >= br.bottom - 1 && fr.bottom <= r.bottom && f.parentElement === m};
    })()`);
    assert(result.label && result.inside && result.closeRight && result.headLine && result.scroll && (!footer || result.footer), '标题、右上角关闭、正文与固定操作区布局：' + JSON.stringify(result));
  };
  await click('工具箱');
  await until(() => evaluate('[...document.querySelectorAll("button")].some(b => b.textContent.trim() === "导入 HTML")'), '工具箱');
  await click('导入 HTML');
  await until(() => evaluate('!!document.querySelector(".modal input")'), '导入 HTML弹窗');
  await layout();
  await capture(send, 'tool-form');
  await evaluate(`(() => { const buttons = document.querySelectorAll('.modal-foot button'); buttons[buttons.length - 1].focus(); })()`);
  await send('Input.dispatchKeyEvent', {type:'keyDown', key:'Tab', code:'Tab'});
  assert(await evaluate('document.activeElement.matches(".modal-close")'), 'Tab 在末尾回到关闭按钮');
  await send('Input.dispatchKeyEvent', {type:'keyDown', key:'Tab', code:'Tab', modifiers:8});
  assert(await evaluate('document.activeElement === document.querySelector(".modal-foot button:last-child")'), 'Shift+Tab 返回最后一个操作');
  await escape();
  assert(await evaluate('document.activeElement === window.modalOpener'), '关闭后焦点返回打开入口');
  await click('管理分类');
  await layout();
  await capture(send, 'categories');
  await escape();
  await evaluate('document.querySelector(".nav-item-version").click()');
  await layout(false);
  await capture(send, 'changelog');
  await escape();
  await click('数据');
  await click('新建对象类型');
  await layout();
  await send('Emulation.setDeviceMetricsOverride', {width:640,height:460,deviceScaleFactor:1,mobile:false});
  await layout();
  assert(await evaluate('document.querySelector(".modal-body").scrollHeight > document.querySelector(".modal-body").clientHeight'), '长表单在矮窗口中独立滚动');
  await capture(send, 'data-short-window');
  await escape();
  await send('Emulation.clearDeviceMetricsOverride');
  await click('工具箱');
  const todo = await evaluate('window.tododesk.todos.add({title:"弹窗验收待办"})');
  assert(todo.ok, '通过业务入口创建隔离待办');
  await mainEvaluate(`process.getBuiltinModule('module').createRequire(process.execPath)('electron').BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()==='dayfolio-app://app/index.html').webContents.send('extensions:openTodo', {objectType:'todo',id:${todo.data.id}})`);
  await until(() => evaluate('!!document.querySelector(".runtime-todo-modal .modal-foot")'), '工具关联待办详情');
  await layout();
  assert(await evaluate('document.querySelectorAll(".runtime-todo-modal .cal-day-head").length === 0'), '工具关联待办只保留一个弹窗标题区');
  await capture(send, 'runtime-todo');
  await click('完成', '.modal-foot button');
  await until(() => evaluate('!document.querySelector(".modal")'), '待办完成并关闭详情');
  const done = await evaluate(`window.tododesk.todos.list({status:'done'})`);
  assert(done.ok && done.data.some(row=>row.id===todo.data.id), '共用弹窗保留待办完成业务');
  console.log('[弹窗] 隔离界面验收通过');

} finally {
  await stop();
  rmSync(work, { recursive: true, force: true });
}
