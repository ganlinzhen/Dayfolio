#!/usr/bin/env node
// HTML 工具隔离验收：文件导入、横向卡片、键盘打开与删除。
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'dayfolio-tools-'));
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
  if (!process.env.DAYFOLIO_TOOLS_SCREENSHOTS) return;
  const dir = resolve(process.env.DAYFOLIO_TOOLS_SCREENSHOTS);
  mkdirSync(dir, { recursive: true });
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
  const click = async label => evaluate('(() => { const b=[...document.querySelectorAll("button")].find(b=>b.textContent.trim()===' + JSON.stringify(label) + '); if(!b)throw new Error("找不到按钮"); b.click(); })()');
  const addTool = input => invoke('window.tododesk.tools.add(' + JSON.stringify(input) + ')');
  const category = await invoke('window.tododesk.tools.addCategory({name:"赛事"})');
  const realHtml = process.env.DAYFOLIO_TOOLS_REAL_HTML;
  const html = realHtml ? readFileSync(realHtml) : Buffer.from('<h1>英雄联盟全球总决赛</h1>');
  await addTool({title:'2026 英雄联盟全球总决赛',icon:'trophy',category_id:category.id,files:[{name:'index.html',contentBase64:html.toString('base64')}]});
  await click('工具箱');
  await until(() => evaluate('!!document.querySelector(".tool-card")'), '工具箱加载');
  const labels = await evaluate('document.querySelector("[aria-label=工具箱]").innerText');
  assert(!/运行时工具|安装或更新工具包|停用|卸载|回滚|已启用|编辑工具|新增工具/.test(labels), '列表不再显示旧包管理与版本功能');
  assert(await evaluate('!window.tododesk.extensions.install && !window.tododesk.extensions.rollback && !window.tododesk.extensions.setEnabled'), '预加载不再暴露包管理方法');
  await click('导入 HTML');
  await until(() => evaluate('!!document.querySelector(".modal input[type=file]")'), 'HTML 导入表单');
  const file = join(work, 'token解析.html');
  writeFileSync(file, '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><h1>Token 解析</h1><button id="decode" onclick="document.querySelector(\'#result\').textContent=\'解析成功\'">解析</button><p id="result">等待解析</p></html>');
  const {root} = await send('DOM.getDocument');
  const {nodeId} = await send('DOM.querySelector',{nodeId:root.nodeId,selector:'.modal input[type=file]'});
  await send('DOM.setFileInputFiles',{nodeId,files:[file]});
  await until(() => evaluate('document.querySelector(".file-list")?.textContent.includes("token解析.html") && document.querySelector(".modal .form-input").value === "token解析"'), '真实文件读取并自动填入名称');
  await capture(send, 'tool-import');
  await click('导入');
  await until(() => evaluate('!document.querySelector(".modal") && document.querySelectorAll(".tool-card").length === 2'), '导入结果进入列表');
  assert((await invoke('window.tododesk.tools.list()')).length === 2, 'HTML 通过 IPC 与共用 core 保存');
  const layout = () => evaluate('(() => { const cards=[...document.querySelectorAll(".tool-card")]; return cards.length===2 && cards.every(card=>{ const icon=card.querySelector(".tool-card-icon").getBoundingClientRect(),title=card.querySelector(".tool-card-title").getBoundingClientRect(),r=card.getBoundingClientRect(); return icon.right<=title.left && Math.abs((icon.top+icon.height/2)-(title.top+title.height/2))<2 && r.height<=80 && card.scrollWidth<=card.clientWidth && r.right<=innerWidth; }); })()');
  assert(await layout(), '横向卡片：左图标、右名称，紧凑且不溢出');
  await capture(send, 'tools');
  await send('Emulation.setDeviceMetricsOverride',{width:760,height:800,deviceScaleFactor:1,mobile:false});
  assert(await layout(), '窄窗口仍保持横向卡片');
  await capture(send, 'tools-narrow');
  await send('Emulation.clearDeviceMetricsOverride');
  await send('Page.bringToFront');
  await evaluate('[...document.querySelectorAll(".tool-card-open")].find(b=>b.textContent==="token解析").focus()');
  await until(() => evaluate('Number(getComputedStyle(document.activeElement.closest(".tool-card").querySelector(".tool-card-delete")).opacity)>0'), '键盘聚焦时删除入口可见');
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',unmodifiedText:'\r',windowsVirtualKeyCode:13,nativeVirtualKeyCode:36});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await until(() => evaluate('!!document.querySelector(".tool-iframe")'), '键盘打开 HTML');
  const sessionId = await until(async () => events.find(event=>event.method==='Target.attachedToTarget' && event.params.targetInfo.type==='iframe')?.params.sessionId, '连接 HTML 子页面');
  const runFrame = async expression => {
    const result=await send('Runtime.evaluate',{expression,returnByValue:true},sessionId);
    if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  await until(() => runFrame('document.querySelector("h1")?.textContent === "Token 解析"'), '真实 HTML 内容加载');
  assert(true, '真实 HTML 内容成功加载');
  await runFrame('document.querySelector("#decode").click()');
  assert(await runFrame('document.querySelector("#result").textContent === "解析成功"'), 'HTML 内脚本交互正常');
  await evaluate('document.querySelector(".tool-crumb-back").click()');
  await until(() => evaluate('document.querySelectorAll(".tool-card").length === 2'), '返回列表');
  await evaluate('(() => { window.confirm=()=>false; document.querySelector("[aria-label=删除token解析]").click(); })()');
  assert((await invoke('window.tododesk.tools.list()')).length === 2, '取消确认不删除工具');
  await evaluate('(() => { window.confirm=()=>true; document.querySelector("[aria-label=删除token解析]").click(); })()');
  await until(() => evaluate('document.querySelectorAll(".tool-card").length === 1'), '确认删除完成');
  assert((await invoke('window.tododesk.tools.list()'))[0].title.includes('英雄联盟'), '只删除指定 HTML，保留其他工具');
  if (realHtml) {
    const start = events.length;
    await evaluate('document.querySelector(".tool-card-open").click()');
    const session = await until(async () => events.slice(start).find(e=>e.method==='Target.attachedToTarget' && e.params.targetInfo.type==='iframe')?.params.sessionId, '连接英雄联盟 HTML');
    const run = async expression => {
      const result = await send('Runtime.evaluate',{expression,returnByValue:true},session);
      if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result?.value;
    };
    await until(() => run('document.querySelectorAll("#matches article").length > 0'), '英雄联盟赛程渲染');
    await until(() => run('[...document.images].every(img=>img.complete && img.naturalWidth>0)'), '英雄联盟内联图片加载');
    assert(true, '转换后的赛程与全部内联图片加载成功');
    await capture(send, 'lol-schedule');
    await run('document.querySelector("[data-view=teams]").click()');
    await until(() => run('!document.querySelector("#teams").hidden && document.querySelectorAll("#team-directory img").length===19'), '19 队目录');
    await capture(send, 'lol-teams');
    await run('document.querySelector("#team-directory [data-team]").click()');
    assert(await run('document.querySelector("#team-detail").open && document.querySelectorAll(".roster-list li").length>=5'), '战队详情与本届人员名单保持可用');
    await run('document.querySelector("#close-detail").click()');
    await run('document.querySelector("[data-view=progress]").click()');
    await until(() => run('!document.querySelector("#progress").hidden && document.querySelector("#playin-chart").children.length>0'), '晋级图渲染');
    await run('document.querySelector("[data-chart=swiss]").click()');
    assert(await run('!document.querySelector("#chart-swiss").hidden'), '瑞士轮晋级图切换正常');
    await capture(send, 'lol-progression');
  }
  console.log('HTML 工具箱隔离验收通过');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await stop();
  rmSync(work, { recursive: true, force: true });
}
