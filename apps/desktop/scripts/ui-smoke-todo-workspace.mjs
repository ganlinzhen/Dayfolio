#!/usr/bin/env node
// 待办工作区隔离验收：新增、筛选、编辑保护、冲突和窄窗口。
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'dayfolio-todo-workspace-'));
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
  const events = [];
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method && /loadingFailed|entryAdded|frameNavigated|attachedToTarget/.test(message.method)) events.push(message);
    pending.get(message.id)?.(message);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolveMessage, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`协议超时：${method}`)); }, 10000);
    pending.set(id, (message) => { pending.delete(id); clearTimeout(timer); message.error ? reject(new Error(message.error.message)) : resolveMessage(message.result); });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? {sessionId} : {}) }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression: `(async () => (${expression}))()`, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  await until(() => evaluate('!!window.tododesk && !!document.querySelector(".nav-item")'), '渲染界面');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Target.setAutoAttach', {autoAttach:true,waitForDebuggerOnStart:false,flatten:true});
  return { send, evaluate, events };
}
const capture = async (send, name) => {
  if (!process.env.DAYFOLIO_TODO_SCREENSHOTS) return;
  const dir = resolve(process.env.DAYFOLIO_TODO_SCREENSHOTS);
  mkdirSync(dir, { recursive: true });
  await send('Runtime.evaluate', { expression: "Promise.all([...document.querySelectorAll('.modal-mask')].flatMap(element => element.getAnimations()).filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {})))", awaitPromise: true });
  await send('Runtime.evaluate', { expression: "document.querySelectorAll('.toast-close').forEach(button => button.click())" });
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(dir, `${name}.png`), Buffer.from(shot.data, 'base64'));
};

try {
  const { send, evaluate, events } = await launch();
  const invoke = async expression => {
    const result = await evaluate(expression);
    if (!result.ok) throw new Error(result.error || '业务调用失败');
    return result.data;
  };
  const click = async selector => {
    await until(()=>evaluate(`(() => { const b=document.querySelector(${JSON.stringify(selector)}); return !!b && !b.disabled; })()`),'点击目标可用：'+selector);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  };
  const fill = (selector, value, prototype = 'HTMLInputElement') => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('找不到输入框'); Object.getOwnPropertyDescriptor(${prototype}.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  const button = text => evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})?.click()`);
  const list = () => invoke('window.tododesk.todos.list({status:"all"})');
  // 固定使用 UTC，覆盖固定时刻早于浮动 09:00 的云端场景。
  await invoke('window.tododesk.runtime.setTimezone({zone:"UTC"})');
  const overview = await invoke('window.tododesk.today.get()');
  const today = overview.date;
  const day = n => { const d = new Date(today+'T12:00:00'); d.setDate(d.getDate()+n); return d.toLocaleDateString('sv-SE'); };
  const create = input => invoke('window.tododesk.todos.add('+JSON.stringify(input)+')');
  const early = await create({title:'整理项目资料',due_date:today,start_time:'09:00',priority:'low',notes:'查看这周的改动与待解决问题'});
  const late = await create({title:'梳理 Carbon 三种嵌套类型如何透传 Shell 的 GraphQL',due_date:today,start_time:'18:00',priority:'high',source:'mcp',tags:['工作','AI']});
  await create({title:'完成长标题事项，核对换行和分类、标签在窄窗口内的布局表现，保持完整可读并允许键盘操作',due_date:day(1),tags:['工作','设计评审']});
  await create({title:'梳理知识库中的待整理笔记',tags:['个人']});
  await create({title:'补充昨日评审意见',due_date:day(-1),priority:'high'});
  const fixed = await create({title:'固定时刻回归',time_mode:'instant',scheduled_start_at:today+'T04:00:00Z',tags:['plan:123','回归'],notes:'固定时刻原备注'});
  await evaluate('[...document.querySelectorAll(".nav-item")].find(b=>b.textContent.trim()==="待办").click()');
  await until(()=>evaluate('document.querySelectorAll(".todo-card").length===6&&!document.querySelector(".todo-groups[aria-busy=true]")'),'待办列表');
  assert(await evaluate('!document.querySelector(".todo-composer-details")'),'新增初始收起');
  assert(await evaluate(`(() => { const ids = [...document.querySelectorAll('.todo-card')].filter(r => r.closest('.group').querySelector('.group-label').textContent.includes('今天')).map(r => Number(r.dataset.todoId)); return ids.indexOf(${early.id}) >= 0 && ids.indexOf(${late.id}) > ids.indexOf(${early.id}); })()`),'默认组内低优先级 09:00 排在高优先级 18:00 前');
  await capture(send,'todo-overview');

  await evaluate('document.activeElement?.blur()');
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'n',code:'KeyN'});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'n',code:'KeyN'});
  await until(()=>evaluate('!!document.querySelector(".todo-composer-details")&&document.activeElement?.classList.contains("composer-input")'),'N 聚焦并展开新增');
  await fill('.composer-input','待办界面验收');
  await click('.todo-composer-v2 button[type=submit]');
  await until(()=>evaluate('document.querySelector("#todo-add-error")?.textContent.includes("开始时间")'),'缺少开始时间的就地错误');
  assert((await list()).length===6,'无效表单不创建数据');
  await fill('[aria-label=时间安排]','date','HTMLSelectElement');
  await button('备注与标签');
  await fill('.todo-extra-fields textarea','验收新增备注','HTMLTextAreaElement');
  await fill('.todo-extra-fields input','工作，验证');
  await evaluate('(()=>{document.querySelector(".todo-composer-v2 button[type=submit]").click();document.querySelector(".todo-composer-v2 button[type=submit]").click()})()');
  await until(async()=> (await list()).some(t=>t.title==='待办界面验收'),'新增成功');
  const created=(await list()).find(t=>t.title==='待办界面验收');
  assert((await list()).filter(t=>t.title==='待办界面验收').length===1,'连点不重复创建');
  assert(created.notes==='验收新增备注'&&created.tags.includes('验证'),'新增备注与标签持久化');
  await until(()=>evaluate('!document.querySelector(".todo-composer-details")&&!document.querySelector(".composer-input").value'),'成功后清空并收起');

  await evaluate('document.querySelector(".composer-input").focus()');
  await fill('.composer-input','输入法草稿');
  assert(await evaluate('(()=>{const event=new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true,isComposing:true});document.querySelector(".composer-input").dispatchEvent(event);return event.defaultPrevented})()'),'中文选词回车阻止表单默认提交');
  assert(!(await list()).some(t=>t.title==='输入法草稿'),'中文选词不提交');
  await evaluate('document.querySelector(".composer-input").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  assert(await evaluate('!document.querySelector(".todo-composer-details")&&document.querySelector(".composer-input").value==="输入法草稿"'),'Esc 收起并保留草稿');
  await evaluate('document.querySelector(".composer-input").focus()');
  await button('取消新增');

  await evaluate('[...document.querySelectorAll(".todo-date-filter")].find(b=>b.textContent.startsWith("无日期")).click()');
  await until(()=>evaluate('document.querySelectorAll(".todo-card").length===1'),'无日期筛选');
  await fill('[aria-label=搜索待办]','不匹配任何内容');
  await until(()=>evaluate('!!document.querySelector(".empty")'),'叠加筛选空态');
  await button('清除筛选');
  await until(()=>evaluate('document.querySelectorAll(".todo-card").length===7'),'清除全部筛选');
  await fill('[aria-label=待办排序]','priority','HTMLSelectElement');
  await until(()=>evaluate('[...document.querySelectorAll(".todo-card")].filter(r=>r.closest(".group").querySelector(".group-label").textContent.includes("今天"))[0].textContent.includes("梳理 Carbon")'),'优先级排序');
  await fill('[aria-label=待办排序]','date','HTMLSelectElement');
  await evaluate('[...document.querySelectorAll(".todo-group-toggle")].find(b=>b.textContent.includes("今天")).click()');
  assert(await evaluate('[...document.querySelectorAll(".todo-group-toggle")].find(b=>b.textContent.includes("今天")).getAttribute("aria-expanded")==="false"'),'分组可折叠');
  await evaluate('[...document.querySelectorAll(".todo-group-toggle")].find(b=>b.textContent.includes("今天")).click()');

  await evaluate('[...document.querySelectorAll(".todo-title")].find(b=>b.textContent==="固定时刻回归").click()');
  await fill('[aria-label=编辑待办备注]','只修改备注','HTMLTextAreaElement');
  await fill('[aria-label=编辑待办标签]','新标签');
  await button('保存待办');
  await until(async()=> (await list()).find(t=>t.id===fixed.id).notes==='只修改备注','编辑备注保存');
  const preserved=(await list()).find(t=>t.id===fixed.id);
  assert(preserved.time_mode==='instant'&&preserved.scheduled_start_at===fixed.scheduled_start_at,'备注编辑保留固定 UTC 时刻');
  assert(preserved.tags.includes('plan:123')&&preserved.tags.includes('新标签'),'隐藏关联标签保留');

  await evaluate('[...document.querySelectorAll(".todo-title")].find(b=>b.textContent==="固定时刻回归").click()');
  await fill('[aria-label=编辑待办标题]','本地未保存标题','HTMLTextAreaElement');
  await invoke('window.tododesk.todos.update('+JSON.stringify({id:fixed.id,title:'其他入口修改'})+')');
  await button('保存待办');
  await until(()=>evaluate('document.querySelector(".todo-inline-editor .notice")?.textContent.includes("REVISION_CONFLICT")'),'并发修改提示');
  assert(await evaluate('document.querySelector("[aria-label=编辑待办标题]").value==="本地未保存标题"'),'冲突保留草稿');
  await button('载入最新内容（放弃草稿）');
  await until(()=>evaluate('document.querySelector("[aria-label=编辑待办标题]").value==="其他入口修改"'),'显式重载最新版本');
  await button('取消');
  await until(()=>evaluate('document.activeElement?.classList.contains("todo-title")'),'取消编辑返回标题焦点');

  await evaluate('[...document.querySelectorAll(".todo-card")].find(r=>r.textContent.includes("待办界面验收")).querySelector(".check").click()');
  await until(async()=> (await list()).find(t=>t.id===created.id).status==='done','完成持久化');
  await click('.toast-action');
  await until(async()=> (await list()).find(t=>t.id===created.id).status==='open','撤销完成');
  await until(()=>evaluate('[...document.querySelectorAll(".todo-card")].some(r=>r.textContent.includes("待办界面验收"))'),'重新出现在列表');
  await evaluate('[...document.querySelectorAll(".todo-card")].find(r=>r.textContent.includes("待办界面验收")).querySelector(".todo-delete").click()');
  assert((await list()).some(t=>t.id===created.id),'删除先确认');
  await button('保留');
  assert((await list()).some(t=>t.id===created.id),'保留不删除');
  await evaluate('[...document.querySelectorAll(".todo-card")].find(r=>r.textContent.includes("待办界面验收")).querySelector(".todo-delete").click()');
  await button('确认删除');
  await until(async()=> !(await list()).some(t=>t.id===created.id),'确认删除持久化');
  await click('.toast-action');
  await until(async()=> (await list()).some(t=>t.title==='待办界面验收'&&t.id!==created.id),'撤销重建独立待办');

  await evaluate('document.activeElement?.blur()');
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'/',code:'Slash'});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'/',code:'Slash'});
  assert(await evaluate('document.activeElement?.getAttribute("aria-label")==="搜索待办"'),'斜杠快捷键聚焦搜索');
  await fill('[aria-label=搜索待办]','只修改备注');
  await until(()=>evaluate('document.querySelectorAll(".todo-card").length===1'),'备注可搜索');
  await click('[aria-label=清除搜索]');
  await until(()=>evaluate('document.querySelectorAll(".todo-card").length===7'),'清除搜索');
  await button('记录');
  await until(()=>evaluate('!!document.querySelector(".heat-dot")'),'记录入口');
  await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("返回待办"))?.click()');
  await until(()=>evaluate('!!document.querySelector(".todo-workspace")'),'返回待办');
  await capture(send,'todo-final-wide');

  await send('Emulation.setDeviceMetricsOverride',{width:760,height:900,deviceScaleFactor:1,mobile:false});
  await evaluate('document.querySelector(".composer-input").focus()');
  await until(()=>evaluate('!!document.querySelector(".todo-composer-details")'),'窄窗口新增');
  await capture(send,'todo-add-narrow');
  assert(await evaluate('document.querySelector(".todo-workspace").scrollWidth<=document.querySelector(".todo-workspace").clientWidth'),'760 窄窗口无横向溢出');
  assert(await evaluate('document.querySelector(".content").scrollWidth<=document.querySelector(".content").clientWidth'),'内容区无横向滚动');
  await button('取消新增');
  await evaluate('[...document.querySelectorAll(".todo-title")].find(b=>b.textContent.includes("长标题事项")).click()');
  await capture(send,'todo-edit-narrow');
  assert(await evaluate('document.querySelector(".content").scrollWidth<=document.querySelector(".content").clientWidth'),'窄窗口编辑完整可用');
  await button('取消');
  await send('Emulation.clearDeviceMetricsOverride');
  console.log(JSON.stringify({ok:true,version:'待办工作区',cases:'新增/防重复/中文输入/筛选/排序/折叠/编辑保护/冲突/完成撤销/删除确认撤销/备注搜索/记录/窄窗口'}));
} catch(error) { console.error(error); process.exitCode=1; }
finally { await stop(); rmSync(work,{recursive:true,force:true}); }
