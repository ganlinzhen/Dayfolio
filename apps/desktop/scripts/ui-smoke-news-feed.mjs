// 新闻工作台隔离验收：临时 HOME/数据库/用户目录，真实 Electron、IPC、受限 MCP；从不调用真实 Agent。
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const work = mkdtempSync(join(tmpdir(), 'dayfolio-news-feed-ui-'));
const stamp = new Date(Date.now() + 8 * 3600000).toISOString().replace(/[:.]/g, '-').slice(0, 23);
const evidence = resolve(repo, '../claude_doc/2026-10-27-Dayfolio新闻设计/验收', `新闻工作台-${stamp}`);
mkdirSync(evidence, { recursive: true });
const dbPath = join(work, 'news-feed.db'); const inspector = join(work, 'inspect.cjs');
writeFileSync(inspector, `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[2],{readOnly:true});console.log(JSON.stringify(db.prepare("SELECT news_id,kind,source,epoch FROM news_feed_feedback WHERE news_id=? AND kind='read'").all(Number(process.argv[3]))));db.close();`);
const readSignals = id => new Promise((resolve, reject) => { const child=spawn(process.execPath,[inspector,dbPath,String(id)],{stdio:['ignore','pipe','pipe']});let output='',error='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>error+=b);child.once('error',reject);child.once('exit',code=>{if(code!==0)reject(new Error('只读检查失败：'+error));else try{resolve(JSON.parse(output));}catch(e){reject(e);}}); });
const home = join(work, 'home'); mkdirSync(home);
const fake = join(work, 'fake-codex');
writeFileSync(fake, `#!${process.execPath}\nawait import(${JSON.stringify(new URL('./fixtures/fake-news-feed-agent.mjs', import.meta.url).href)});\n`); chmodSync(fake, 0o700);
const seed = join(work, 'seed.cjs');
const source = `import {createCore,openNodeSqliteDb} from ${JSON.stringify(join(repo, 'packages/core/src'))};
const dbPath=${JSON.stringify(dbPath)}, c=createCore(openNodeSqliteDb(dbPath),{dbPath});
const cfg=c.newsFeed.getConfig();cfg.schedule.enabled=false;cfg.learning.enabled=true;c.newsFeed.updateConfig({config:cfg,expected_revision:cfg.revision});
c.agentSettings.update({provider:'codex',binary:${JSON.stringify(fake)},model:'',expected_revision:0});
let batch=c.newsFeed.startUpdate();const created={};
while(batch.status==='active') {
 if(!batch.next_task_id){batch=c.newsFeed.advance(batch.id);continue;}
 const claim=c.news.claimTask(batch.next_task_id),ctx=c.newsFeed.getTaskContext(claim.task.id),id=ctx.module_id;
 const prior=created[id]||[];const count=id==='for_you'?Math.min(2,ctx.remaining):Math.min(ctx.remaining,Math.max(0,7-prior.length));
 const candidate=id==='for_you'?{key:'本地开源编程助手',name:'本地开源编程助手',scope:'可在笔记本离线使用的开源编程助手与量化推理工具',reason:ctx.interest_evidence.length?'根据收藏的开源工具报道探索相邻方向':'探索推荐：来自已配置AI模块，尚无长期兴趣证据',basis_news_ids:ctx.interest_evidence.slice(0,2).map(n=>n.news_id),...(ctx.interest_evidence.length?{}:{basis_module_id:ctx.exploration_seed?.basis_module_id||'ai'})}:null;
 const items=Array.from({length:count},(_,i)=>({title:'已保存 '+id+' 独立新闻 '+String(prior.length+i+1).padStart(2,'0'),summary:'本条为隔离验收的独立图文新闻：有关机构发布了具体进展，说明行动、结果和需要关注的事实。阅读这段摘要即可了解测试事件；不代表真实新闻。',source_url:'https://example.com/feed-seed/'+id+'/'+claim.task.id+'/'+i,source_name:'隔离来源 '+id,published_at:new Date(Date.parse(ctx.window_end)-600000-(prior.length+i)*1000).toISOString(),module_id:id,topic_keys:candidate?[candidate.key]:['开源工具'],...(Object.keys(ctx.event_revisions).length?{event_id:Object.keys(ctx.event_revisions)[i%Object.keys(ctx.event_revisions).length]}:{}),image_url:'https://example.com/feed-image-'+(prior.length+i===0?'fail':'ok')+'.png',image_source_url:'https://example.com/feed-seed-image/'+id,image_caption:'隔离测试资料图，非新闻现场',background:'背景：这是临时数据库里的验收资料，用来测试本地摘要的独立阅读。',impact:'分析：测试应确认列表与详情保持一致。',uncertainty:'不确定性：无真实世界新闻主张。',...(candidate?{candidate_topic:candidate}:{})}));
 const rows=items.length?c.news.submitItems(claim.task.id,claim.claim_token,items).items:[];created[id]=[...prior,...rows.map(n=>n.id)];
 if(id==='ai'&&rows.length){c.news.markStarred(rows[0].id,true);c.newsFeed.recordFeedback({news_id:rows[0].id,kind:'star',source:'explicit',idempotency_key:'seed-star-'+rows[0].id});}
 c.news.completeTask(claim.task.id,claim.claim_token,'隔离播种：每正式模块7条，留下真实缺口');batch=c.newsFeed.advance(batch.id);
}
const regular=c.newsFeed.getConfig();const historyConfig=structuredClone(regular);for(const module of historyConfig.modules){module.enabled=module.id==='ai';if(module.id==='ai'){module.window_hours=720;module.headline_count=1;module.max_items=1;}}c.newsFeed.updateConfig({config:historyConfig,expected_revision:regular.revision});
let historicalBatch=c.newsFeed.startUpdate();let historical;
while(historicalBatch.status==='active') {const claim=c.news.claimTask(historicalBatch.next_task_id),ctx=c.newsFeed.getTaskContext(claim.task.id);if(ctx.module_id==='ai'){historical=c.news.submitItems(claim.task.id,claim.claim_token,[{title:'历史独立新闻重要更正',summary:'这是72小时前保存的新版独立新闻，原始摘要保留。',source_url:'https://example.com/history-corrected',source_name:'隔离历史来源',published_at:new Date(Date.now()-72*3600000).toISOString(),module_id:'ai',topic_keys:['开源工具'],background:'新版历史消息的背景'}]).items[0];}c.news.completeTask(claim.task.id,claim.claim_token,'历史新闻播种');historicalBatch=c.newsFeed.advance(historicalBatch.id);}
c.news.markRead(historical.id,true);c.newsFeed.submitCorrection({news_id:historical.id,summary:'重要数字由10修正为12；保存核实依据，不静默改写原文。',evidence_url:'https://example.com/history-correction-evidence'});
c.newsFeed.updateConfig({config:regular,expected_revision:c.newsFeed.getConfig().revision});
console.log(JSON.stringify({created,historical:historical.id,batch:batch.id,profile:c.newsFeed.getInterests()}));c.db.close();`;
await build({ stdin: { contents: source, resolveDir: repo, loader: 'ts' }, outfile: seed, bundle: true, platform: 'node', format: 'cjs', external: ['node:*'] });
await new Promise((resolve, reject) => { const child = spawn(process.execPath, [seed], { stdio: ['ignore', 'pipe', 'pipe'] }); let output = '', error = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => error += b); child.once('error', reject); child.once('exit', code => { writeFileSync(join(evidence, 'seed.json'), output); code === 0 ? resolve() : reject(new Error('播种失败：' + error)); }); });
const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve)); const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
const packaged = process.env.TODODESK_SMOKE_APP; const binary = packaged || join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const app = spawn(binary, [...(packaged ? [] : ['.']), `--remote-debugging-port=${port}`, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'], { cwd: join(repo, 'apps/desktop'), env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: home, TODODESK_DB: dbPath, TODODESK_USER_DATA: join(work, 'user-data'), DAYFOLIO_SKIP_CODEX_SYNC: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
let launchError, logs = ''; app.once('error', e => launchError = e); app.stderr.on('data', b => logs = (logs + b).slice(-12000));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const assertions = []; let ws, send, js; let nextDialog = true; const network = { images: 0, failedImages: 0, originalPages: 0, blocked: 0 }; const requests = new Map();
const diagnostic = process.argv.includes('--diagnose-reading') || process.argv.includes('--keyboard-only');
const diagnosticTrace = []; let diagnosticEvents = [];
// 失败也保留前台与输入证据，避免正文消失时诊断本身再次抛错而丢失现场。
const persistDiagnostic = async () => {
  if (!diagnostic) return;
  if (js) try { diagnosticEvents = await js('window.__newsDiagnosticEvents || []'); } catch {}
  writeFileSync(join(evidence, 'reading-trace.json'), JSON.stringify(diagnosticTrace, null, 2));
  writeFileSync(join(evidence, 'reading-events.json'), JSON.stringify(diagnosticEvents, null, 2));
};
const wait = async (fn, label, timeout = 20000, interval = 150) => { const until = Date.now() + timeout; while (Date.now() < until) { if (launchError) throw launchError; const value = await fn(); if (value) return value; await pause(interval); } throw new Error('等待超时：' + label); };
const assert = async (condition, label) => { const result = typeof condition === 'string' ? await js(condition) : condition; if (!result) throw new Error('断言失败：' + label); assertions.push(label); console.log('通过：' + label); };
const click = async (text, scope = 'button') => { await js(`(() => {const node=[...document.querySelectorAll(${JSON.stringify(scope)})].find(n=>n.textContent.trim()===${JSON.stringify(text)});if(!node)throw new Error('找不到控件：'+${JSON.stringify(text)});node.click();})()`); };
const setValue = async (selector, value) => { await js(`(() => { const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw new Error('找不到输入框');Object.getOwnPropertyDescriptor(node.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:node.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true})); })()`); };
const shot = async name => { if (js) { await js(`document.querySelectorAll('.toast-close').forEach(button=>button.click())`); await pause(80); } const result = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(evidence, name + '.png'), Buffer.from(result.result.data, 'base64')); };
const api = async expression => { const result = await js(expression); if (!result.ok) throw new Error(result.error); return result.data; };
const activateWindow = async () => {
  if(process.platform==='darwin') await new Promise((resolve, reject) => { const child=spawn('/usr/bin/osascript',['-l','JavaScript','-e',`ObjC.import('AppKit');$.NSRunningApplication.runningApplicationWithProcessIdentifier(${app.pid}).activateWithOptions(3);`],{stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',data=>error+=data);child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('无法激活隔离App：'+error))); });
  await send('Page.bringToFront'); await wait(()=>js('document.hasFocus()'),'隔离App原生前台焦点',10000);
};

try {
  const page = await wait(async () => (await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json()).catch(() => [])).find(p => p.type === 'page' && p.url.startsWith('dayfolio-app://app/') && p.title.startsWith('Dayfolio —')), '隔离App窗口');
  ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let sequence = 0; send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { requests.delete(id); reject(new Error('CDP响应超时：' + method)); }, 20000); requests.set(id, value => { clearTimeout(timer); if (value.error) reject(new Error(JSON.stringify(value.error))); else resolve(value); }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  ws.onmessage = async event => { try { const message = JSON.parse(event.data); if (message.id) { requests.get(message.id)?.(message); requests.delete(message.id); return; }
    if (message.method === 'Page.javascriptDialogOpening') { const accept = nextDialog; nextDialog = true; await send('Page.handleJavaScriptDialog', { accept }); }
    if (message.method === 'Target.attachedToTarget') { await send('Fetch.enable', { patterns: [{ urlPattern: 'http*' }] }, message.params.sessionId); await send('Runtime.runIfWaitingForDebugger', {}, message.params.sessionId); }
    if (message.method === 'Fetch.requestPaused') { const { requestId, request } = message.params; const sessionId = message.sessionId; if (request.url.includes('feed-image-fail')) { network.failedImages++; await send('Fetch.failRequest', { requestId, errorReason: 'Failed' }, sessionId); } else if (request.url.includes('feed-image-ok')) { network.images++; await send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/png' }], body: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' }, sessionId); } else if (request.url.startsWith('https://example.com/')) { network.originalPages++; await send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: Buffer.from('<!doctype html><meta charset="utf-8"><h1>隔离原文</h1><p>由CDP返回，不访问真实网站。</p>').toString('base64') }, sessionId); } else { network.blocked++; await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sessionId); } }
  } catch (error) { logs = (logs + '\nCDP子目标诊断：' + String(error)).slice(-12000); } };
  js = async expression => { const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (response.result.exceptionDetails) throw new Error(JSON.stringify(response.result.exceptionDetails)); return response.result.result.value; };
  await send('Page.enable'); await send('Runtime.enable'); await send('Fetch.enable', { patterns: [{ urlPattern: 'http*' }] }); await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  if (diagnostic) await js(`(() => {
    window.__newsDiagnosticEvents = []; window.__newsDiagnosticPhase = 'setup';
    const record = event => {
      const node = event.target instanceof Element ? event.target.closest('button,input,textarea,select,a,[tabindex]') || event.target : null;
      window.__newsDiagnosticEvents.push({ at:Date.now(), type:event.type, trusted:event.isTrusted, key:event.key || null, phase:window.__newsDiagnosticPhase, target:node ? {tag:node.tagName, role:node.getAttribute('role'), label:(node.getAttribute('aria-label') || node.textContent || '').trim().slice(0,100)} : null, focus:document.hasFocus(), visibility:document.visibilityState, detail:!!document.querySelector('.nf-reader-content') });
      if (window.__newsDiagnosticEvents.length > 500) window.__newsDiagnosticEvents.shift();
    };
    for (const type of ['keydown','pointerdown','click','visibilitychange']) document.addEventListener(type, record, true);
    for (const type of ['blur','focus']) window.addEventListener(type, record, true);
  })()`);
  await activateWindow();
  await wait(() => js(`!!document.querySelector('.nav-item')`), '应用导航');
  await js(`[...document.querySelectorAll('.nav-item')].find(n=>n.textContent.includes('新闻')).click()`);
  await wait(() => js(`document.querySelectorAll('.nf-module-group').length===5 && document.querySelectorAll('[aria-label="国内新闻"] .nf-news-row').length===5`), '模块与重点新闻');
  if (diagnostic) {
    const keyboardOnly=process.argv.includes('--keyboard-only');
    if (keyboardOnly) await send('Emulation.setDeviceMetricsOverride', { width: 600, height: 850, deviceScaleFactor: 1, mobile: false });
    await click('国内', '.nf-module-tabs button'); await wait(()=>js(`document.querySelectorAll('.nf-news-row').length===5`),'诊断国内模块');
    const id=(await api('window.tododesk.news.feedList({module_id:"domestic"})'))[0].id;
    await activateWindow(); await js(`window.__newsDiagnosticPhase='script_open';document.querySelector('.nf-story-open').click()`); await wait(()=>js(`!!document.querySelector('.nf-reader-content')`),'诊断阅读正文');
    await js(`window.__readingIntersections=[];window.__readingObserver=new IntersectionObserver(entries=>{window.__readingIntersections.push(...entries.map(entry=>({intersecting:entry.isIntersecting,ratio:entry.intersectionRatio})));});window.__readingObserver.observe(document.querySelector('.nf-reader-content'));`);
    let read=null; let readerDisappeared=false; await js(`window.__newsDiagnosticPhase='reading_observation'`);
    for(let index=0;index<(keyboardOnly?0:45);index++) {
      const state=await js(`(() => { const article=document.querySelector('.nf-reader-content'), rect=article ? article.getBoundingClientRect() : null;return {focus:document.hasFocus(),visibility:document.visibilityState,active:document.activeElement?.tagName,intersection:window.__readingIntersections.at(-1) || null,article:rect ? {x:rect.x,y:rect.y,width:rect.width,height:rect.height,right:rect.right,bottom:rect.bottom} : null,error:document.querySelector('[role="alert"]')?.textContent || null,events:window.__newsDiagnosticEvents.length};})()`);
      const signals=await readSignals(id);diagnosticTrace.push({second:index,...state,signals});await persistDiagnostic();
      if(index%5===0)console.log(JSON.stringify(diagnosticTrace.at(-1)));
      if(signals.some(signal=>signal.source==='app')){read=true;break;}
      if(!state.article){readerDisappeared=true;break;}
      await pause(1000);
    }
    await persistDiagnostic();await shot('diagnostic-detail');
    await js(`window.__newsDiagnosticPhase='script_return'`);if(await js(`!!document.querySelector('.nf-reader-content')`)) await click('返回列表','.news3-back');
    await send('Emulation.setDeviceMetricsOverride', { width: 600, height: 850, deviceScaleFactor: 1, mobile: false });
    await activateWindow();await js(`window.__newsDiagnosticPhase='script_keyboard';document.querySelector('.nf-story-open').focus()`);const focus=await js(`({focused:document.activeElement===document.querySelector('.nf-story-open'),documentFocus:document.hasFocus()})`);console.log(JSON.stringify({keyboardFocus:focus})); await assert(focus.focused&&focus.documentFocus,'原生前台窗口中的新闻标题取得键盘焦点');
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:36,text:'\r',unmodifiedText:'\r'});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:36});await pause(700);const keyboard=await js(`!!document.querySelector('.nf-reader-content')`);await shot('diagnostic-keyboard');
    await assert(keyboard,'原生CDP Enter打开新闻详情，无需脚本点击');
    await assert(`document.documentElement.scrollWidth<=innerWidth && document.querySelector('.nf-reader-content').getBoundingClientRect().right<=innerWidth+1`, '键盘打开的窄窗详情无横向溢出');
    await persistDiagnostic();
    writeFileSync(join(evidence,'result.json'),JSON.stringify({ok:(keyboardOnly||read)&&keyboard,mode:keyboardOnly?'keyboard':'diagnostic',binary,packaged:!!packaged,assertions:assertions.length,passed:assertions,read,keyboard,focus,readerDisappeared,trace:diagnosticTrace,events:diagnosticEvents,evidence,work},null,2));console.log(JSON.stringify({read,keyboard,evidence,work,assertions:assertions.length}));if((!keyboardOnly&&!read)||!keyboard)process.exitCode=1;
  } else {
  await assert(`document.querySelector('.nf-correction-list').textContent.includes('历史独立新闻重要更正')`, '历史已读更正独立于精选可见');
  await assert(`document.querySelectorAll('.nf-module-tabs button').length===7`, '默认模块、猜你喜欢与历史入口齐全');
  await shot('desktop-list');
  await click('国内', '.nf-module-tabs button');
  await wait(() => js(`document.querySelectorAll('.nf-module-group').length===1 && document.querySelectorAll('.nf-news-row').length===5`), '国内模块过滤');
  await click('展开其余 2 则'); await assert(`document.querySelectorAll('.nf-news-row').length===7`, '重点默认五则，展开其余两则');
  await assert(`document.querySelector('.nf-news-row .news3-row-summary').textContent.includes('阅读这段摘要即可了解')`, '列表主要事实独立可读');
  const readingId = (await api('window.tododesk.news.feedList({module_id:"domestic"})'))[0].id; await assert((await readSignals(readingId)).length===0, '进入前没有伪造有效阅读记录');
  await activateWindow();
  const savedTop = await js(`(() => {const list=document.querySelector('.news3-scroll');list.scrollTop=240;return list.scrollTop;})()`);
  await js(`document.querySelector('.nf-story-open').click()`); await wait(() => js(`!!document.querySelector('.nf-reader-content')`), '摘要详情');
  await assert(`!document.querySelector('webview') && !document.querySelector('iframe')`, '详情默认本地摘要，不加载原文');
  await wait(() => js(`!!document.querySelector('.nf-image-fallback')`), '原图失败降级'); await assert(`document.querySelector('.nf-image figcaption').textContent.includes('隔离测试资料图')`, '原图失败仍保留图注与来源');
  await shot('desktop-detail');
  await assert((await api(`window.tododesk.news.feedReadingState({id:${readingId}})`)).visible && await js('document.hasFocus()'), '主进程与页面均确认当前窗口在前台');
  await wait(async () => (await readSignals(readingId)).some(signal=>signal.source==='app'), '静读形成主进程验证的有效阅读', 45000, 1000); await assert((await readSignals(readingId)).length===1, '主动进入后一屏静读可计有效阅读，无需额外点击或滚动');
  await js(`document.querySelector('.nf-source-optional').open=true`); await wait(() => js(`!!document.querySelector('webview')`), '按需原文');
  await assert(`document.querySelector('webview').getAttribute('partition')==='news-source' && document.querySelector('webview').src.startsWith('https://example.com/')`, '原文仅按需加载并使用隔离会话');
  await js(`document.querySelector('.nf-source-optional').open=false`);
  await click('收藏', '.nf-reader-actions button'); await wait(() => js(`document.querySelector('.nf-reader-actions button').textContent.includes('已收藏')`), '收藏保存');
  const starredId = await js(`(async()=>Number((await window.tododesk.news.feedList({module_id:'domestic'})).data.find(n=>n.is_starred).id))()`);
  await click('感兴趣', '.nf-reader-actions button');
  await click('返回列表', '.news3-back'); await wait(() => js(`Math.abs(document.querySelector('.news3-scroll').scrollTop-${savedTop})<2`), '返回滚动位置'); await assert(`document.querySelectorAll('.nf-news-row').length===7`, '返回列表保留模块展开与滚动位置'); await js(`document.querySelector('.nf-story-open').click()`); await wait(() => js(`!!document.querySelector('.nf-reader-content')`), '继续阅读');
  await js(`document.querySelector('.nf-reader-footer details').open=true`); await click('减少这个来源');
  await click('隐藏这则'); await wait(() => js(`!!document.querySelector('[aria-label="新闻列表页"]')`), '隐藏返回');
  await click('已隐藏', '.seg-item'); await wait(() => js(`document.querySelectorAll('.nf-news-row').length===1`), '隐藏筛选'); await click('恢复显示', '.nf-row-actions button');
  await click('全部', '.seg-item'); await wait(() => js(`document.querySelectorAll('.nf-news-row').length===7`), '隐藏撤销');
  await click('配置', '.nf-titlebar button'); await wait(() => js(`!!document.querySelector('[aria-label="新闻模块配置"]')`), '配置页');
  await assert(`document.querySelectorAll('.nf-module-editor').length===4`, '可配置模块来自真实设置');
  await click('恢复来源推荐'); await assert((await api('window.tododesk.news.feedInterests()')).reduced_sources.length === 0, '来源降频可以撤销'); await wait(() => js(`!document.querySelector('.nf-interests fieldset').disabled`), '来源设置提交结束');
  await js(`document.querySelector('.nf-module-editor').open=true;document.querySelector('.nf-module-editor .nf-advanced').open=true`);
  await setValue('[aria-label="模块名称 1"]', '国内要闻草稿');
  await js(`(() => {const labels=[...document.querySelectorAll('.nf-module-editor label')]; const area=labels.find(l=>l.textContent.startsWith('优先来源')).querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(area,${JSON.stringify('新华社\n官方发布')});area.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click('预览动态提示词'); await wait(() => js(`document.querySelector('.nf-preview')?.textContent.includes('草稿预览')`), '草稿提示词预览');
  await assert(`document.querySelector('.nf-preview').textContent.includes('国内要闻草稿') && document.querySelector('.nf-preview').textContent.includes('新华社')`, '动态预览包含模块与来源偏好');
  nextDialog = false; await click('返回新闻', '.news3-back'); await assert(`!!document.querySelector('[aria-label="新闻模块配置"]')`, '取消离开保留配置草稿');
  await api(`(async()=>{const c=(await window.tododesk.news.feedConfig()).data;c.budget_minutes=21;return window.tododesk.news.feedUpdateConfig({config:c,expected_revision:c.revision});})()`);
  await click('保存配置'); await wait(() => js(`document.querySelector('[role="alert"]')?.textContent.includes('其他窗口')`), '修订冲突');
  await assert(`document.querySelector('[aria-label="模块名称 1"]').value==='国内要闻草稿'`, '保存冲突保留用户草稿'); await shot('desktop-config-conflict');
  await click('载入最新配置'); await wait(() => js(`document.querySelector('[aria-label="模块名称 1"]').value==='国内'`), '载入最新配置');
  const beforeEvents = await api('window.tododesk.news.feedInterests()'); await js(`document.querySelector('.nf-event .nf-actions button').click()`); await wait(async () => (await api('window.tododesk.news.feedInterests()')).events[0].status === 'paused', '暂停时事');
  await js(`document.querySelector('.nf-event .nf-actions button').click()`); await wait(async () => (await api('window.tododesk.news.feedInterests()')).events[0].status === 'active', '恢复时事');
  await assert((await api('window.tododesk.news.feedInterests()')).events[0].revision > beforeEvents.events[0].revision, '时事恢复产生新授权版本');
  await shot('desktop-config'); await click('返回新闻', '.news3-back');
  await click('猜你喜欢', '.nf-module-tabs button'); await wait(() => js(`!!document.querySelector('.nf-feed-exploration')`), '真实候选主题');
  await assert(`document.querySelector('.nf-feed-exploration').textContent.includes('本地开源编程助手')`, '真实细分候选与探索理由可见');
  const moduleCount = (await api('window.tododesk.news.feedConfig()')).modules.length;
  await click('加入模块草稿', '.nf-feed-exploration button'); await wait(() => js(`document.querySelectorAll('.nf-module-editor').length===5`), '候选加入模块草稿');
  await assert((await api('window.tododesk.news.feedConfig()')).modules.length === moduleCount, '加入模块草稿尚未修改正式配置');
  await assert(`document.querySelectorAll('.nf-module-editor textarea')[document.querySelectorAll('.nf-module-editor textarea').length-1]!==null`, '新模块草稿可以编辑');
  await click('保存配置'); await wait(async () => (await api('window.tododesk.news.feedConfig()')).modules.length === moduleCount + 1, '保存候选模块');
  const savedConfig = await api('window.tododesk.news.feedConfig()'); await assert(savedConfig.modules.at(-1).scope.includes('离线'), '新增模块保留候选具体检索范围');
  await click('关注主题', '.nf-interests .nf-exploration button'); await wait(async () => (await api('window.tododesk.news.feedInterests()')).topics.some(t => t.key === '本地开源编程助手' && t.state === 'followed'), '候选明确关注');
  await wait(() => js(`!![...document.querySelectorAll('.nf-topic')].find(row=>row.textContent.includes('本地开源编程助手'))`), '明确关注管理行');
  await assert(`![...[...document.querySelectorAll('.nf-topic')].find(row=>row.textContent.includes('本地开源编程助手')).querySelectorAll('button')].some(button=>button.textContent==='移除候选')`, '明确关注行不会用移除候选取消订阅');
  await js(`[...[...document.querySelectorAll('.nf-topic')].find(row=>row.textContent.includes('本地开源编程助手')).querySelectorAll('button')].find(button=>button.textContent==='少推荐').click()`);
  await wait(async () => (await api('window.tododesk.news.feedInterests()')).topics.some(t=>t.key==='本地开源编程助手'&&t.state==='followed'&&t.reduced), '明确关注独立降频');
  await wait(() => js(`!![...[...document.querySelectorAll('.nf-topic')].find(row=>row.textContent.includes('本地开源编程助手')).querySelectorAll('button')].find(button=>button.textContent==='恢复推荐')`), '降频恢复控件');
  await js(`[...[...document.querySelectorAll('.nf-topic')].find(row=>row.textContent.includes('本地开源编程助手')).querySelectorAll('button')].find(button=>button.textContent==='恢复推荐').click()`);
  await wait(async () => (await api('window.tododesk.news.feedInterests()')).topics.some(t=>t.key==='本地开源编程助手'&&t.state==='followed'&&!t.reduced), '恢复推荐保留关注'); await assert((await api('window.tododesk.news.feedInterests()')).topics.some(t=>t.key==='本地开源编程助手'&&t.state==='followed'&&!t.reduced), '少推荐和恢复推荐均保留明确关注');

  await click('返回新闻', '.news3-back'); await click('国内', '.nf-module-tabs button'); await wait(() => js(`!!document.querySelector('[aria-label="国内新闻"]')`), '切回国内'); await js(`([...document.querySelectorAll('button')].find(b=>b.textContent==='收起更多新闻'))?.click()`); await wait(() => js(`document.querySelectorAll('.nf-news-row').length===5`), '切回国内等待更新');
  const stableTitle = await js(`document.querySelector('.nf-story-open').textContent`);
  await wait(async () => (await api('window.tododesk.news.agentStatus()')).available, '隔离假Agent可用');
  const previousBatchId = (await api('window.tododesk.news.feedBatches()'))[0].id;
  await click('更新新闻', '.nf-titlebar button'); await wait(async () => (await api('window.tododesk.news.feedBatches()'))[0].id !== previousBatchId, '按钮建立新更新批次'); await click('采集进度', '.nf-titlebar button');
  await wait(() => js(`document.querySelector('.nf-batch summary strong')?.textContent==='正在更新'`), '当前批次进度'); await shot('desktop-progress');
  const completed = await wait(async () => { const batches = await api('window.tododesk.news.feedBatches()'); const latest = batches[0]; if (latest.id !== previousBatchId && latest.status === 'completed') return latest; const runs = await api('window.tododesk.news.agentRuns()'); if (runs.some(r => r.status === 'failed')) throw new Error('隔离Agent失败：' + JSON.stringify(runs)); return null; }, '真实按钮到MCP所有模块批次完成', 120000);
  await assert(completed.modules.every(m => m.status === 'completed' || m.status === 'skipped'), '各模块通过真实假Agent与受限MCP完成');
  await assert((await api('window.tododesk.news.agentRuns()')).some(r => r.status === 'succeeded'), '后台运行保留真实成功记录');
  await wait(() => js(`document.querySelector('.nf-batch summary strong')?.textContent==='本轮已完成'`), '界面呈现本轮完成状态'); await assert(`document.querySelector('.nf-batch .nf-batch-modules').textContent.includes('检索完成')`, '界面进度同步实际模块完成状态');
  await shot('desktop-progress-complete'); await click('返回新闻', '.news3-back');
  await wait(() => js(`!!document.querySelector('.nf-update-notice')`), '新进展提示'); await assert((await js(`document.querySelector('.nf-story-open').textContent`)) === stableTitle, '后台更新没有打乱现有阅读顺序');
  await click('应用更新'); await wait(() => js(`document.querySelector('.nf-story-open').textContent.includes('新增核实')`), '点击应用新精选');
  await assert(`document.querySelectorAll('.nf-news-row').length===5`, '更新后仍先显示五则重点');
  await click('历史新闻', '.nf-module-tabs button'); await setValue('[aria-label="搜索新闻"]', '历史独立新闻重要更正'); await wait(() => js(`document.querySelectorAll('.nf-news-row').length===1`), '新版历史独立新闻搜索');
  await js(`document.querySelector('.nf-story-open').click()`); await wait(() => js(`document.querySelector('.nf-summary')?.textContent.includes('72小时前')`), '历史本地摘要阅读'); await assert(`document.querySelector('.nf-correction').textContent.includes('修正为12') && !document.querySelector('webview')`, '新版历史消息保存原始摘要及更正依据'); await click('返回列表', '.news3-back'); await setValue('[aria-label="搜索新闻"]', '');
  await click('配置', '.nf-titlebar button'); await wait(() => js(`!!document.querySelector('[aria-label="新闻模块配置"]')`), '学习设置');
  await js(`(() => {const l=[...document.querySelectorAll('label')].find(l=>l.textContent.includes('根据我的阅读与明确反馈'));l.querySelector('input').click();})()`); await click('保存配置'); await wait(async () => !(await api('window.tododesk.news.feedConfig()')).learning.enabled, '关闭学习');
  await js(`const d=[...document.querySelectorAll('.nf-interests details')].find(d=>d.textContent.includes('历史收藏与学习数据'));d.open=true;`); await click('清空学习结果'); await wait(async () => (await api('window.tododesk.news.feedInterests()')).topics.every(t => t.state !== 'inferred'), '清空学习结果');
  await assert((await api('window.tododesk.news.feedList({history:true,filter:"starred",limit:1000})')).some(n => n.id === starredId), '关闭与清空学习保留收藏');
  await assert((await readSignals(readingId)).length===0, '清空学习删除本轮有效阅读证据');
  await send('Emulation.setDeviceMetricsOverride', { width: 600, height: 850, deviceScaleFactor: 1, mobile: false }); await shot('narrow-config'); await assert(`document.documentElement.scrollWidth<=innerWidth`, '窄窗配置无页面横向溢出');
  await click('返回新闻', '.news3-back'); await click('国内', '.nf-module-tabs button'); await wait(() => js(`document.querySelectorAll('.nf-news-row').length===5`), '窄窗列表'); await shot('narrow-list'); await assert(`document.documentElement.scrollWidth<=innerWidth && document.querySelector('.news3-list').getBoundingClientRect().right<=innerWidth+1`, '窄窗列表无横向溢出');
  await activateWindow(); await js(`document.querySelector('.nf-story-open').focus()`); await assert(`document.activeElement===document.querySelector('.nf-story-open')`, '新闻标题可获得键盘焦点'); await send('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:36,text:'\r',unmodifiedText:'\r'}); await send('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:36}); await wait(() => js(`!!document.querySelector('.nf-reader-content')`), '键盘打开新闻'); await assert(`document.documentElement.scrollWidth<=innerWidth`, '键盘可打开新闻且窄窗详情无溢出'); await shot('narrow-detail');
  await assert(network.images > 0 && network.failedImages > 0, '原图成功与失败均由CDP隔离处理');
  writeFileSync(join(evidence, 'result.json'), JSON.stringify({ ok: true, assertions: assertions.length, passed: assertions, evidence, work, network, completed, mode: 'isolated-fixture' }, null, 2));
  console.log(JSON.stringify({ ok: true, assertions: assertions.length, evidence, work, network }));
  }
} catch (error) {
  await persistDiagnostic();
  if (send) try { await shot('failure'); } catch {}
  const report = { ok: false, assertions: assertions.length, passed: assertions, error: error.stack || String(error), binary, packaged:!!packaged, trace:diagnosticTrace,events:diagnosticEvents,evidence, work, network, logs };
  writeFileSync(join(evidence, 'result.json'), JSON.stringify(report, null, 2)); console.error(JSON.stringify(report, null, 2)); process.exitCode = 1;
} finally { ws?.close(); app.kill('SIGTERM'); await Promise.race([new Promise(resolve => app.once('exit', resolve)), pause(8000)]); app.kill('SIGKILL'); }
