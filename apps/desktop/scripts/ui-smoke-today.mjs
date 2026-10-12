// 迭代 2 冒烟：今日仪表盘（默认页）→ 添加今日待办 → 今日面板联动完成 → 截图
import { writeFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:9223';
const page = (await (await fetch(`${BASE}/json`)).json()).find((t) => t.type === 'page');
if (!page) throw new Error('未找到页面 target');

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
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setInput = (sel, value, proto = 'HTMLInputElement') => `
  (() => { const el = document.querySelector('${sel}');
    Object.getOwnPropertyDescriptor(${proto}.prototype, 'value').set.call(el, '${value}');
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()
`;
const clickNav = (label) =>
  evalJs(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('${label}')).click()`);

// 1. 落在「今日」仪表盘（先显式切回，避免其他冒烟脚本遗留的 tab 状态）
await clickNav('今日'); await sleep(400);
const head = await evalJs(`(() => ({
  h1: document.querySelector('.panel-head h1')?.textContent,
  stats: document.querySelectorAll('.stat').length,
  summary: document.querySelector('.panel .sub')?.textContent?.slice(0, 30),
  activeNav: document.querySelector('.nav-item.active')?.textContent?.trim(),
}))()`);
console.log('今日面板:', JSON.stringify(head));
if (head.h1 !== '今日' || head.stats !== 4 || !head.summary) throw new Error('今日仪表盘未渲染');

// 2. 去待办面板加一条今天到期的高优先级
const today = new Date().toLocaleDateString('sv-SE');
const title = `今日面板联动 ${new Date().toLocaleTimeString('sv-SE')}`;
await clickNav('待办'); await sleep(400);
await evalJs(setInput('.composer-input', title));
await evalJs(setInput('.composer .chip-select', 'high', 'HTMLSelectElement'));
await evalJs(setInput('.composer .chip-date', today));
await evalJs(`document.querySelector('.composer .btn.primary').click()`);
await sleep(600);

// 3. 回今日面板：出现在「今天到期」
await clickNav('今日'); await sleep(500);
const found = await evalJs(`[...document.querySelectorAll('.group')].some(g =>
  g.querySelector('.group-label')?.textContent?.includes('今天到期') &&
  [...g.querySelectorAll('.todo-row')].some(r => r.textContent.includes(${JSON.stringify(title)})))`);
console.log('今日面板出现新待办:', found);
if (found !== true) throw new Error('今日面板未反映新待办');

// 4. 在今日面板完成它 → 概览数字 +1
const before = await evalJs(`document.querySelectorAll('.stat-num')[0]?.textContent`);
await evalJs(`[...document.querySelectorAll('.todo-row')].find(r => r.textContent.includes(${JSON.stringify(title)})).querySelector('.check').click()`);
await sleep(600);
const after = await evalJs(`(() => ({
  num: document.querySelectorAll('.stat-num')[0]?.textContent,
  stillThere: [...document.querySelectorAll('.todo-row')].some(r => r.textContent.includes(${JSON.stringify(title)})),
  streak: document.querySelectorAll('.stat-num')[2]?.textContent,
}))()`);
console.log('完成前待办数:', before, '| 完成后:', JSON.stringify(after));
if (after.stillThere !== false || Number(after.num) <= Number(before)) throw new Error('今日面板完成联动异常');

// 5. 截图
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('/tmp/tododesk-ui-v3.png', Buffer.from(shot.result.data, 'base64'));
console.log('截图 → /tmp/tododesk-ui-v3.png');
console.log('迭代 2 今日面板冒烟通过 ✅');
ws.close();
process.exit(0);
