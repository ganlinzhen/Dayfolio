#!/usr/bin/env node
// 空库启动正式入口：自动导入、快捷入口、离线阅读、重启保留进度；只使用临时库。
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'dayfolio-onboarding-'));
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
  const args = [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'];
  child = spawn(executable || join(repo, 'node_modules/.bin/electron'), executable ? args : [join(repo, 'apps/desktop'), ...args], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', (value) => { stderr = (stderr + value).slice(-4000); });
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
  if (!process.env.DAYFOLIO_ONBOARDING_SCREENSHOTS) return;
  const dir = resolve(process.env.DAYFOLIO_ONBOARDING_SCREENSHOTS);
  mkdirSync(dir, { recursive: true });
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(dir, `${name}.png`), Buffer.from(shot.data, 'base64'));
};

try {
  console.log('[上手课程] 首次启动（无预置课程数据）');
  let { send, evaluate } = await launch();
  const courses = await evaluate('window.tododesk.courses.list()');
  assert(courses.ok && courses.data.length === 1 && courses.data[0].slug === 'tododesk-tour', '空库经 App 启动自动收录上手课程');
  const id = courses.data[0].id;
  assert(courses.data[0].plan_id === null && courses.data[0].sample_confirmed_at === null, '未绑定计划、未代确认样课');
  assert(await evaluate('(await window.tododesk.plans.list()).data.length === 0 && (await window.tododesk.todos.list({})).data.length === 0'), '不生成计划或待办');
  const { version } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  assert(await evaluate(`document.querySelector('.nav-item-version')?.textContent.trim() === ${JSON.stringify(`v${version}`)}`), '窗口版本与根清单一致');
  await evaluate(`[...document.querySelectorAll('.nav-item')].find(button => button.textContent.includes('学习')).click()`);
  await until(() => evaluate(`!!document.querySelector('.onboarding-course-entry')`), '上手课程快捷入口');
  await capture(send, '学习入口');
  await evaluate(`document.querySelector('.onboarding-course-entry').click()`);
  await until(() => evaluate(`document.querySelector('.panel h1')?.textContent === 'Dayfolio 上手之旅'`), '课程页');
  await until(() => evaluate(`!!document.querySelector('.course-overview-entry:not(.pending)') && document.querySelectorAll('.course-card:not(.course-overview-entry)').length === 1`), '总览与讲义加载完成');
  assert(true, '独立总览与一天样课可见');
  await capture(send, '课程总览');
  await evaluate(`document.querySelector('.course-overview-entry').click()`);
  await until(() => evaluate(`document.querySelector('.course-lesson-frame')?.getAttribute('srcdoc')?.includes('你会学到什么')`), '总览离线正文');
  await evaluate(`document.querySelector('.backlink').click()`);
  await until(() => evaluate(`!!document.querySelector('.course-card:not(.course-overview-entry):not(.pending)')`), '返回课程卡片');
  await evaluate(`document.querySelector('.course-card:not(.course-overview-entry):not(.pending)').click()`);
  await until(() => evaluate(`document.querySelector('.course-lesson-frame')?.getAttribute('srcdoc')?.includes('动手练习')`), '样课离线正文');
  assert(await evaluate(`document.querySelector('.course-lesson-frame').getAttribute('srcdoc').includes('内联自课程包 assets/style.css')`), '随包样式正常内联');
  await capture(send, '样课正文');
  await until(() => evaluate(`(async () => { const r = await window.tododesk.courses.lessons({course_id:${id}}); return r.ok && r.data[0].status === 'read'; })()`), '阅读进度落库');
  await stop();

  console.log('[上手课程] 同一临时库再次启动');
  ({ evaluate } = await launch());
  const repeated = await evaluate('window.tododesk.courses.list()');
  assert(repeated.ok && repeated.data.length === 1 && repeated.data[0].id === id, '重启不重复导入课程');
  assert(await evaluate(`(await window.tododesk.courses.lessons({course_id:${id}})).data[0].status === 'read'`), '重启保留已读状态');
  assert(repeated.data[0].sample_confirmed_at === null, '重启仍不代确认样课');
  console.log('[上手课程] 全部断言通过');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await stop();
  rmSync(work, { recursive: true, force: true });
  console.log('[上手课程] 临时进程与数据已清理');
}
