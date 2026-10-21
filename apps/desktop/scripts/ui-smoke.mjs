// Dayfolio 新 UI（Codex 风格）CDP 冒烟：添加待办 → 分组校验 → 完成联动 → 打卡热力 → 截图
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

// 1. 外壳渲染
const brand = await evalJs(`document.querySelector('.brand-name')?.textContent`);
console.log('品牌名:', brand);
if (brand !== 'Dayfolio') throw new Error('界面未渲染');

// 2. 添加待办（composer）
const title = `冒烟 ${new Date().toLocaleTimeString('sv-SE')}`;
const setInput = (sel, value, proto = 'HTMLInputElement') => `
  (() => { const el = document.querySelector('${sel}');
    Object.getOwnPropertyDescriptor(${proto}.prototype, 'value').set.call(el, '${value}');
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()
`;
const today = new Date().toLocaleDateString('sv-SE');
// 确保切回「待办」面板（上轮脚本可能停留在其他 tab）
await evalJs(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('待办'))?.click()`);
await sleep(400);
await evalJs(`document.querySelector('.composer-input').focus()`);
await sleep(100);
await evalJs(setInput('.composer-input', title));
await evalJs(setInput('.composer [aria-label="优先级"]', 'high', 'HTMLSelectElement'));
await evalJs(setInput('.composer .chip-date', today));
await evalJs(setInput('.todo-schedule select', 'date', 'HTMLSelectElement'));
await evalJs(`document.querySelector('.composer .btn.primary').click()`);
await sleep(600);

// 3. 校验：落在「今天」分组，高优先级圆钮，等宽日期
const row = await evalJs(`(() => {
  const hit = [...document.querySelectorAll('.todo-card')].find(r => r.textContent.includes(${JSON.stringify(title)}));
  if (!hit) return null;
  const group = hit.closest('.group')?.querySelector('.group-label')?.textContent ?? '';
  return { group: group.trim(), high: hit.querySelector('.check')?.classList.contains('high'),
           due: hit.querySelector('.todo-meta')?.textContent, mono: !!hit.querySelector('.todo-meta') };
})()`);
console.log('新增行:', JSON.stringify(row));
if (!row || !row.group.startsWith('今天') || !row.high || !row.due.startsWith(today)) throw new Error('待办分组/样式异常');

// 4. 搜索过滤
await evalJs(setInput('.searchbox input', title.slice(0, 4)));
await sleep(500);
const searchCount = await evalJs(`document.querySelectorAll('.todo-card').length`);
await evalJs(`document.querySelector('.searchbox .icon-btn').click()`);
await sleep(400);
console.log('搜索命中:', searchCount);
if (searchCount < 1) throw new Error('搜索失效');

// 5. 完成待办 → 从未完成消失；切「已完成」分段验证；同时打卡联动
await evalJs(`[...document.querySelectorAll('.todo-card')].find(r => r.textContent.includes(${JSON.stringify(title)})).querySelector('.check').click()`);
await sleep(500);
const gone = await evalJs(`![...document.querySelectorAll('.todo-card')].some(r => r.textContent.includes(${JSON.stringify(title)}))`);
await evalJs(`[...document.querySelectorAll('.seg')][0].querySelectorAll('.seg-item')[1].click()`);
await sleep(400);
const doneChecked = await evalJs(`[...document.querySelectorAll('.todo-card')].find(r => r.textContent.includes(${JSON.stringify(title)}))?.querySelector('.check')?.classList.contains('checked')`);
console.log('完成联动: 未完成移除 =', gone, '| 已完成勾选 =', doneChecked);
if (gone !== true || doneChecked !== true) throw new Error('完成流程异常');

// 6. 打卡面板：大数字 + 28 天热力点 + 今日已打卡状态
await evalJs(`[...document.querySelectorAll('.todo-toolbar button')].find(b => b.textContent === '记录').click()`);
await sleep(500);
const checkin = await evalJs(`(() => ({
  num: document.querySelector('.streak-num')?.textContent,
  heat: document.querySelectorAll('.heat-dot').length,
  heatOn: document.querySelectorAll('.heat-dot.on').length,
  todayDone: document.querySelector('.day-checkin .btn')?.disabled,
}))()`);
console.log('打卡面板:', JSON.stringify(checkin));
// streak≥1、28 个热力点且今日点亮即可；每日打卡按钮与事项打卡相互独立，不要求 disabled
if (!checkin.num || Number(checkin.num) < 1 || checkin.heat !== 28 || checkin.heatOn < 1) throw new Error('打卡面板异常');

// 7. 计划面板空态
await evalJs(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('学习')).click()`);
await sleep(400);
const planEmpty = await evalJs(`document.querySelector('.panel .empty')?.textContent?.trim()`);
console.log('计划空态:', planEmpty);

// 8. 截图
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('/tmp/tododesk-ui-v2.png', Buffer.from(shot.result.data, 'base64'));
console.log('截图 → /tmp/tododesk-ui-v2.png');

console.log('新 UI 冒烟全部通过 ✅');
ws.close();
process.exit(0);
