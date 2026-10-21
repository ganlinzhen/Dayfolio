// 点击真实 App 按钮验证后台采集。默认模拟推理；--live 时使用真实 Codex 与账户额度。
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const repo = resolve(new URL('../../../', import.meta.url).pathname);
const work = mkdtempSync(join(tmpdir(), 'dayfolio-news-agent-ui-'));
const dbPath = join(work, 'test.db');
const live = process.argv.includes('--live');
const seed = join(work, 'seed.cjs');
await build({ stdin: { contents: `import {createCore,openNodeSqliteDb} from ${JSON.stringify(join(repo,'packages/core/src'))};const dbPath=${JSON.stringify(dbPath)};const c=createCore(openNodeSqliteDb(dbPath),{dbPath});c.news.updateCollectionSettings({prompt:'收集最近24小时内的一条国际新闻、一条国内新闻和一份含1到2则消息的AI专题简报；各条打开原始来源核实真实发布时间。国际国内独立入库，AI用brief。不足时如实说明，不编造。',max_items:3,window_hours:24,expected_revision:0});c.db.close();`, resolveDir: repo, loader: 'ts' }, outfile: seed, bundle: true, platform: 'node', format: 'cjs', external: ['node:*'] });
await new Promise((resolve, reject) => { const child = spawn(process.execPath, [seed], { stdio: 'inherit' }); child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('播种失败'))); });
mkdirSync(join(work, 'home'));
const fake = join(work, 'fake-codex');
writeFileSync(fake, `#!${process.execPath}\nawait import(${JSON.stringify(new URL('../test/fixtures/fake-news-agent.mjs', import.meta.url).href)});\n`); chmodSync(fake, 0o700);
const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port; await new Promise(resolve => server.close(resolve));
const packaged = process.env.TODODESK_SMOKE_APP;
const binary = packaged || join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const app = spawn(binary, [...(packaged ? [] : ['.']), `--remote-debugging-port=${port}`], {
  cwd: join(repo, 'apps/desktop'), env: {
    PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: join(work,'home'),
    TODODESK_DB: dbPath, TODODESK_USER_DATA: join(work,'user-data'),
    ...(live ? { CODEX_HOME: process.env.CODEX_HOME || join(homedir(), '.codex'), ...(process.env.DAYFOLIO_CODEX_BIN ? { DAYFOLIO_CODEX_BIN: process.env.DAYFOLIO_CODEX_BIN } : {}), ...(process.env.DAYFOLIO_CODEX_MODEL ? { DAYFOLIO_CODEX_MODEL: process.env.DAYFOLIO_CODEX_MODEL } : {}) } : { DAYFOLIO_CODEX_BIN: fake }),
  }, stdio: ['ignore','ignore','pipe'],
});
let launchError; app.once('error', e => { launchError = e; });
let logs = ''; app.stderr.on('data', b => { logs = (logs + b.toString()).slice(-5000); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (fn, timeout = 20000) => { const until = Date.now()+timeout; while(Date.now()<until) { if(launchError)throw launchError; const v=await fn(); if(v)return v; await pause(250); } throw new Error('等待界面状态超时'); };
let ws;
try {
  const page = await wait(async () => (await fetch(`http://127.0.0.1:${port}/json`).then(r=>r.json()).catch(()=>[])).find(p => p.type==='page' && p.url.startsWith('dayfolio-app://app/') && p.title.startsWith('Dayfolio —')));
  ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
  let id=0;const pending=new Map();
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}};
  const send=(method,params={})=>new Promise((resolve,reject)=>{const current=++id;const timer=setTimeout(()=>{pending.delete(current);reject(new Error('CDP 响应超时：'+method));},15000);pending.set(current,value=>{clearTimeout(timer);resolve(value);});ws.send(JSON.stringify({id:current,method,params}));});
  const js=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.result?.exceptionDetails)throw new Error(JSON.stringify(r.result.exceptionDetails));return r.result?.result?.value;};
  await send('Page.enable'); await send('Runtime.enable');
  console.log('已连接隔离 App，等待导航');
  await wait(()=>js(`!!document.querySelector('.nav-item')`));
  await js(`[...document.querySelectorAll('.nav-item')].find(b=>b.textContent.trim()==='设置').click()`);
  await wait(()=>js(`!!document.querySelector('[aria-label="设置菜单"]') && !!document.querySelector('input[value=codex]')`));
  if(!await js(`[...document.querySelectorAll('.agent-provider-toggle')].every(b=>b.getAttribute('aria-expanded')==='false')`))throw new Error('Agent 初始应全部收起');
  const collapsedShot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(join(work,'settings-collapsed.png'),Buffer.from(collapsedShot.result.data,'base64'));
  const initial=await js(`window.tododesk.agentSettings.get()`);
  if(initial.data.provider!==null)throw new Error('空库不应自动启用 Agent');
  await js(`document.querySelector('input[value=codex]').click()`);
  const cli = live ? process.env.DAYFOLIO_CODEX_BIN || '' : fake;
  await js(`(() => {const i=document.querySelector('#agent-binary');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(cli)});i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  if(!await js(`document.querySelector('#agent-profile-codex').contains(document.querySelector('#agent-binary')) && document.querySelector('#agent-profile-codex').contains([...document.querySelectorAll('button')].find(b=>b.textContent==='复制给ai'))`))throw new Error('配置与复制给ai必须位于 Codex 条目内');
  await js(`document.querySelector('[aria-label="Codex 配置"]').click()`);
  if(!await js(`document.querySelector('[aria-label="Codex 配置"]').getAttribute('aria-expanded')==='false' && !document.querySelector('#agent-binary')`))throw new Error('点击 Codex 应收起配置');
  await js(`document.querySelector('[aria-label="Codex 配置"]').click()`);
  if(!await js(`document.querySelector('#agent-binary').value===${JSON.stringify(cli)}`))throw new Error('收起展开不能丢失当前输入');
  if(!await js(`(() => {const card=document.querySelector('.agent-provider-list'), rows=[...document.querySelectorAll('#agent-profile-codex .agent-setting-row')];return getComputedStyle(card).borderRadius==='12px' && rows.length===4 && rows.every(row=>row.firstElementChild.getBoundingClientRect().right<=row.children[1].getBoundingClientRect().left);})()`))throw new Error('设置应使用分组卡片和左右行式布局');
  await send('Emulation.setDeviceMetricsOverride',{width:600,height:800,deviceScaleFactor:1,mobile:false});
  if(!await js(`document.querySelector('.agent-provider-list').getBoundingClientRect().right<=innerWidth && document.documentElement.scrollWidth<=innerWidth`))throw new Error('窄窗口设置卡片不能横向溢出');
  const narrowShot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(join(work,'settings-narrow.png'),Buffer.from(narrowShot.result.data,'base64'));
  await send('Emulation.clearDeviceMetricsOverride');
  await js(`[...document.querySelectorAll('button')].find(b=>b.textContent==='检查连接').click()`);
  await wait(()=>js(`!!document.querySelector('.agent-connection-result.ready')`),45000);
  const settingsShot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(join(work,'settings.png'),Buffer.from(settingsShot.result.data,'base64'));
  await js(`[...document.querySelectorAll('button')].find(b=>b.textContent==='保存配置').click()`);
  await wait(async()=>{const v=await js(`window.tododesk.agentSettings.get()`);return v.ok&&v.data.provider==='codex'&&v.data.profiles.codex.binary===cli;});
  await js(`[...document.querySelectorAll('.nav-item')].find(b=>b.textContent.includes('新闻')).click()`);
  await wait(()=>js(`!![...document.querySelectorAll('button')].find(b=>b.textContent==='更新今日新闻')`));
  await wait(async()=>{const v=await js(`window.tododesk.news.agentStatus()`);return v.ok&&v.data.available;});
  await js(`[...document.querySelectorAll('button')].find(b=>b.textContent==='更新今日新闻').click()`);
  await wait(()=>js(`!!document.querySelector('[aria-label="新闻后台执行"]')`));
  console.log('已点击更新，等待真实业务完成');
  const result = await wait(async()=>{
    const snapshot=await js(`({text:document.querySelector('[aria-label="新闻后台执行"]')?.textContent,runs:[...document.querySelectorAll('[data-run-status]')].map(r=>r.dataset.runStatus)})`);
    if(snapshot.runs.some(s=>['failed','interrupted'].includes(s)))throw new Error(snapshot.text);
    return snapshot.runs.includes('succeeded') ? snapshot : null;
  },live?13*60000:30000);
  console.log(JSON.stringify({mode:live?'真实Codex':'隔离模拟推理',work,result}));
  const statusShot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(join(work,'agent-status.png'),Buffer.from(statusShot.result.data,'base64'));
  const data=await js(`Promise.all([window.tododesk.news.tasks(),window.tododesk.news.list(),window.tododesk.news.agentRuns()])`);
  if(!data.every(r=>r.ok)||!data[1].data.length||data[0].data[0].status!=='completed')throw new Error('业务完成或新闻回读失败');
  await js(`[...document.querySelectorAll('.news3-request-actions button')].find(b=>b.textContent.includes('查看')).click()`);
  await wait(()=>js(`document.querySelectorAll('.news3-row').length>0`));
  const screenshot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(join(work,'news-list.png'),Buffer.from(screenshot.result.data,'base64'));
  writeFileSync(join(work,'result.json'),JSON.stringify({mode:live?'live':'fixture',data},null,2));
  console.log(`按钮 → 后台进程 → MCP → 业务完成 → 自动刷新及查看结果全部通过；证据：${work}`);
} catch(e) { console.error(e);console.error(logs);process.exitCode=1; }
finally { ws?.close();app.kill('SIGTERM');await Promise.race([new Promise(resolve=>app.once('exit',resolve)),pause(8000)]);app.kill('SIGKILL'); }
