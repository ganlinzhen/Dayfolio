// 通用截图辅助：连接 CDP → 可选切换面板 → 截图保存
// 用法：node scripts/ui-shot.mjs <输出路径.png> [面板标签] ["可选 JS 表达式，结果打印"]
import { writeFileSync } from 'node:fs';

const [out, tab, probe] = process.argv.slice(2);
if (!out) throw new Error('用法: node scripts/ui-shot.mjs <输出.png> [面板] [探针JS]');

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

await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
await sleep(900);

if (tab) {
  await evalJs(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('${tab}'))?.click()`);
  await sleep(500);
}
if (probe) console.log('probe:', JSON.stringify(await evalJs(probe)));

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
console.log('截图 →', out);
ws.close();
process.exit(0);
