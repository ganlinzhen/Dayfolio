#!/usr/bin/env node
// 通用 HTML 持续关注隔离验收：宿主确认、来源改期与手动接管。
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'dayfolio-tool-following-'));
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
  if (!process.env.DAYFOLIO_TOOL_FOLLOW_SCREENSHOTS) return;
  const dir = resolve(process.env.DAYFOLIO_TOOL_FOLLOW_SCREENSHOTS);
  mkdirSync(dir, { recursive: true });
  await send('Runtime.evaluate', { expression: "Promise.all([...document.querySelectorAll('.modal-mask')].flatMap(element => element.getAnimations()).filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {})))", awaitPromise: true });
  await send('Runtime.evaluate', { expression: "document.querySelectorAll('.toast-close').forEach(button => button.click())" });
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(dir, `${name}.png`), Buffer.from(shot.data, 'base64'));
};

try {
  const {send,evaluate,events}=await launch();
  const invoke=async expression=>{const r=await evaluate(expression);if(!r.ok)throw new Error(r.error);return r.data;};
  const click=async selector=>{await until(()=>evaluate(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`),'可用按钮 '+selector);await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);};
  const nav=async label=>evaluate(`[...document.querySelectorAll('.nav-item')].find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`);
  const snapshot=revision=>({schemaVersion:1,revision,groups:[{key:'reading',title:'读书会活动'}],category:{key:'events',title:'读书会',color:'green'},items:[{sourceKey:'one',title:revision===1?'第一场阅读讨论':'第一场改期讨论',startAt:revision===1?'2099-11-01T00:00:00Z':'2099-11-05T00:00:00Z',groupKeys:['reading']},{sourceKey:'two',title:'第二场阅读讨论',startAt:'2099-11-02T00:00:00Z',groupKeys:['reading']},...(revision>1?[{sourceKey:'three',title:'新增阅读讨论',dueDate:'2099-11-06',groupKeys:['reading']}]:[])]});
  const files=s=>[
    {name:'index.html',contentBase64:Buffer.from('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\';script-src \'self\'"><script defer src="app.js"></script></head><body><h1>读书会</h1><button id="follow">持续关注读书会</button><button id="single">持续关注单项</button><button id="stop">停止分组关注</button><p id="result"></p></body></html>').toString('base64')},
    {name:'dayfolio-follow.json',contentBase64:Buffer.from(JSON.stringify(s)).toString('base64')},
    {name:'app.js',contentBase64:Buffer.from(`window.last=null;const run=async fn=>{try{window.last=await fn();document.querySelector('#result').textContent='完成'}catch(e){document.querySelector('#result').textContent=e.code}};document.querySelector('#follow').onclick=()=>run(()=>dayfolio.following.follow({kind:'group',key:'reading'}));document.querySelector('#single').onclick=()=>run(()=>dayfolio.following.follow({kind:'item',key:'one'}));document.querySelector('#stop').onclick=()=>run(()=>dayfolio.following.unfollow({kind:'group',key:'reading'}));`).toString('base64')},
  ];
  const tool=await invoke('window.tododesk.tools.add('+JSON.stringify({title:'持续关注通用探针',files:files(snapshot(1))})+')');
  await nav('工具箱');await until(()=>evaluate('!!document.querySelector(".tool-card-open")'),'工具列表');
  const open=async title=>{
    const start=events.length;await evaluate(`[...document.querySelectorAll('.tool-card-open')].find(b=>b.textContent===${JSON.stringify(title)}).click()`);
    const id=await until(async()=>events.slice(start).find(e=>e.method==='Target.attachedToTarget'&&e.params.targetInfo.type==='iframe')?.params.sessionId,'HTML frame');
    const run=async expression=>{const r=await send('Runtime.evaluate',{expression:`(async()=>(${expression}))()`,returnByValue:true,awaitPromise:true},id);if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result?.value;};
    await until(()=>run('window.dayfolio?.ready.then(()=>true)'),'SDK 连接');return run;
  };
  let run=await open('持续关注通用探针');
  assert(await run('!!dayfolio.following&&!window.tododesk'),'通用 SDK 有持续关注，没有原始 IPC');
  await run('document.querySelector("#follow").click()');await until(()=>evaluate('!!document.querySelector(".tool-follow-modal")'),'分组关注预览');
  assert((await invoke('window.tododesk.todos.list()')).length===0&&(await invoke('window.tododesk.calendar.listCollections()')).length===3,'导入及预览不创建待办或空分类');
  await capture(send,'generic-follow-preview');await click('.tool-follow-modal .modal-foot .btn:not(.primary)');
  await until(()=>run('document.querySelector("#result").textContent==="USER_CANCELLED"'),'取消回到 HTML');
  assert(!(await run('dayfolio.following.getState()')).rules.length,'取消不登记关注');
  await run('document.querySelector("#follow").click()');await until(()=>evaluate('!!document.querySelector(".tool-follow-modal")'),'再次预览');await click('.tool-follow-modal .modal-foot .primary');
  await until(()=>run('window.last?.created===2'),'确认后自动创建当前两项');
  const before=await invoke('window.tododesk.todos.list({status:"all"})');const one=before.find(t=>t.title==='第一场阅读讨论'),two=before.find(t=>t.title==='第二场阅读讨论');
  assert(before.length===2&&(await invoke('window.tododesk.calendar.listCollections()')).length===4,'首次确认创建分类并关联待办');
  await run('dayfolio.todos.open("one")');await until(()=>evaluate('!!document.querySelector(".tool-follow-details")'),'只改备注的来源详情');
  await evaluate(`(()=>{const input=document.querySelector('[aria-label=待办详情备注]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'只改备注');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await evaluate('[...document.querySelectorAll(".runtime-todo-modal button")].find(b=>b.textContent==="保存待办修改").click()');await until(()=>evaluate('!document.querySelector(".runtime-todo-modal")'),'仅备注保存');
  assert((await invoke('window.tododesk.toolFollowing.getTodo('+JSON.stringify({todoId:one.id})+')')).mode==='follow','界面只改备注仍保留固定时刻与自动跟随');
  await invoke('window.tododesk.todos.update('+JSON.stringify({id:one.id,title:'我的阅读安排',notes:'我的私人备注'})+')');await invoke('window.tododesk.todos.complete('+JSON.stringify({id:two.id})+')');
  const protectedDone=(await invoke('window.tododesk.todos.list({status:"all"})')).find(t=>t.id===two.id);
  await click('.tool-crumb-back');await until(()=>evaluate('!document.querySelector(".tool-iframe")'),'关闭 HTML 页面');
  await invoke('window.tododesk.tools.update('+JSON.stringify({id:tool.id,files:files(snapshot(2))})+')');
  const after=await invoke('window.tododesk.todos.list({status:"all"})');
  assert(after.length===3&&after.find(t=>t.id===one.id).title==='我的阅读安排','页面关闭时更新文件仍同步，手动修改保留且新增事项加入');
  assert(JSON.stringify(after.find(t=>t.id===two.id))===JSON.stringify(protectedDone),'已完成记录原样保留');
  const info=await invoke('window.tododesk.toolFollowing.getTodo('+JSON.stringify({todoId:one.id})+')');
  assert(info.mode==='manual'&&info.source.title==='第一场改期讨论','待办记录手动接管及最新来源');
  await nav('今日');
  // 由受信宿主打开既有待办详情，不新增或改写测试数据。
  await nav('工具箱');await until(()=>evaluate('!!document.querySelector(".tool-card-open")'),'回到工具箱');run=await open('持续关注通用探针');
  await run('document.querySelector("#single").click()');await until(()=>evaluate('!!document.querySelector(".tool-follow-modal")'),'单项持续关注预览');await capture(send,'generic-manual-protected');await click('.tool-follow-modal .modal-foot .primary');await until(()=>run('window.last?.rules?.some(r=>r.kind==="item"&&r.active)'),'单项与分组复用关联');
  assert((await invoke('window.tododesk.todos.list({status:"all"})')).length===3,'单项和分组不会重复建待办');
  await run('dayfolio.todos.open("one")');await until(()=>evaluate('!!document.querySelector(".tool-follow-details")'),'工具打开受信宿主来源详情');
  assert(await evaluate('document.querySelector(".tool-follow-details").textContent.includes("个人安排")'),'宿主显示手动接管及来源更新');await capture(send,'generic-following-details');
  await evaluate('[...document.querySelectorAll(".tool-follow-details button")].find(b=>b.textContent==="恢复跟随…").click()');
  await capture(send,'generic-resume-confirmation');await evaluate('[...document.querySelectorAll(".tool-follow-details button")].find(b=>b.textContent==="确认恢复跟随").click()');
  await until(()=>evaluate('!document.querySelector(".runtime-todo-modal")'),'恢复后关闭旧详情');
  const resumed=(await invoke('window.tododesk.todos.list({status:"all"})')).find(t=>t.id===one.id);
  assert(resumed.title==='第一场改期讨论'&&resumed.notes==='我的私人备注','明确恢复后同步来源，私人备注保留');
  await run('document.querySelector("#stop").click()');await until(()=>evaluate('!!document.querySelector(".tool-follow-modal")'),'取消关注预览');await click('.tool-follow-modal .modal-foot .primary');await until(()=>run('window.last?.rules?.some(r=>r.kind==="group"&&!r.active)'),'取消分组关注');
  assert((await invoke('window.tododesk.todos.list({status:"all"})')).length===3,'取消关注保留所有既有待办');
  await click('.tool-crumb-back');
  const dir=process.env.DAYFOLIO_UCL_DIR;
  if(dir){
    const resources=[];const walk=(folder,prefix='')=>{for(const e of readdirSync(folder,{withFileTypes:true})){const name=prefix+e.name;e.isDirectory()?walk(join(folder,e.name),name+'/'):resources.push({name,contentBase64:readFileSync(join(folder,e.name)).toString('base64')});}};walk(dir);
    const ucl=await invoke('window.tododesk.tools.add('+JSON.stringify({title:'欧冠持续关注验收',entry_file:'ucl-2026-27.html',files:resources})+')');
    await nav('今日');await nav('工具箱');await until(()=>evaluate('document.querySelectorAll(".tool-card-open").length===2'),'欧冠列表');run=await open('欧冠持续关注验收');
    await until(()=>run('followReady&&M.length===144'),'欧冠持续关注连接及来源发布');
    const m=await run('M.find(futureMatch)');
    await run(`(()=>{round=${m.round};current='schedule';render();document.querySelector('[data-follow-match="${m.id}"]').click()})()`);
    await until(()=>evaluate('!!document.querySelector(".tool-follow-modal")'),'欧冠单场关注预览');await capture(send,'ucl-follow-single');await click('.tool-follow-modal .modal-foot .primary');await until(()=>run('!todoBusy&&followStates.get(todoKey(M.find(futureMatch)))?.following'),'欧冠单场关注成功');
    const team=m.home;await run(`detail(${JSON.stringify(team)})`);await run('document.querySelector("[data-follow-team]").click()');await until(()=>evaluate('!!document.querySelector(".tool-follow-modal")'),'欧冠球队关注预览');await capture(send,'ucl-follow-team');await click('.tool-follow-modal .modal-foot .primary');await until(()=>run('!todoBusy&&followRules.get('+JSON.stringify('team:'+team)+')'),'球队关注持久保存');
    const expected=await run(`M.filter(m=>(m.home===${JSON.stringify(team)}||m.away===${JSON.stringify(team)})&&futureMatch(m)).length`);
    assert((await invoke('window.tododesk.todos.list({status:"all"})')).length===3+expected,'欧冠单场与球队关注共用去重');
    await send('Emulation.setDeviceMetricsOverride',{width:760,height:800,deviceScaleFactor:1,mobile:false});
    await capture(send,'ucl-follow-narrow');
    const overflow=await run('[...document.querySelectorAll(".match")].filter(e=>e.scrollWidth>e.clientWidth).map(e=>({width:e.clientWidth,scroll:e.scrollWidth,columns:getComputedStyle(e).gridTemplateColumns,children:[...e.children].map(c=>({class:c.className,width:c.clientWidth,scroll:c.scrollWidth}))}))');
    if(overflow.length)console.log(JSON.stringify(overflow.slice(0,2)));
    assert(!overflow.length,'窄窗口添加和持续关注操作不溢出');await capture(send,'ucl-follow-narrow');await send('Emulation.clearDeviceMetricsOverride');
    await click('.tool-crumb-back');
    const changed=JSON.parse(readFileSync(join(dir,'dayfolio-follow.json'),'utf8'));changed.revision++;const target=changed.items.find(i=>i.sourceKey===`uefa:2026-27:${m.id}`);target.startAt=new Date(Date.parse(target.startAt)+86400000).toISOString();
    // 完整文件更新走生产同一 IPC，HTML 关闭时确认自动改期。
    const updated=resources.map(f=>f.name==='dayfolio-follow.json'?{...f,contentBase64:Buffer.from(JSON.stringify(changed)).toString('base64')}:f);
    await invoke('window.tododesk.tools.update('+JSON.stringify({id:ucl.id,files:updated})+')');
    const status=await invoke('window.tododesk.todos.list({status:"all"})');const actual=status.find(t=>t.source===`tool:${ucl.id}`&&t.scheduled_start_at===target.startAt);
    assert(!!actual,'欧冠关闭页面后来源改期同步到原待办');
  }
  console.log(JSON.stringify({ok:true,genericFollowing:true,ucl:!!dir}));
}catch(error){console.error(error);process.exitCode=1;}finally{await stop();rmSync(work,{recursive:true,force:true});}
