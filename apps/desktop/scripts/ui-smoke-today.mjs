#!/usr/bin/env node
// 今日页隔离验收：日历查看并完成待办、无重复到期分组、移除今日学习分组、逾期完成与学习面板打卡。
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'dayfolio-today-'));
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
  if (!process.env.DAYFOLIO_TODAY_SCREENSHOTS) return;
  const dir = resolve(process.env.DAYFOLIO_TODAY_SCREENSHOTS);
  mkdirSync(dir, { recursive: true });
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(dir, `${name}.png`), Buffer.from(shot.data, 'base64'));
};


try {
  const { send, evaluate } = await launch();
  const invoke = async (expression) => {
    const result = await evaluate(expression);
    if (!result.ok) throw new Error(result.error || '业务调用失败');
    return result.data;
  };
  const today = (await invoke('window.tododesk.today.get({})')).date;
  const yesterday = new Date(`${today}T12:00:00+08:00`);
  yesterday.setDate(yesterday.getDate() - 2);
  const pastDate = yesterday.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const dueTitle = '演示：日历里的当天待办，核对长标题能完整换行，时间与分类在下方展示，不再挤在同一行或被截断';
  const overdueTitle = '演示：逾期待办';
  const studyTitle = '演示：今天的学习，阅读课件后记录理解并完成自测，核对较长学习内容仍能完整展示';
  const due = await invoke(`window.tododesk.todos.add(${JSON.stringify({ title: dueTitle, due_date: today, priority: 'high' })})`);
  await invoke(`window.tododesk.todos.add(${JSON.stringify({ title: overdueTitle, due_date: pastDate })})`);
  const plan = await invoke(`window.tododesk.plans.create(${JSON.stringify({ title: '演示学习计划', start_date: today, items: [{ date: today, content: studyTitle }] })})`);
  const nav = async (label) => evaluate(`([...document.querySelectorAll('.nav-item')].find(b => b.textContent.trim() === ${JSON.stringify(label)})).click()`);
  await nav('待办');
  await until(() => evaluate('!!document.querySelector(".composer-input")'), '待办页');
  await nav('今日');
  await until(() => evaluate(`document.querySelector('.cal-day')?.textContent.includes(${JSON.stringify(dueTitle)}) && document.querySelector('.cal-day')?.textContent.includes(${JSON.stringify(studyTitle)})`), '日历加载当天待办和学习安排');
  const layout = await evaluate(`(() => {
    const panel = document.querySelector('.today-panel');
    const labels = [...panel.querySelectorAll('.group-label')].map(e => e.textContent);
    return { calendarFirst: panel.firstElementChild.matches('.cal-section'), labels, cards: [...panel.querySelectorAll('.todo-card')].map(e => e.textContent), week: !!panel.querySelector('.cal-weekview') };
  })()`);
  assert(layout.calendarFirst && layout.week, '默认周视图日历置顶');
  assert(!layout.labels.some(label => /今天到期|今日到期/.test(label)), '移除重复的到期列表');
  assert(!layout.cards.some(text => text.includes(dueTitle)), '当天待办仅在日历区域展示');
  assert(layout.labels.some(label => label.includes('已逾期')), '保留逾期待办分组');
  const noStudyGroup = () => evaluate(`!document.querySelector('.today-panel .study-card') && !document.querySelector('.today-panel').textContent.match(/今日学习|待打卡|今天没有学习安排/)`);
  assert(await noStudyGroup(), '有学习安排时不再展示今日学习分组与待打卡计数');
  const checkCards = async () => evaluate(`(() => {
    const cards = [...document.querySelectorAll('.cal-agenda-card')];
    return cards.length >= 2 && cards.every(card => {
      const style = getComputedStyle(card), rect = card.getBoundingClientRect();
      return parseFloat(style.borderTopWidth) > 0 && parseFloat(style.borderRadius) > 0 && style.backgroundColor !== 'rgba(0, 0, 0, 0)' && card.scrollWidth <= card.clientWidth && rect.left >= 0 && rect.right <= innerWidth;
    }) && [...document.querySelectorAll('.cal-agenda-card')].every(card => card.querySelector('.cal-agenda-card-meta').getBoundingClientRect().top >= card.querySelector('.cal-agenda-card-main').getBoundingClientRect().bottom);
  })()`);
  assert(await checkCards(), '当日明细保留待办和学习卡片，元信息位于标题下方且不溢出');
  await evaluate('document.querySelector(".cal-day").scrollIntoView({block:"start"})');
  await capture(send, 'today');
  await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 1000, deviceScaleFactor: 1, mobile: false });
  assert(await checkCards(), '窄窗口长标题与卡片保持完整');
  await evaluate('document.querySelector(".cal-day").scrollIntoView({block:"start"})');
  await capture(send, 'today-narrow');
  await send('Emulation.clearDeviceMetricsOverride');

  await evaluate(`([...document.querySelectorAll('.cal-mode-switch button')].find(b => b.textContent === '月')).click()`);
  await until(() => evaluate('!!document.querySelector(".cal-grid .cal-cell")'), '切换月视图');
  assert(await noStudyGroup(), '月视图也不展示今日学习分组');
  await evaluate(`([...document.querySelectorAll('.cal-mode-switch button')].find(b => b.textContent === '周')).click()`);
  await until(() => evaluate('!!document.querySelector(".cal-weekview")'), '返回周视图');
  await evaluate(`([...document.querySelectorAll('.cal-item-open')].find(b => b.textContent === ${JSON.stringify(dueTitle)})).click()`);
  await until(() => evaluate('!!document.querySelector(".cal-item-details .cal-detail-preview h4")'), '待办详情');
  await evaluate(`([...document.querySelectorAll('.cal-item-details button')].find(b => b.textContent === '完成')).click()`);
  await until(async () => (await invoke('window.tododesk.todos.list({status:"done"})')).some(todo => todo.id === due.id), '从日历详情完成待办');
  assert(true, '当天待办仍可从日历详情完成并保存');

  await until(() => evaluate(`!![...document.querySelectorAll('.todo-card')].find(e => e.textContent.includes(${JSON.stringify(overdueTitle)}))`), '逾期待办');
  await evaluate(`[...document.querySelectorAll('.todo-card')].find(e => e.textContent.includes(${JSON.stringify(overdueTitle)})).querySelector('.check').click()`);
  await until(() => evaluate(`![...document.querySelectorAll('.todo-card')].some(e => e.textContent.includes(${JSON.stringify(overdueTitle)}))`), '逾期待办完成');
  await nav('学习');
  await until(() => evaluate(`!![...document.querySelectorAll('.learning-plan-card')].find(e => e.textContent.includes('演示学习计划'))`), '学习面板计划列表');
  await evaluate(`[...document.querySelectorAll('.learning-plan-card')].find(e => e.textContent.includes('演示学习计划')).click()`);
  await until(() => evaluate(`!![...document.querySelectorAll('.plan-item-open')].find(e => e.textContent.includes(${JSON.stringify(studyTitle)}))`), '计划条目');
  await evaluate(`[...document.querySelectorAll('.plan-item-open')].find(e => e.textContent.includes(${JSON.stringify(studyTitle)})).click()`);
  await until(() => evaluate(`!![...document.querySelectorAll('.plan-item-detail-actions button')].find(e => e.textContent === '标记完成')`), '条目详情完成入口');
  await evaluate(`[...document.querySelectorAll('.plan-item-detail-actions button')].find(e => e.textContent === '标记完成').click()`);
  await until(async () => (await invoke('window.tododesk.today.get({})')).today_plan_items.some(item => item.content === studyTitle && item.status === 'done'), '学习面板打卡');
  assert(true, '逾期完成与学习面板打卡保持可用');
  await nav('今日');
  await until(() => evaluate('!!document.querySelector(".today-panel .cal-section")'), '返回今日页');
  assert(await noStudyGroup(), '完成学习后也不恢复今日学习分组');
  const overview = await invoke('window.tododesk.today.get({})');
  assert(overview.checkins.length >= 3, '完成和打卡记录保留');
  await invoke(`window.tododesk.plans.delete({id:${plan.id}})`);
  assert((await invoke('window.tododesk.today.get({})')).today_plan_items.length === 0, '已清空隔离库中的当天学习安排');
  await nav('待办');
  await until(() => evaluate('!!document.querySelector(".composer-input")'), '待办页刷新');
  await nav('今日');
  await until(() => evaluate('!!document.querySelector(".today-panel .cal-section")'), '无学习安排的今日页');
  assert(await noStudyGroup(), '无学习安排时也不显示学习空态或分组');
  console.log('今日页隔离验收通过');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await stop();
  rmSync(work, { recursive: true, force: true });
}
