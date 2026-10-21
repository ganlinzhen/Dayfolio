#!/usr/bin/env node
// 日历交互隔离验收：真实指针创建、草稿底边调整、浮层查看编辑、跨午夜和键盘取消。
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'dayfolio-calendar-'));
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
  const invoke = async expression => { const result = await evaluate(expression); if (!result.ok) throw new Error(result.error || '业务调用失败'); return result.data; };
  const today = (await invoke('window.tododesk.today.get({})')).date;
  await until(() => evaluate('!!document.querySelector(".cal-col") && !document.querySelector(".cal-section[aria-busy=true]")'), '日历就绪');
  const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, ...extra });
  const click = async (x,y) => { await mouse('mousePressed',x,y,{button:'left',clickCount:1}); await mouse('mouseReleased',x,y,{button:'left',clickCount:1}); };
  const key = async value => { await send('Input.dispatchKeyEvent',{type:'keyDown',key:value}); await send('Input.dispatchKeyEvent',{type:'keyUp',key:value}); };
  const byText = text => evaluate(`([...document.querySelectorAll('.cal-popover button')].find(b=>b.textContent.trim()===${JSON.stringify(text)})).click()`);
  const input = (label,value) => evaluate(`(() => {const node=document.querySelector('[aria-label=${JSON.stringify(label)}]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const values = () => evaluate(`({start:document.querySelector('[aria-label="开始时间"]')?.value,end:document.querySelector('[aria-label="结束时间"]')?.value,date:document.querySelector('[aria-label="结束日期"]')?.value})`);
  const point = async (minute, day=today) => {
    await evaluate(`document.querySelector('.cal-scroll').scrollTop=${Math.min(Math.max(0,minute-100),960)}`);
    return evaluate(`(() => {const rect=document.querySelector('[aria-label="${day}时间网格"]').getBoundingClientRect();return {x:rect.left+rect.width/2,y:rect.top+${minute}+3};})()`);
  };
  const noDraft = () => evaluate('!document.querySelector(".cal-popover") && !document.querySelector(".cal-draft")');
  const gridClick = async minute => {const p=await point(minute);await click(p.x,p.y);await until(()=>evaluate('!!document.querySelector(".cal-popover input")'),'新建浮层');};
  const events = () => invoke(`window.tododesk.calendar.list({from:${JSON.stringify(today)},to:${JSON.stringify(today)}})`);
  // 点击只建立本地草稿，松手打开浮层，取消不能留下记录。
  await gridClick(540);
  assert((await values()).start==='09:00' && (await values()).end==='09:15','空档默认 15 分钟');
  assert((await events()).length===0,'未保存草稿不入库');
  assert(await evaluate('document.activeElement?.getAttribute("aria-label")==="日程标题"'),'新建浮层自动聚焦标题');
  await byText('创建日程');
  await until(()=>evaluate('document.querySelector(".cal-popover .notice.error")?.textContent.includes("标题不能为空")'),'空标题校验');
  assert((await events()).length===0,'保存校验失败保留草稿且不入库');
  await input('日程标题','日历拖拽练习');
  await evaluate(`document.querySelector('[aria-label="日程标题"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}))`);
  await pause(100);
  assert((await events()).length===0,'中文输入法选词回车不提交草稿');
  await input('日程备注','拖动后保留这条备注');
  const handle = await evaluate(`(() => {const r=document.querySelector('.cal-draft-resize').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  await mouse('mousePressed',handle.x,handle.y,{button:'left',clickCount:1});
  await mouse('mouseMoved',handle.x,handle.y+45,{button:'left',buttons:1});
  assert(await evaluate('!document.querySelector(".cal-popover")'),'拖动过程中隐藏编辑浮层');
  await mouse('mouseReleased',handle.x,handle.y+45,{button:'left',clickCount:1});
  await until(()=>evaluate('!!document.querySelector(".cal-popover input")'),'拖动结束恢复浮层');
  assert((await values()).end==='10:00','底边拖动按 15 分钟调整至一小时');
  assert(await evaluate(`document.querySelector('[aria-label="日程标题"]').value === "日历拖拽练习" && document.querySelector('[aria-label="日程备注"]').value === "拖动后保留这条备注"`),'重复拖动保留已填标题和备注');
  await capture(send,'calendar-draft');
  await byText('取消');
  assert(await noDraft() && (await events()).length===0,'取消清除草稿与浮层且不入库');
  // 空档按住直接拖动也应可用。
  const p=await point(660);
  await mouse('mousePressed',p.x,p.y,{button:'left',clickCount:1});
  await mouse('mouseMoved',p.x,p.y+30,{button:'left',buttons:1});
  await mouse('mouseReleased',p.x,p.y+30,{button:'left',clickCount:1});
  await until(()=>evaluate('!!document.querySelector(".cal-popover input")'),'直接拖动新建');
  assert((await values()).start==='11:00'&&(await values()).end==='11:45','按住空档向下拖动调整时长');
  await input('日程标题','已保存日历事项');
  await byText('创建日程');
  await until(async()=> (await events()).length===1,'创建日程入库');
  assert((await events())[0].end_time==='11:45','业务数据保留拖动结束时间');
  await until(()=>evaluate('!![...document.querySelectorAll(".cal-evt-block")].find(e=>e.textContent.includes("已保存日历事项"))'),'保存后网格刷新');
  await evaluate('[...document.querySelectorAll(".cal-evt-block")].find(e=>e.textContent.includes("已保存日历事项")).click()');
  await until(()=>evaluate('!!document.querySelector(".cal-event-preview h4")'),'日程详情浮层');
  assert(await evaluate('!document.querySelector(".cal-popover input")'),'已有日程先显示详情');
  await capture(send,'calendar-event-detail');
  await byText('编辑日程');
  await until(()=>evaluate('!!document.querySelector(".cal-popover input")'),'切换日程编辑');
  await input('日程标题','修改后的日历事项');
  await byText('保存修改');
  await until(async()=> (await events())[0]?.title==='修改后的日历事项','保存日程编辑');
  // 最后一个刻度必须能精确保存为次日零点。
  await gridClick(1425);
  assert((await values()).start==='23:45'&&(await values()).end==='00:00'&&!!(await values()).date,'末尾 15 分钟使用次日零点');
  await key('Escape');
  assert(await noDraft(),'Esc 关闭浮层并撤销草稿');
  // 按住时 Esc 同样撤销，不被随后抬手重新打开。
  const cancelPoint=await point(780);
  await mouse('mousePressed',cancelPoint.x,cancelPoint.y,{button:'left',clickCount:1});
  await key('Escape');
  await mouse('mouseReleased',cancelPoint.x,cancelPoint.y,{button:'left',clickCount:1});
  assert(await noDraft(),'拖动中 Esc 撤销且抬手不重开');
  // 普通待办复用详情与完成入口。
  const todo=await invoke(`window.tododesk.todos.add(${JSON.stringify({title:'浮层待办',due_date:today,start_time:'13:00',end_time:'13:30',notes:'详情备注'})})`);
  await until(()=>evaluate('!![...document.querySelectorAll(".cal-evt-block")].find(e=>e.textContent.includes("浮层待办"))'),'待办同步');
  await evaluate('[...document.querySelectorAll(".cal-evt-block")].find(e=>e.textContent.includes("浮层待办")).click()');
  await until(()=>evaluate('!!document.querySelector(".cal-detail-preview h4")'),'待办详情浮层');
  assert(await evaluate('document.querySelector(".cal-popover").textContent.includes("详情备注")'),'待办显示备注');
  await capture(send,'calendar-todo-detail');
  await byText('编辑待办');
  await until(()=>evaluate(`!!document.querySelector('[aria-label="待办详情标题"]')`),'待办编辑');
  await input('待办详情标题','已编辑浮层待办');
  await byText('保存待办修改');
  await until(()=>noDraft(),'保存待办后关闭浮层');
  const changed=await invoke('window.tododesk.todos.list({})');
  assert(changed.find(row=>row.id===todo.id)?.title==='已编辑浮层待办','待办编辑通过业务入口保存');
  await evaluate('[...document.querySelectorAll(".cal-evt-block")].find(e=>e.textContent.includes("已编辑浮层待办")).click()');
  await until(()=>evaluate('!!document.querySelector(".cal-detail-preview h4")'),'重新打开待办');
  await byText('完成');
  await until(async()=> (await invoke('window.tododesk.todos.list({status:"done"})')).some(row=>row.id===todo.id),'浮层完成待办');
  await until(()=>noDraft(),'完成后关闭浮层');
  // 月视图、窄窗口、外部关闭与焦点恢复。
  await evaluate('[...document.querySelectorAll(".cal-mode-switch button")].find(b=>b.textContent==="月").click()');
  await until(()=>evaluate('!!document.querySelector(".cal-month-item")'),'月视图事项');
  await evaluate('[...document.querySelectorAll(".cal-month-item")].find(b=>b.textContent.includes("修改后的日历事项")).click()');
  await until(()=>evaluate('!!document.querySelector(".cal-popover")'),'月视图详情浮层');
  await send('Emulation.setDeviceMetricsOverride',{width:760,height:650,deviceScaleFactor:1,mobile:false});
  await pause(100);
  assert(await evaluate('(() => {const r=document.querySelector(".cal-popover").getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;})()'),'窄窗口浮层保持可见且不被网格裁切');
  await capture(send,'calendar-month-narrow');
  await key('Escape');
  assert(await evaluate('document.activeElement.matches(".cal-month-item")'),'关闭后焦点返回原事项');
  await send('Emulation.clearDeviceMetricsOverride');
  await evaluate('[...document.querySelectorAll(".cal-mode-switch button")].find(b=>b.textContent==="周").click()');
  await gridClick(540);
  await click(220,50);
  assert(await noDraft(),'点击浮层外撤销未保存草稿');
  assert((await events()).length===1,'取消路径没有额外创建日程');
  console.log('日历草稿与浮层隔离验收通过');
} catch(error) { console.error(error);process.exitCode=1; }
finally { await stop();rmSync(work,{recursive:true,force:true}); }
