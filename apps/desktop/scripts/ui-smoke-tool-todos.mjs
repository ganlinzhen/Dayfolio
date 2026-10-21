#!/usr/bin/env node
// HTML 工具隔离验收：通用待办接口与欧冠单场、球队批量添加。
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'dayfolio-tool-todos-'));
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
  await send('Target.setAutoAttach', {autoAttach:true,waitForDebuggerOnStart:false,flatten:true});
  return { send, evaluate, events };
}
const capture = async (send, name) => {
  if (!process.env.DAYFOLIO_TOOL_TODOS_SCREENSHOTS) return;
  const dir = resolve(process.env.DAYFOLIO_TOOL_TODOS_SCREENSHOTS);
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
  const add = input => invoke('window.tododesk.tools.add(' + JSON.stringify(input) + ')');
  // 预览断言使用北京时间，显式设置共享时区以适配 UTC 云端宿主。
  await invoke('window.tododesk.runtime.setTimezone({zone:"Asia/Shanghai"})');
  const draft = { sourceKey: 'test:one', title: '桥接测试一', startAt: '2026-11-04T04:00:00+08:00' };
  const probe = await add({title:'待办接口模拟工具',files:[
    {name:'index.html',contentBase64:Buffer.from('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\';script-src \'self\'"><script defer src="app.js"></script></head><body><button id="single">单条</button><button id="batch">批量</button><button id="bad">无效时间</button><button id="named">自定义分类</button><p id="result"></p></body></html>').toString('base64')},
    {name:'app.js',contentBase64:Buffer.from(`const first=${JSON.stringify(draft)};const run=async fn=>{try{window.last=await fn();document.querySelector('#result').textContent=JSON.stringify(window.last)}catch(e){document.querySelector('#result').textContent=e.code}};document.querySelector('#single').onclick=()=>run(()=>dayfolio.todos.create(first));document.querySelector('#batch').onclick=()=>run(()=>dayfolio.todos.createMany([first,{sourceKey:'test:two',title:'桥接测试二',dueDate:'2026-11-05'},{sourceKey:'test:tbd',title:'时间待定测试'}]));document.querySelector('#bad').onclick=()=>run(()=>dayfolio.todos.create({...first,sourceKey:'bad',startAt:'2026-11-04T04:00:00'}));document.querySelector('#named').onclick=()=>run(()=>dayfolio.todos.create({sourceKey:'reading:one',title:'阅读计划事项',dueDate:'2026-11-06'},{category:{key:'reading',title:'阅读计划',color:'green'}}));`).toString('base64')},
  ]});
  await evaluate('[...document.querySelectorAll(".nav-item")].find(b=>b.textContent.includes("工具箱")).click()');
  await until(()=>evaluate('!!document.querySelector(".tool-card-open")'),'工具列表');
  const open = async title => {
    const start = events.length;
    await evaluate(`[...document.querySelectorAll('.tool-card-open')].find(b=>b.textContent===${JSON.stringify(title)}).click()`);
    const id = await until(async()=>events.slice(start).find(e=>e.method==='Target.attachedToTarget'&&e.params.targetInfo.type==='iframe')?.params.sessionId,'HTML 子页面');
    const run = async expression => {
      const result = await send('Runtime.evaluate',{expression:`(async()=>(${expression}))()`,returnByValue:true,awaitPromise:true},id);
      if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result?.value;
    };
    await until(()=>run('window.dayfolio?.ready.then(()=>true)'),'SDK 连接');
    return run;
  };
  const initialCollections=await invoke('window.tododesk.calendar.listCollections()');
  let run = await open('待办接口模拟工具');
  assert(await run('typeof window.tododesk === "undefined"'),'HTML 无原始 IPC');
  assert(await run('(()=>{try{return !parent.tododesk}catch{return true}})()'),'HTML 无父页面业务对象');
  await run('document.querySelector("#single").click()');
  await until(()=>evaluate('!!document.querySelector(".tool-todo-modal")'),'单条预览');
  assert((await invoke('window.tododesk.todos.list()')).length===0,'预览前后均未写库');
  assert((await invoke('window.tododesk.calendar.listCollections()')).length===initialCollections.length,'预览不创建空分类');
  assert(await evaluate('document.querySelector(".tool-todo-category").textContent.includes("待办接口模拟工具")'),'旧 HTML 不传分类时按工具名称预览');
  assert(await evaluate('document.querySelector(".tool-todo-modal").innerText.includes("2026/11/04 04:00")'),'固定时刻按共享时区显示');
  await capture(send,'generic-single-preview');
  await click('.tool-todo-modal .btn');
  await until(()=>run('document.querySelector("#result").textContent === "USER_CANCELLED"'),'取消回传');
  assert((await invoke('window.tododesk.todos.list()')).length===0,'取消不创建待办');
  assert((await invoke('window.tododesk.calendar.listCollections()')).length===initialCollections.length,'取消预览不创建分类');
  await run('document.querySelector("#single").click()');
  await until(()=>evaluate('!!document.querySelector(".tool-todo-modal")'),'重新预览');
  await click('.tool-todo-modal .btn.primary');
  await until(()=>run('window.last?.created === 1'),'单条成功回传');
  const first = (await invoke('window.tododesk.todos.list()'))[0];
  const defaultCategory=first.collection_id;
  assert(!!defaultCategory&&(await invoke('window.tododesk.calendar.listCollections()')).find(c=>c.id===defaultCategory)?.title==='待办接口模拟工具','第一次确认时创建通用分类并关联待办');
  await invoke('window.tododesk.calendar.setVisibility('+JSON.stringify({collectionId:defaultCategory,visible:false})+')');
  assert(first.scheduled_start_at==='2026-11-03T20:00:00.000Z'&&first.scheduled_end_at===null,'真实 UTC 开球时间、无虚构结束时间');
  await invoke(`window.tododesk.todos.update({id:${first.id},title:'用户标题',notes:'私人笔记'})`);
  await invoke(`window.tododesk.todos.complete({id:${first.id}})`);
  await run('window.last=null,document.querySelector("#single").click()');
  await until(()=>run('window.last?.reused === 1'),'重复添加复用');
  assert(!await evaluate('!!document.querySelector(".tool-todo-modal")'),'重复添加无需再次确认');
  const kept=(await invoke('window.tododesk.todos.list({status:"all"})')).find(t=>t.id===first.id);
  assert(kept.title==='用户标题'&&kept.notes==='私人笔记'&&kept.status==='done','重复添加保留用户修改和已完成状态');
  await run('window.last=null,document.querySelector("#batch").click()');
  await until(()=>evaluate('document.querySelectorAll(".tool-todo-row").length===3'),'批量预览');
  assert(await evaluate('document.querySelector(".tool-todo-modal").innerText.includes("时间待定 · 不排期")'),'未知时间不推算');
  assert(await evaluate('document.querySelector(".tool-todo-row input").disabled'),'已有事项不可重复勾选');
  await evaluate('document.querySelectorAll(".tool-todo-row input")[2].click()');
  await click('.tool-todo-modal .btn.primary');
  await until(()=>run('window.last?.created===1'),'按勾选项创建');
  assert((await invoke('window.tododesk.todos.list({status:"all"})')).length===2,'批量只创建选中且不存在的事项');
  const reusedCollections=await invoke('window.tododesk.calendar.listCollections()');
  assert(reusedCollections.length===initialCollections.length+1&&!reusedCollections.find(c=>c.id===defaultCategory).visible,'后续批量复用分类并保留日历隐藏偏好');
  await run('document.querySelector("#bad").click()');
  await until(()=>run('document.querySelector("#result").textContent === "EVENT_INVALID"'),'无时区请求被拒绝');
  assert((await invoke('window.tododesk.todos.list({status:"all"})')).length===2,'无效请求不产生部分写入');
  await invoke(`window.tododesk.todos.delete({id:${first.id}})`);
  await run('window.last=null,document.querySelector("#single").click()');
  await until(()=>run('window.last?.deleted===1'),'已删除状态回传');
  assert((await invoke('window.tododesk.todos.list({status:"all"})')).length===1,'被删除的来源待办不自动复活');
  const beforeNamed=(await invoke('window.tododesk.calendar.listCollections()')).length;
  await run('window.last=null,document.querySelector("#named").click()');
  await until(()=>evaluate('document.querySelector(".tool-todo-category")?.textContent.includes("阅读计划")'),'自定义分类预览');
  assert((await invoke('window.tododesk.calendar.listCollections()')).length===beforeNamed,'HTML 分类声明在确认前不落库');
  await click('.tool-todo-modal .btn');
  await until(()=>run('document.querySelector("#result").textContent === "USER_CANCELLED"'),'自定义分类取消');
  assert((await invoke('window.tododesk.calendar.listCollections()')).length===beforeNamed,'自定义分类取消后不留空记录');
  await run('document.querySelector("#named").click()');
  await until(()=>evaluate('!!document.querySelector(".tool-todo-modal")'),'再次确认自定义分类');
  await click('.tool-todo-modal .btn.primary');
  await until(()=>run('window.last?.created===1'),'自定义分类创建成功');
  const namedCategory=await run('window.last.category.id');
  assert((await invoke('window.tododesk.todos.list('+JSON.stringify({collection_id:namedCategory})+')')).length===1,'MCP 共用的分类筛选返回真实关联待办');
  await run('window.last=null,document.querySelector("#named").click()');
  await until(()=>run('window.last?.reused===1'),'自定义分类重复复用');
  assert((await invoke('window.tododesk.calendar.listCollections()')).length===beforeNamed+1,'相同工具分类键不会重复建分类');
  await click('.tool-crumb-back');
  await until(()=>evaluate('!!document.querySelector(".tool-card-open")'),'返回列表');
  const denied=await until(async()=>{const result=await evaluate(`window.tododesk.toolTodos.getStatus({toolId:${probe.id},sourceKeys:['test:one']})`);return result.code==='PERMISSION_DENIED'&&result},'原生子 frame 释放');
  assert(denied.code==='PERMISSION_DENIED','已关闭工具不能继续使用宿主接口');
  await evaluate('[...document.querySelectorAll(".nav-item")].find(b=>b.textContent.trim()==="待办").click()');
  await until(()=>evaluate(`!!document.querySelector('select[aria-label=筛选待办分类] option[value="${namedCategory}"]')`),'待办分类选项加载');
  await evaluate(`(()=>{const select=document.querySelector('select[aria-label=筛选待办分类]');select.value=${JSON.stringify(namedCategory)};select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await until(()=>evaluate('document.querySelectorAll(".todo-card").length===1&&document.querySelector(".todo-title")?.textContent==="阅读计划事项"'),'待办列表按分类筛选');
  assert(await evaluate('document.querySelector(".todo-category").textContent==="阅读计划"'),'待办行显示真实分类名称');
  await capture(send,'generic-todo-category-filter');
  await send('Emulation.setDeviceMetricsOverride',{width:760,height:800,deviceScaleFactor:1,mobile:false});
  assert(await evaluate('document.querySelector(".todo-toolbar").scrollWidth<=document.querySelector(".todo-toolbar").clientWidth'),'窄窗口待办分类筛选无横向溢出');
  await capture(send,'generic-todo-category-narrow');
  await send('Emulation.clearDeviceMetricsOverride');
  await evaluate('[...document.querySelectorAll(".nav-item")].find(b=>b.textContent.trim()==="今日").click()');
  await until(()=>evaluate('!!document.querySelector("[aria-label=日历更多操作]")&&!document.querySelector("[aria-label=日历更多操作]").disabled'),'日历分类入口就绪');
  assert(await evaluate('!document.querySelector(".cal-display-panel")'),'显示内容已收进更多菜单');
  await evaluate('document.querySelector("[aria-label=日历更多操作]").focus()');
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
  await until(()=>evaluate('document.activeElement?.getAttribute("role")==="menuitem"'),'方向键打开菜单并聚焦');
  await capture(send,'calendar-more-menu');
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  assert(await evaluate('!document.querySelector("[role=menu]")&&document.activeElement?.getAttribute("aria-label")==="日历更多操作"'),'Esc 关闭菜单并返回入口');
  const manage=async()=>{await click('[aria-label=日历更多操作]');await until(()=>evaluate('!!document.querySelector("[role=menuitem]")'),'分类菜单就绪');await click('[role=menuitem]');await until(()=>evaluate('!!document.querySelector(".cal-collections-modal")'),'管理分类弹窗');};
  await manage();
  assert(await evaluate('document.querySelectorAll(".cal-managed-collection").length===5&&document.querySelector("[aria-label=删除基础待办]").disabled'),'全部分类进入弹窗，内置分类明确保护');
  await click('[aria-label=显示阅读计划]');
  await until(async()=>!(await invoke('window.tododesk.calendar.listCollections()')).find(c=>c.id===namedCategory).visible,'分类隐藏偏好已保存');
  const range={fromDate:'2026-11-06',toDateExclusive:'2026-11-07',displayTimezone:await invoke('window.tododesk.runtime.timezone()')};
  assert(!(await invoke('window.tododesk.calendar.queryItems('+JSON.stringify(range)+')')).items.some(i=>i.collectionId===namedCategory),'勾选控制同一日历投影');
  await click('[aria-label=编辑阅读计划]');
  await until(()=>evaluate('!!document.querySelector(".cal-collection-editor [aria-label=分类名称]")'),'分类编辑表单就绪');
  await evaluate(`(()=>{const input=document.querySelector('[aria-label=分类名称]');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,'读书会');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click('[aria-label=玫瑰色]');
  await capture(send,'calendar-category-edit');
  await click('.cal-collection-editor button[type=submit]');
  await until(()=>evaluate('!!document.querySelector("[aria-label=编辑读书会]")&&!document.querySelector(".cal-collection-editor")'),'分类编辑保存');
  assert((await invoke('window.tododesk.calendar.listCollections()')).find(c=>c.id===namedCategory).color==='rose','名称颜色保存且不改变分类身份');
  await click('[aria-label=删除读书会]');
  await capture(send,'calendar-category-delete');
  await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==="取消删除").click()');
  assert((await invoke('window.tododesk.calendar.listCollections()')).some(c=>c.id===namedCategory),'取消删除保留分类');
  await click('[aria-label=显示读书会]');
  await until(async()=>(await invoke('window.tododesk.calendar.listCollections()')).find(c=>c.id===namedCategory).visible,'重新显示分类');
  await send('Emulation.setDeviceMetricsOverride',{width:760,height:800,deviceScaleFactor:1,mobile:false});
  assert(await evaluate('(()=>{const modal=document.querySelector(".cal-collections-modal"),r=modal.getBoundingClientRect();return modal.scrollWidth<=modal.clientWidth&&r.left>=0&&r.right<=innerWidth})()'),'窄窗口分类管理不溢出');
  assert(await evaluate('(()=>{const toolbar=document.querySelector(".cal-toolbar"),actions=document.querySelector(".cal-create-actions"),buttons=actions.querySelectorAll("button");return toolbar.scrollWidth<=toolbar.clientWidth&&buttons[0].getBoundingClientRect().right<=buttons[1].getBoundingClientRect().left&&Math.abs(buttons[0].getBoundingClientRect().top-buttons[1].getBoundingClientRect().top)<2})()'),'窄窗口新建日程与更多按钮始终相邻');
  await capture(send,'calendar-category-narrow');
  await send('Emulation.clearDeviceMetricsOverride');
  await click('[aria-label=关闭弹窗]');
  await until(()=>evaluate('!document.querySelector(".cal-collections-modal")'),'关闭分类管理');
  await manage();
  assert(await evaluate('document.querySelector("[aria-label=显示读书会]").checked'),'重开弹窗保留分类与显示偏好');
  await click('[aria-label=删除读书会]');
  const namedTodo=(await invoke('window.tododesk.todos.list('+JSON.stringify({collection_id:namedCategory})+')'))[0];
  await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==="确认删除分类").click()');
  await until(()=>evaluate('!document.querySelector("[aria-label=删除读书会]")'),'确认删除分类');
  const categoryKept=(await invoke('window.tododesk.todos.list({status:"all"})')).find(t=>t.id===namedTodo.id);
  assert(categoryKept?.collection_id==='builtin.todo'&&categoryKept.title===namedTodo.title&&categoryKept.due_date===namedTodo.due_date,'删除分类保留待办并转入基础分类');
  await click('[aria-label=关闭弹窗]');
  await until(()=>evaluate('document.activeElement?.getAttribute("aria-label")==="日历更多操作"'),'弹窗关闭后恢复焦点');
  await evaluate('[...document.querySelectorAll(".nav-item")].find(b=>b.textContent.trim()==="待办").click()');
  await until(()=>evaluate('!!document.querySelector("select[aria-label=筛选待办分类]")'),'核对外部删除后的筛选恢复');
  await evaluate(`(()=>{const select=document.querySelector('select[aria-label=筛选待办分类]');select.value=${JSON.stringify(defaultCategory)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(()=>evaluate('document.querySelector("select[aria-label=筛选待办分类]").value==='+JSON.stringify(defaultCategory)),'选中将被外部删除的分类');
  await invoke('window.tododesk.calendar.deleteCollection('+JSON.stringify({collectionId:defaultCategory,expectedTitle:'待办接口模拟工具'})+')');
  await evaluate('[...document.querySelectorAll(".todo-toolbar .seg button")].find(b=>b.textContent==="全部").click()');
  await until(()=>evaluate('document.querySelector("select[aria-label=筛选待办分类]").value===""&&document.querySelectorAll(".todo-card").length===2'),'分类被其他入口删除后自动恢复全部待办');
  assert(await evaluate('!document.querySelector(".notice.error")'),'失效分类筛选不会困在错误页面');
  await evaluate('[...document.querySelectorAll(".nav-item")].find(b=>b.textContent.includes("工具箱")).click()');
  await until(()=>evaluate('!!document.querySelector(".tool-card-open")'),'分类验收后返回工具箱');
  const dir=process.env.DAYFOLIO_UCL_DIR;
  if(!dir){console.log(JSON.stringify({ok:true,genericTodos:true,ucl:false,note:'未指定 DAYFOLIO_UCL_DIR，欧冠真实页面另行验收'}))}else{
  const files=[];
  const walk=(base,prefix='')=>{for(const entry of readdirSync(base,{withFileTypes:true})){const name=prefix+entry.name;if(entry.isDirectory())walk(join(base,entry.name),name+'/');else files.push({name,contentBase64:readFileSync(join(base,entry.name)).toString('base64')})}};
  walk(dir);
  const ucl=await add({title:'欧冠 2026/27 · 赛事中心',entry_file:'ucl-2026-27.html',files});
  await evaluate('[...document.querySelectorAll(".nav-item")].find(b=>b.textContent.includes("今日")).click()');
  await evaluate('[...document.querySelectorAll(".nav-item")].find(b=>b.textContent.includes("工具箱")).click()');
  await until(()=>evaluate('document.querySelectorAll(".tool-card-open").length===2'),'欧冠工具列表');
  run=await open('欧冠 2026/27 · 赛事中心');
  await until(()=>run('todoReady && M.length===144'),'欧冠赛程与待办连接');
  const chosen=await run('M.find(futureMatch)');
  if(!chosen)throw new Error('欧冠快照已无未来比赛，请先更新测试输入');
  await run(`document.querySelector('[data-round="${chosen.round}"]').click()`);
  await until(()=>run(`!document.querySelector('[data-todo="${chosen.id}"]').disabled`),'单场入口就绪');
  await run(`document.querySelector('[data-save="${chosen.id}"]').click()`);
  await run(`document.querySelector('[data-todo="${chosen.id}"]').scrollIntoView({block:'center'})`);
  await capture(send,'ucl-single-actions');
  await run(`document.querySelector('[data-todo="${chosen.id}"]').click()`);
  await until(()=>evaluate('!!document.querySelector(".tool-todo-modal")'),'欧冠单场预览');
  await capture(send,'ucl-single-preview');
  await click('.tool-todo-modal .btn.primary');
  await until(()=>run(`document.querySelector('[data-todo-details="${chosen.id}"],[data-todo="${chosen.id}"]')?.textContent.startsWith('已添加')`),'比赛回读已添加及详情入口');
  const baseCount=2;
  assert((await invoke('window.tododesk.todos.list({status:"all"})')).length===baseCount+1,'欧冠比赛真实加入待办');
  const uclCategory=(await invoke('window.tododesk.calendar.listCollections()')).find(c=>c.title==='欧冠');
  assert(!!uclCategory&&(await invoke('window.tododesk.todos.list('+JSON.stringify({collection_id:uclCategory.id})+')')).length===1,'赛事页面通过通用分类声明创建欧冠分类');
  await run(`document.querySelector('[data-team="${chosen.home}"]').click()`);
  await run(`document.querySelector('[data-follow="${chosen.home}"]').click()`);
  const expected=await run(`M.filter(m=>(m.home==='${chosen.home}'||m.away==='${chosen.home}')&&futureMatch(m)).length`);
  await run(`document.querySelector('[data-team-todos="${chosen.home}"]').click()`);
  await until(()=>evaluate('!!document.querySelector(".tool-todo-modal")'),'球队批量预览');
  assert(await evaluate(`document.querySelectorAll('.tool-todo-row').length===${expected}`),'球队批量只包含当前已知的未来比赛');
  assert(await evaluate('document.querySelectorAll(".tool-todo-row input:disabled").length===1'),'单场已添加比赛在球队批量中去重');
  await capture(send,'ucl-team-preview');
  await click('.tool-todo-modal .btn.primary');
  await until(()=>run('!todoBusy'),'球队批量完成');
  assert((await invoke('window.tododesk.todos.list({status:"all"})')).length===baseCount+expected,'球队批量真实落库且与单场共用去重');
  await run(`document.querySelector('[data-team-todos="${chosen.home}"]').click()`);
  await until(()=>run('!todoBusy'),'重复球队批量完成');
  assert((await invoke('window.tododesk.todos.list({status:"all"})')).length===baseCount+expected,'重复球队批量不产生新待办');
  assert(await run(`prefs.teams.includes('${chosen.home}') && prefs.matches.includes('${chosen.id}')`),'原球队关注与比赛收藏保留');
  await capture(send,'ucl-team-added');
  await send('Emulation.setDeviceMetricsOverride',{width:760,height:800,deviceScaleFactor:1,mobile:false});
  await run("document.querySelector('.team-todo-head').scrollIntoView({block:'start'})");
  assert(await run('[...document.querySelectorAll(".match")].every(row=>row.scrollWidth<=row.clientWidth)'),'窄窗口比赛行与待办按钮无溢出');
  await capture(send,'ucl-narrow');
  console.log(JSON.stringify({ok:true,toolId:ucl.id,teamFutureMatches:expected,todoCount:baseCount+expected}));
  }
} catch(error){console.error(error);process.exitCode=1}
finally{await stop();rmSync(work,{recursive:true,force:true})}
