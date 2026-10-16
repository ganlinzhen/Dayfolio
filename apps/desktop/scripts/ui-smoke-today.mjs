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

// 1. 落在「今日」页（先显式切回，避免其他冒烟脚本遗留的 tab 状态）
await clickNav('今日'); await sleep(400);
const head = await evalJs(`(() => ({
  calFirst: !!document.querySelector('[aria-label=今日] .cal-section'),
  beforeGroups: (() => { const p = document.querySelector('[aria-label=今日]'); const cal = p.querySelector('.cal-section'); const g = p.querySelector('.group:not(.cal-section)'); return !g || (cal.compareDocumentPosition(g) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0; })(),
  statRow: !!document.querySelector('.stat-row'),
  dayCheckinBtn: [...document.querySelectorAll('button')].some(b => b.textContent.includes('每日打卡')),
  activeNav: document.querySelector('.nav-item.active')?.textContent?.trim(),
}))()`);
console.log('今日面板:', JSON.stringify(head));
if (!head.calFirst || !head.beforeGroups) throw new Error('日历未置顶');
if (head.statRow || head.dayCheckinBtn) throw new Error('统计条或每日打卡按钮应已移除');

// 1b. 日历区块：默认周视图（时间网格），可切月视图
const cal = await evalJs(`(() => ({
  weekview: !!document.querySelector('.cal-weekview'),
  cols: document.querySelectorAll('.cal-col').length,
  modeSwitch: [...document.querySelectorAll('.cal-mode-switch button')].map(b => b.textContent),
  nowline: !!document.querySelector('.cal-nowline'),
}))()`);
console.log('日历区块(默认周视图):', JSON.stringify(cal));
if (!cal.weekview || cal.cols !== 7 || cal.modeSwitch.join('/') !== '周/月' || !cal.nowline) throw new Error('周视图未按预期渲染');
await evalJs(`[...document.querySelectorAll('.cal-mode-switch button')].find(b => b.textContent === '月').click()`);
await sleep(400);
const monthView = await evalJs(`(() => ({ grid: !!document.querySelector('.cal-grid'), cells: document.querySelectorAll('.cal-cell').length }))()`);
console.log('切换月视图:', JSON.stringify(monthView));
if (!monthView.grid || monthView.cells === 0) throw new Error('月视图切换失败');
await evalJs(`[...document.querySelectorAll('.cal-mode-switch button')].find(b => b.textContent === '周').click()`);
await sleep(400);

// 2. 去待办面板加一条今天到期的高优先级
const today = new Date().toLocaleDateString('sv-SE');
const title = `今日面板联动 ${new Date().toLocaleTimeString('sv-SE')}`;
await clickNav('待办'); await sleep(400);
await evalJs(setInput('.composer-input', title));
await evalJs(setInput('.composer .chip-select', 'high', 'HTMLSelectElement'));
await evalJs(setInput('.composer .chip-date', today));
await evalJs(setInput('.todo-schedule select', 'date', 'HTMLSelectElement'));
await evalJs(`document.querySelector('.composer .btn.primary').click()`);
await sleep(600);

// 3. 回今日面板：出现在「今天到期」
await clickNav('今日'); await sleep(500);
const found = await evalJs(`[...document.querySelectorAll('.group')].some(g =>
  g.querySelector('.group-label')?.textContent?.includes('今天到期') &&
  [...g.querySelectorAll('.todo-card')].some(r => r.textContent.includes(${JSON.stringify(title)})))`);
console.log('今日面板出现新待办:', found);
if (found !== true) throw new Error('今日面板未反映新待办');

// 4. 在今日面板完成它 → 从「今天到期」列表消失（完成态进入打卡记录）
await evalJs(`[...document.querySelectorAll('.todo-card')].find(r => r.textContent.includes(${JSON.stringify(title)})).querySelector('.check').click()`);
await sleep(600);
const after = await evalJs(`(() => ({
  stillThere: [...document.querySelectorAll('.todo-card')].some(r => r.textContent.includes(${JSON.stringify(title)})),
}))()`);
console.log('完成后仍显示:', after.stillThere);
if (after.stillThere !== false) throw new Error('今日面板完成联动异常');

// 5. 截图
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('/tmp/tododesk-ui-v3.png', Buffer.from(shot.result.data, 'base64'));
console.log('截图 → /tmp/tododesk-ui-v3.png');
console.log('迭代 2 今日面板冒烟通过 ✅');
ws.close();
process.exit(0);
