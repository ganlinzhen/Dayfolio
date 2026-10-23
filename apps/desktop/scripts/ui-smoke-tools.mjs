#!/usr/bin/env node
// HTML 工具隔离验收：导入、浏览与编辑、分类/排序/图片、文件保护及删除。
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
  await pause(200);
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
  const click = async label => evaluate('(() => { const b=[...(document.querySelector(".modal") ?? document).querySelectorAll("button")].find(b=>b.textContent.trim()===' + JSON.stringify(label) + '); if(!b)throw new Error("找不到按钮"); b.click(); })()');
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
  assert(await evaluate('JSON.stringify([...document.querySelectorAll("[aria-label=工具箱] .panel-head button")].map(b=>b.textContent.trim())) === JSON.stringify(["编辑","导入"])'), '普通模式只有编辑和导入两个按钮');
  assert(await evaluate('!document.querySelector(".tool-card-delete")'), '卡片不显示删除按钮');
  await click('导入');
  await until(() => evaluate('!!document.querySelector(".modal input[type=file]")'), 'HTML 导入表单');
  const file = join(work, 'token解析.html');
  writeFileSync(file, '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><h1>Token 解析</h1><button id="decode" onclick="document.querySelector(\'#result\').textContent=\'解析成功\'">解析</button><p id="result">等待解析</p></html>');
  const {root} = await send('DOM.getDocument');
  const {nodeId} = await send('DOM.querySelector',{nodeId:root.nodeId,selector:'.modal .tool-html-files'});
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
  await click('编辑');
  await until(() => evaluate('!!document.querySelector(".tool-card-organize")'), '进入编辑模式');
  assert(await evaluate('!document.querySelector(".tool-card-delete") && !!document.querySelector(".tool-edit-notice")'), '编辑模式卡片也没有删除按钮');
  await click('管理分类');
  await evaluate('(() => { const input=document.querySelector(".cat-add input"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"效率");input.dispatchEvent(new Event("input",{bubbles:true})); })()');
  await click('添加');
  await until(() => evaluate('document.querySelectorAll(".cat-row").length===2'), '新增分类');
  await capture(send, 'tool-categories');
  await click('完成');
  await until(() => evaluate('!document.querySelector(".modal")'), '关闭分类管理');
  const imported = (await invoke('window.tododesk.tools.list()')).find(t=>t.title==='token解析');
  await evaluate('(() => { const select=[...document.querySelectorAll(".tool-card-organize select")].find(e=>e.getAttribute("aria-label")==="token解析的分类"); select.value=' + JSON.stringify(String(category.id)) + ';select.dispatchEvent(new Event("change",{bubbles:true})); })()');
  await until(async () => (await invoke('window.tododesk.tools.list()')).find(t=>t.id===imported.id).category_id===category.id, '移动到赛事分组');
  await until(() => evaluate('!!document.querySelector("[aria-label=上移token解析]") && !document.querySelector("[aria-label=上移token解析]").disabled'), '同组排序可用');
  await evaluate('document.querySelector("[aria-label=上移token解析]").click()');
  await until(async () => (await invoke('window.tododesk.tools.list()'))[0].id===imported.id, '组内上移保存');
  await until(() => evaluate('document.querySelector(".tool-card-title")?.textContent==="token解析"'), '顺序刷新');
  await capture(send, 'tools-edit');
  await send('Emulation.setDeviceMetricsOverride',{width:760,height:800,deviceScaleFactor:1,mobile:false});
  assert(await evaluate('[...document.querySelectorAll(".tool-card")].every(c=>c.scrollWidth<=c.clientWidth && c.getBoundingClientRect().right<=innerWidth)'), '窄窗口编辑卡片不溢出');
  await capture(send, 'tools-edit-narrow');
  await send('Emulation.clearDeviceMetricsOverride');
  await evaluate('document.querySelector(".tool-card-open").click()');
  await until(() => evaluate('!!document.querySelector("#tool-title") && !document.querySelector(".tool-editor-fields").disabled'), '打开完整工具编辑器');
  await evaluate('(() => {const input=document.querySelector("#tool-title");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"取消的改名");input.dispatchEvent(new Event("input",{bubbles:true}));})()');
  await click('取消');
  assert((await invoke('window.tododesk.tools.list()')).find(t=>t.id===imported.id).title==='token解析', '取消不保存编辑草稿');
  await evaluate('document.querySelector(".tool-card-open").click()');
  await until(() => evaluate('!!document.querySelector("#tool-title") && !document.querySelector(".tool-editor-fields").disabled'), '重新打开编辑器');
  await click('图片');
  const imagePath=join(work,'icon.svg');
  writeFileSync(imagePath,'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><path fill="none" stroke="white" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" d="M23 21 12 32l11 11m18-22 11 11-11 11m-5-29-8 36"/></svg>');
  const doc=await send('DOM.getDocument');
  const imageNode=await send('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'.tool-image-picker input'});
  await send('DOM.setFileInputFiles',{nodeId:imageNode.nodeId,files:[imagePath]});
  await until(() => evaluate('!!document.querySelector(".tool-appearance img")?.naturalWidth'), '本地图片图标预览');
  // 属性值含井号，使用属性比较避免选择器转义差异。
  await evaluate('[...document.querySelectorAll(".tool-color-swatch")].find(b=>b.getAttribute("aria-label")==="背景#6650bd").click()');
  await capture(send, 'tool-editor');
  await click('保存修改');
  await until(() => evaluate('!document.querySelector(".modal")'), '保存完整信息');
  const saved=(await invoke('window.tododesk.tools.list()')).find(t=>t.id===imported.id);
  assert(saved.icon.startsWith('data:image/svg+xml;base64,') && saved.icon_background==='#6650bd', '图片及背景经 IPC/core 保存');
  assert(JSON.stringify(await invoke('window.tododesk.tools.listFiles({id:'+imported.id+'})'))===JSON.stringify(['token解析.html']), '元信息编辑保留原文件');
  await evaluate('document.querySelector(".tool-card-open").click()');
  await until(() => evaluate('!!document.querySelector("#tool-title") && !document.querySelector(".tool-editor-fields").disabled'), '重新打开文件编辑');
  const toolFolder=join(work,'replacement');
  mkdirSync(join(toolFolder,'pages'),{recursive:true});
  mkdirSync(join(toolFolder,'assets'),{recursive:true});
  writeFileSync(join(toolFolder,'index.html'),'<h1>新首页</h1>');
  writeFileSync(join(toolFolder,'pages','detail.html'),'<h1>详情页</h1>');
  writeFileSync(join(toolFolder,'assets','app.js'),'window.ready=true;');
  const folderDoc=await send('DOM.getDocument');
  const folderNode=await send('DOM.querySelector',{nodeId:folderDoc.root.nodeId,selector:'.modal input[webkitdirectory]'});
  await send('DOM.setFileInputFiles',{nodeId:folderNode.nodeId,files:[toolFolder]});
  await until(() => evaluate('document.querySelector(".tool-file-details")?.textContent.includes("assets/app.js")'), '完整文件夹保留子目录');
  await evaluate('(() => { const entry=document.querySelector("#tool-entry");entry.value="pages/detail.html";entry.dispatchEvent(new Event("change",{bubbles:true})); })()');
  await click('保存修改');
  await until(() => evaluate('!document.querySelector(".modal")'), '替换文件并修改入口');
  assert(JSON.stringify(await invoke('window.tododesk.tools.listFiles({id:'+imported.id+'})'))===JSON.stringify(['assets/app.js','index.html','pages/detail.html']), '替换后的完整文件清单读回');
  assert((await invoke('window.tododesk.tools.list()')).find(t=>t.id===imported.id).entry_file==='pages/detail.html', '指定 HTML 入口保存');
  await click('完成编辑');
  assert(await evaluate('!document.querySelector(".tool-card-organize") && !!document.querySelector(".tool-card-icon img")'), '退出编辑后只展示工具入口及图片');
  await click('编辑');
  await evaluate('document.querySelector(".tool-card-open").click()');
  await until(() => evaluate('!!document.querySelector("#tool-title") && !document.querySelector(".tool-editor-fields").disabled'), '在编辑弹窗删除');
  await evaluate('window.confirm=()=>false');
  await click('删除工具');
  assert((await invoke('window.tododesk.tools.list()')).length===2, '取消确认不删除工具');
  await evaluate('window.confirm=()=>true');
  await click('删除工具');
  await until(() => evaluate('!document.querySelector(".modal") && document.querySelectorAll(".tool-card").length===1'), '确认后只删除指定工具');
  assert((await invoke('window.tododesk.tools.list()'))[0].title.includes('英雄联盟'), '其他工具保留');
  await click('完成编辑');
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
