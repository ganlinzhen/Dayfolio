#!/usr/bin/env node
// 隔离验收学习计划进度的视觉比例、布局动画和减少动态效果。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const work = mkdtempSync(join(tmpdir(), 'dayfolio-progress-'));
const dbPath = join(work, 'demo.db'), home = join(work, 'home'), userData = join(work, 'user-data');
const stamp = new Date(Date.now() + 8 * 3600000).toISOString().replace(/[:.]/g, '-').slice(0, 23);
const baseline = process.env.TODODESK_PROGRESS_BASELINE === '1';
const evidence = resolve(repo, '../claude_doc/dayfolio-progress-transform-20261028', `${stamp}-${baseline ? 'baseline' : 'candidate'}`);
if (!resolve(work).startsWith(resolve(tmpdir()) + '/') || resolve(work) === resolve(homedir()) || dbPath.includes('Application Support')) throw new Error('临时数据隔离检查失败');
mkdirSync(home); mkdirSync(userData); mkdirSync(evidence, { recursive: true });
const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: home, TODODESK_DB: dbPath, TODODESK_USER_DATA: userData, DAYFOLIO_SKIP_CODEX_SYNC: '1' };
const packaged = process.env.TODODESK_SMOKE_APP;
if (packaged && (!isAbsolute(packaged) || !packaged.endsWith('.app/Contents/MacOS/Dayfolio'))) throw new Error('候选 App 路径无效');
const executable = packaged || join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
if (!existsSync(executable)) throw new Error('未找到 Electron 可执行文件');
let app, ws, send, evaluate, launchError, stderr = '';
const passed = [], observations = [];
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const until = async (fn, label, timeout = 25000) => {
  const end = Date.now() + timeout; let lastError;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (error) { lastError = error; }
    if (launchError) throw launchError;
    if (app?.exitCode !== null && app?.exitCode !== undefined) throw new Error(`隔离 App 提前退出：${app.exitCode}\n${stderr}`);
    await delay(150);
  }
  throw new Error(`等待超时：${label}${lastError ? '；' + String(lastError) : ''}\n${stderr}`);
};
const assert = (condition, label, detail) => {
  if (!condition) throw new Error(`断言失败：${label}；${JSON.stringify(detail)}`);
  passed.push(label); console.log('通过：' + label);
};
const runNode = (file, args) => new Promise((resolveNode, reject) => {
  const child = spawn(process.execPath, [file, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '', errors = '';
  child.stdout.on('data', data => output += data); child.stderr.on('data', data => errors += data);
  child.once('error', reject); child.once('exit', code => code === 0 ? resolveNode(output) : reject(new Error('隔离播种失败：' + errors)));
});
const freePort = () => new Promise((resolvePort, reject) => {
  const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolvePort(port)); });
});

try {
  const seed = join(work, 'demo-seed.cjs');
  await build({ entryPoints: [join(repo, 'apps/desktop/scripts/demo-seed.ts')], outfile: seed, bundle: true, platform: 'node', format: 'cjs', external: ['node:*'], logLevel: 'silent' });
  await runNode(seed, [dbPath, work, join(repo, 'apps/onboarding')]);
  const planSeed = join(work, 'progress-seed.cjs');
  await build({ stdin: { contents: `import { createCore, openNodeSqliteDb } from ${JSON.stringify(join(repo, 'packages/core/src'))};
    const dbPath=process.argv[2]; const c=createCore(openNodeSqliteDb(dbPath),{dbPath});
    const date=new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});
    function make(pct,done) { const p=c.plans.create({title:'进度验收 '+pct+'%',start_date:date,create_todos:false,items:[1,2,3,4].map(i=>({date,content:'隔离进度 '+pct+' '+i}))}); for(const item of p.items.slice(0,done)) c.plans.updateItemStatus(item.id,'done'); return {id:p.id,items:p.items.map(i=>i.id),title:p.title}; }
    console.log(JSON.stringify({zero:make(0,0),quarter:make(25,1),full:make(100,4)})); c.db.close();`, resolveDir: repo, sourcefile: 'progress-seed.ts' }, outfile: planSeed, bundle: true, platform: 'node', format: 'cjs', external: ['node:*'], logLevel: 'silent' });
  const plans = JSON.parse((await runNode(planSeed, [dbPath])).trim().split('\n').at(-1));
  const port = await freePort();
  app = spawn(executable, [...(packaged ? [] : ['.']), `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'], { cwd: join(repo, 'apps/desktop'), env, stdio: ['ignore', 'ignore', 'pipe'] });
  app.once('error', error => { launchError = error; });
  app.stderr.on('data', data => stderr = (stderr + data).slice(-6000));
  const page = await until(async () => (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) }).then(response => response.json()).catch(() => [])).find(target => target.type === 'page' && target.url === 'dayfolio-app://app/index.html'), '主窗口');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolveSocket, reject) => { ws.onopen = resolveSocket; ws.onerror = reject; });
  let sequence = 0; const pending = new Map();
  send = (method, params = {}, sessionId) => new Promise((resolveSend, reject) => {
    const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP 超时：' + method)); }, 15000);
    pending.set(id, message => { clearTimeout(timer); pending.delete(id); message.error ? reject(new Error(JSON.stringify(message.error))) : resolveSend(message.result); });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) { pending.get(message.id)?.(message); return; }
    if (message.method === 'Target.attachedToTarget') void send('Network.enable', {}, message.params.sessionId).then(() => send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] }, message.params.sessionId)).catch(() => {});
  };
  evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error('页面执行失败：' + JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('Performance.enable');
  await send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await until(() => evaluate('!!window.tododesk && !!document.querySelector(".nav-item")'), '界面与隔离 IPC');
  await until(() => evaluate(`(() => {const b=[...document.querySelectorAll('.nav-item')].find(x=>x.textContent.trim()==='学习');if(!b)return false;b.click();return true})()`), '学习入口');
  const listRoot = title => `[...document.querySelectorAll('.learning-plan-card')].find(x=>x.querySelector('.plan-title')?.textContent.trim()===${JSON.stringify(title)})`;
  await until(() => evaluate(`!!(${listRoot(plans.zero.title)}) && !!(${listRoot(plans.quarter.title)}) && !!(${listRoot(plans.full.title)})`), '真实计划列表');
  const shot = async name => {
    await evaluate(`(async()=>{await Promise.all(document.getAnimations().filter(a=>a.playState==='running'&&Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a=>a.finished.catch(()=>{})));await new Promise(requestAnimationFrame)})()`);
    const image = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(evidence, name + '.png'), Buffer.from(image.data, 'base64'));
  };
  const inspect = async (root, expected, kind) => evaluate(`(() => {
    const root=${root},bar=root.querySelector('[role=progressbar]'),fill=bar.firstElementChild,s=getComputedStyle(fill),t=getComputedStyle(bar),r=bar.getBoundingClientRect(),f=fill.getBoundingClientRect();
    return {expected:${expected},kind:${JSON.stringify(kind)},aria:Number(bar.getAttribute('aria-valuenow')),text:root.querySelector(${JSON.stringify(kind === '列表' ? '.learning-plan-completion > span:last-child' : '.plan-detail-progress > span:last-child')}).textContent.trim(),track:r.width,layout:fill.offsetWidth,client:bar.clientWidth,visible:f.width,left:f.left-r.left,height:r.height,fillColor:s.backgroundColor,trackColor:t.backgroundColor,radius:t.borderRadius,origin:s.transformOrigin,property:s.transitionProperty,duration:s.transitionDuration,timing:s.transitionTimingFunction,rootEase:getComputedStyle(document.documentElement).getPropertyValue('--ease-out').trim()};
  })()`);
  const verify = async (root, percent, kind, label) => {
    const m = await inspect(root, percent, kind); observations.push({ label, ...m });
    const visual = m.aria === percent && m.text === `${percent}%` && m.track > 0 && Math.abs(m.visible - m.track * percent / 100) < 1.5 && Math.abs(m.left) < 1.5 && Math.abs(m.height - (kind === '列表' ? 3 : 4)) < 0.2 && m.fillColor === 'rgb(26, 26, 25)' && m.trackColor === 'rgb(232, 231, 227)' && m.radius === '2px';
    const bezier = value => /^cubic-bezier\(\s*([^)]*)\s*\)$/.exec(value)?.[1].split(',').map(x => Number(x.trim()));
    const actualEase = bezier(m.timing), expectedEase = bezier(m.rootEase);
    const sameEase = actualEase?.length === 4 && expectedEase?.length === 4 && actualEase.every((value, i) => Number.isFinite(value) && value === expectedEase[i]);
    const transform = baseline || (Math.abs(m.layout - m.client) <= 1 && Math.abs(parseFloat(m.origin)) < 0.1 && m.property === 'transform' && m.duration === '0.25s' && sameEase);
    assert(visual && transform, label + '真实百分比、外观' + (baseline ? '' : '及 transform 样式'), m);
  };
  const openPlan = async plan => {
    await evaluate(`(${listRoot(plan.title)}).scrollIntoView({block:'center'});(${listRoot(plan.title)}).click()`);
    await until(() => evaluate(`document.querySelector('.plan-detail-overview h1')?.textContent.trim()===${JSON.stringify(plan.title)}`), '计划详情 ' + plan.title);
  };
  const back = async () => { await evaluate("document.querySelector('.plan-detail > .backlink').click()"); await until(() => evaluate(`!!(${listRoot(plans.zero.title)})`), '返回计划列表'); };
  const samples = [[plans.zero, 0], [plans.quarter, 25], [plans.full, 100]];
  for (const size of [{ name: '宽窗', width: 1280 }, { name: '窄窗', width: 600 }]) {
    await send('Emulation.setDeviceMetricsOverride', { width: size.width, height: 900, deviceScaleFactor: 1, mobile: false });
    for (const [plan, percent] of samples) {
      await verify(`(${listRoot(plan.title)})`, percent, '列表', `${size.name}列表 ${percent}%`);
      await openPlan(plan); await verify('document.querySelector(\'.plan-detail\')', percent, '详情', `${size.name}详情 ${percent}%`);
      if (percent === 25) await shot(`${size.name}-详情-25`);
      await back();
    }
    await evaluate(`(${listRoot(plans.quarter.title)}).scrollIntoView({block:'center'})`); await shot(`${size.name}-列表-25`);
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await openPlan(plans.zero); await send('Page.bringToFront');
  await verify("document.querySelector('.plan-detail')", 0, '详情', '动态更新前详情 0%');
  await evaluate(`(async()=>{const bar=document.querySelector('.plan-detail-progress [role=progressbar]'),fill=bar.firstElementChild;if(!bar.isConnected||!fill.isConnected||bar.getAttribute('aria-valuenow')!=='0')throw Error('初始进度节点无效');getComputedStyle(fill).transform;fill.getBoundingClientRect();await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame)})()`);
  const metric = async () => (await send('Performance.getMetrics')).metrics.find(x => x.name === 'LayoutCount')?.value ?? 0;
  const before = await metric();
  const frames = await evaluate(`(async()=>{
    const bar=document.querySelector('.plan-detail-progress [role=progressbar]'),fill=bar.firstElementChild;
    const changed=new Promise((resolve,reject)=>{const observer=new MutationObserver(()=>{if(bar.getAttribute('aria-valuenow')==='25'){observer.disconnect();resolve()}});observer.observe(bar,{attributes:true,attributeFilter:['aria-valuenow']});setTimeout(()=>{observer.disconnect();reject(Error('进度刷新超时'))},5000)});
    const result=await window.tododesk.plans.updateItemStatus({id:${plans.zero.items[0]},status:'done'});if(!result.ok)throw Error(JSON.stringify(result));
    window.dispatchEvent(new Event('focus'));await changed;
    const frames=[],start=performance.now();await new Promise(resolve=>{function frame(){const css=getComputedStyle(fill);frames.push({elapsed:performance.now()-start,scale:new DOMMatrixReadOnly(css.transform).a,layout:fill.offsetWidth,track:bar.clientWidth,visible:fill.getBoundingClientRect().width,connected:bar.isConnected&&fill.isConnected&&bar.firstElementChild===fill});if(performance.now()-start<350)requestAnimationFrame(frame);else resolve()}requestAnimationFrame(frame)});return frames;
  })()`);
  const after = await metric(); observations.push({ label: '动态进度采样', layoutCountBefore: before, layoutCountAfter: after, layoutCountDelta: after - before, frames });
  assert(frames.length > 1 && frames.every(f => f.connected) && frames.some(f => f.visible > 0 && f.visible < f.track * 0.25 - 0.5), '真实进度更新在稳定节点上具有逐帧视觉过渡', frames);
  if (!baseline) assert(frames.every(f => Math.abs(f.layout - f.track) <= 1) && frames.some(f => f.scale > 0.005 && f.scale < 0.245), '动态过渡保持布局宽度且 transform 逐步变化', frames);
  await verify("document.querySelector('.plan-detail')", 25, '详情', '动态更新后详情 25%');
  await shot('动态更新后-详情-25');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await evaluate(`(async()=>{const result=await window.tododesk.plans.updateItemStatus({id:${plans.zero.items[0]},status:'pending'});if(!result.ok)throw Error(JSON.stringify(result));window.dispatchEvent(new Event('focus'))})()`);
  await until(() => evaluate("document.querySelector('.plan-detail-progress [role=progressbar]')?.getAttribute('aria-valuenow')==='0'"), '减少动态效果下真实进度更新');
  await evaluate('(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame)})()');
  const reduced = await evaluate(`(()=>{const fill=document.querySelector('.plan-detail-progress [role=progressbar] > div'),s=getComputedStyle(fill);return {duration:s.transitionDuration,property:s.transitionProperty,visible:fill.getBoundingClientRect().width,animations:fill.getAnimations().filter(a=>a.playState==='running').length}})()`);
  assert(parseFloat(reduced.duration) <= 0.00001 && reduced.visible < 1 && reduced.animations === 0, '减少动态效果时真实进度更新即时完成', reduced);
  writeFileSync(join(evidence, 'report.json'), JSON.stringify({ baseline, executable, passed, observations }, null, 2));
  console.log(`验收完成：${passed.length} 项，报告：${evidence}`);
} catch (error) {
  writeFileSync(join(evidence, 'report.json'), JSON.stringify({ baseline, executable, passed, observations, error: String(error), stderr }, null, 2));
  console.error(error); process.exitCode = 1;
} finally {
  ws?.close();
  if (app && app.exitCode === null) { app.kill('SIGTERM'); await Promise.race([new Promise(resolveExit => app.once('exit', resolveExit)), delay(3000)]); if (app.exitCode === null) app.kill('SIGKILL'); }
  rmSync(work, { recursive: true, force: true });
}
