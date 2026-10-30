#!/usr/bin/env node
// 全局操作按钮隔离验收：共享演示数据、真实 Electron/IPC、宽窄窗口及可撤销操作。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const work = mkdtempSync(join(tmpdir(), 'dayfolio-global-actions-'));
const dbPath = join(work, 'demo.db');
const home = join(work, 'home');
const userData = join(work, 'user-data');
const stamp = new Date(Date.now() + 8 * 3600000).toISOString().replace(/[:.]/g, '-').slice(0, 23);
const evidence = resolve(repo, '../claude_doc/dayfolio-global-actions-20261028', stamp);
if (!resolve(work).startsWith(resolve(tmpdir()) + '/') || resolve(work) === resolve(homedir()) || resolve(dbPath).includes('Application Support')) throw new Error('临时数据隔离检查失败');
mkdirSync(home); mkdirSync(userData); mkdirSync(evidence, { recursive: true });
const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: home, TODODESK_DB: dbPath, TODODESK_USER_DATA: userData, DAYFOLIO_SKIP_CODEX_SYNC: '1' };
const packaged = process.env.TODODESK_SMOKE_APP;
if (packaged && (!isAbsolute(packaged) || !packaged.endsWith('.app/Contents/MacOS/Dayfolio'))) throw new Error('候选 App 路径无效');
const executable = packaged || join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
if (!existsSync(executable)) throw new Error('未找到 Electron 可执行文件');
let app, ws, send, evaluate, launchError, stderr = '', passed = [];
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
  if (!condition) throw new Error(`断言失败：${label}${detail ? '；' + JSON.stringify(detail) : ''}`);
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
    if (message.method === 'Page.javascriptDialogOpening') void send('Page.handleJavaScriptDialog', { accept: true });
    if (message.method === 'Target.attachedToTarget') void send('Network.enable', {}, message.params.sessionId).then(() => send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] }, message.params.sessionId)).catch(() => {});
  };
  evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error('页面执行失败：' + JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await until(() => evaluate('!!window.tododesk && !!document.querySelector(".nav-item")'), '界面与隔离 IPC');
  const clickText = async (text, scope = 'document') => {
    const expression = `(() => { const root=${scope};const b=[...root.querySelectorAll('button')].find(el=>el.textContent.trim()===${JSON.stringify(text)} && !el.disabled && el.getClientRects().length);if(!b)return false;b.click();return true;})()`;
    await until(() => evaluate(expression), '点击操作：' + text);
  };
  const setValue = async (selector, value) => evaluate(`(() => { const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw new Error('找不到字段');node.focus();const proto=node instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const invoke = async expression => { const result = await evaluate(expression); if (!result?.ok) throw new Error(result?.error || '隔离业务调用失败'); return result.data; };
  const nav = async label => {
    await until(() => evaluate(`(() => { const b=[...document.querySelectorAll('.nav-item')].find(el=>el.textContent.trim()===${JSON.stringify(label)} || (${JSON.stringify(label)}==='帮助' && el.textContent.trim().startsWith('帮助')));if(!b)return false;b.click();return true;})()`), '侧边栏：' + label);
    await until(() => evaluate(`([...document.querySelectorAll('.nav-item.active')].some(el=>el.textContent.trim()===${JSON.stringify(label)} || (${JSON.stringify(label)}==='帮助' && el.textContent.trim().startsWith('帮助'))))`), '已选面板：' + label);
    if (label !== '帮助') await until(() => evaluate(`!![...document.querySelectorAll('button.action-button')].find(b=>b.getClientRects().length && getComputedStyle(b).visibility !== 'hidden')`), '操作渲染：' + label);
  };
  const inspectActions = async label => {
    const result = await evaluate(`(() => {
      const isVisible = node => { const r=node.getBoundingClientRect();if(!r.width||!r.height||r.right<=0||r.left>=innerWidth||r.bottom<=0||r.top>=innerHeight)return false;for(let p=node;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)return false;}return true; };
      const buttons=[...document.querySelectorAll('button.action-button')].filter(isVisible), bad=[];
      for (const b of buttons) {const svgs=b.querySelectorAll('svg'),icon=svgs[0],copy=b.querySelector(':scope > .action-button-label'),ir=icon?.getBoundingClientRect(),tr=copy?.getBoundingClientRect();const value={text:copy?.textContent.trim(),svgs:svgs.length,hidden:icon?.getAttribute('aria-hidden'),iconWidth:ir?.width,iconHeight:ir?.height,textWidth:tr?.width,textHeight:tr?.height,delta:ir&&tr?Math.abs((ir.top+ir.height/2)-(tr.top+tr.height/2)):null};if(value.svgs!==1||!value.text||value.hidden!=='true'||!value.iconWidth||!value.iconHeight||!value.textWidth||!value.textHeight||value.delta>2.5)bad.push(value);}
      return {count:buttons.length,bad,scroll:document.documentElement.scrollWidth,viewport:innerWidth};
    })()`);
    assert(result.count > 0 || label.endsWith('帮助'), label + '可见操作已渲染', result);
    assert(result.bad.length === 0, label + '操作均为对齐的单图标与文字', result.bad);
    assert(result.scroll <= result.viewport, label + '页面没有横向溢出', result);
  };
  const shot = async name => {
    const settled = await send('Runtime.evaluate', { expression: `(async () => {
      const animations = document.getAnimations().filter(animation => animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime));
      await Promise.all(animations.map(animation => animation.finished.catch(() => {})));
      await new Promise(requestAnimationFrame);
    })()`, awaitPromise: true });
    if (settled.exceptionDetails) throw new Error('截图前等待动画失败：' + JSON.stringify(settled.exceptionDetails));
    const image = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(evidence, name + '.png'), Buffer.from(image.data, 'base64'));
  };
  const surfaces = ['今日', '待办', '新闻', '学习', '知识库', '自媒体', '工具箱', '设置', '数据', 'MCP', '帮助'];
  for (const size of [{ name: '宽窗', width: 1280, height: 900 }, { name: '窄窗', width: 600, height: 900 }]) {
    await send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
    for (const label of surfaces) {
      await nav(label);
      if (size.width === 600 && label === '新闻') {
        const reachable = await evaluate(`(() => {
          const bar = document.querySelector('.nf-daily-toolbar');
          const buttons = [...bar.querySelectorAll('.nf-actions button.action-button')];
          const initial = bar.scrollLeft;
          const results = buttons.map(button => {
            button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            const rect = button.getBoundingClientRect(), frame = bar.getBoundingClientRect();
            return { text: button.textContent.trim(), left: rect.left, right: rect.right,
              reachable: rect.width > 0 && rect.left >= Math.max(0, frame.left) - 1 && rect.right <= Math.min(innerWidth, frame.right) + 1 };
          });
          return { initial, final: bar.scrollLeft, overflow: bar.scrollWidth > bar.clientWidth, results };
        })()`);
        assert(reachable.overflow && reachable.final > reachable.initial && reachable.results.length === 3 && reachable.results.every(item => item.reachable), '窄窗新闻工具栏横向滚动后每个操作均可完整访问', reachable);
      }
      await inspectActions(`${size.name}${label}`); await shot(`${size.name}-${label}`);
    }
  }

  await send('Emulation.setDeviceMetricsOverride', { width: 600, height: 900, deviceScaleFactor: 1, mobile: false });
  await nav('待办');
  assert(await evaluate(`(() => { const b=document.querySelector('.todo-composer-v2 button[type="submit"]');return !!b&&b.disabled&&b.type==='submit'&&b.querySelectorAll('svg').length===1; })()`), '空待办提交禁用且保留显式 submit 类型');
  await setValue('.composer-input', '全局操作隔离待办');
  await until(() => evaluate('!!document.querySelector(".todo-composer-details")'), '新增待办详情');
  await clickText('暂不安排', 'document.querySelector(".todo-composer-v2")');
  await clickText('添加待办', 'document.querySelector(".todo-composer-v2")');
  await until(() => evaluate(`[...document.querySelectorAll('.todo-card')].some(row=>row.textContent.includes('全局操作隔离待办'))`), '待办表单提交');
  const listTodos = () => invoke('window.tododesk.todos.list({status:"all"})');
  assert((await listTodos()).some(item => item.title === '全局操作隔离待办'), '显式 submit 真实创建隔离待办');
  await setValue('[aria-label="搜索待办"]', '全局操作隔离');
  await until(() => evaluate('!!document.querySelector("[aria-label=清除搜索]")'), '清除搜索操作');
  await inspectActions('窄窗待办搜索');
  await evaluate('document.querySelector("[aria-label=清除搜索]").click()');
  await until(() => evaluate('document.querySelector("[aria-label=搜索待办]").value === ""'), '清除搜索');
  assert(true, '清除搜索操作保留原行为');
  const deleteSelector = `[...document.querySelectorAll('.todo-card')].find(row=>row.textContent.includes('全局操作隔离待办'))?.querySelector('.todo-delete')`;
  await until(() => evaluate(`!!(${deleteSelector})`), '待办删除按钮');
  await evaluate(`(${deleteSelector}).scrollIntoView({block:'center'})`);
  const point = await evaluate(`(()=>{const r=(${deleteSelector}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  assert(await evaluate(`(()=>{const b=${deleteSelector};return b.classList.contains('action-button')&&b.textContent.trim()==='删除'&&b.querySelectorAll('svg').length===1;})()`), '待办删除操作显示图标和文字');
  await evaluate(`(${deleteSelector}).click()`); await until(() => evaluate('!!document.querySelector(".todo-delete-confirm")'), '删除确认');
  await inspectActions('窄窗待办删除确认'); await clickText('保留', 'document.querySelector(".todo-delete-confirm")');
  await until(() => evaluate('!document.querySelector(".todo-delete-confirm")'), '取消删除确认');
  assert((await listTodos()).some(item => item.title === '全局操作隔离待办'), '取消删除保留待办');
  await evaluate(`(${deleteSelector}).click()`); await clickText('确认删除', 'document.querySelector(".todo-delete-confirm")');
  await until(async () => !(await listTodos()).some(item => item.title === '全局操作隔离待办'), '确认删除持久化');
  await until(() => evaluate('!!document.querySelector(".toast-action")'), '撤销提示');
  assert(await evaluate(`(()=>{const b=document.querySelector('.toast-action');return b.classList.contains('action-button')&&b.textContent.trim()==='撤销'&&b.querySelectorAll('svg').length===1;})()`), '撤销提示显示图标和文字');
  await evaluate('document.querySelector(".toast-action").click()');
  await until(async () => (await listTodos()).some(item => item.title === '全局操作隔离待办'), '撤销恢复待办');
  assert(true, '确认删除后的撤销重建隔离待办'); await shot('窄窗-待办-撤销');

  await nav('工具箱'); await clickText('编辑'); await clickText('管理分类');
  await until(() => evaluate('!!document.querySelector(".modal .cat-add")'), '工具分类管理');
  assert(await evaluate(`(()=>{const b=[...document.querySelectorAll('.modal button')].find(x=>x.textContent.trim()==='添加');return !!b&&b.disabled&&b.querySelectorAll('svg').length===1;})()`), '空分类名时添加操作保持禁用');
  await setValue('[aria-label="新分类名称"]', '隔离验收分类'); await clickText('添加', 'document.querySelector(".modal")');
  await until(() => evaluate(`[...document.querySelectorAll('.cat-row')].some(row=>row.textContent.includes('隔离验收分类'))`), '隔离分类创建');
  assert(await evaluate(`(()=>{const row=[...document.querySelectorAll('.cat-row')].find(x=>x.textContent.includes('隔离验收分类'));return ['上移','下移','重命名','删除'].every(label=>[...row.querySelectorAll('button.action-button')].some(b=>b.textContent.trim()===label&&b.querySelectorAll('svg').length===1));})()`), '分类管理的排序、重命名与删除均有图标和文字');
  await inspectActions('窄窗工具分类弹窗'); await shot('窄窗-工具分类'); await clickText('完成', 'document.querySelector(".modal")');
  await until(() => evaluate('!document.querySelector(".modal")'), '分类弹窗关闭');

  await nav('数据'); await until(() => evaluate(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='新建对象类型')`), '对象类型入口'); await clickText('新建对象类型');
  await until(() => evaluate('!!document.querySelector(".modal .data-prop-row")'), '新建对象类型弹窗');
  assert(await evaluate(`(()=>{const b=[...document.querySelectorAll('.modal button')].find(x=>x.textContent.trim()==='创建');return !!b&&b.disabled&&b.querySelectorAll('svg').length===1;})()`), '缺少必填字段时创建对象类型保持禁用');
  await clickText('添加属性行', 'document.querySelector(".modal")'); await until(() => evaluate('document.querySelectorAll(".modal .data-prop-row").length===2'), '添加属性行');
  assert(await evaluate(`(()=>{const b=document.querySelector('.modal [aria-label="移除属性行"]');return !!b&&b.textContent.trim()==='移除'&&b.querySelectorAll('svg').length===1;})()`), '移除属性行使用图标和文字');
  await evaluate('document.querySelector(".modal [aria-label=移除属性行]").click()'); await until(() => evaluate('document.querySelectorAll(".modal .data-prop-row").length===1'), '移除属性行');
  await inspectActions('窄窗数据类型弹窗'); await shot('窄窗-数据类型'); await clickText('取消', 'document.querySelector(".modal")');
  await until(() => evaluate('!document.querySelector(".modal")'), '对象类型弹窗关闭');
  await evaluate('document.querySelector("tr[data-object-type=todo] .data-type-link").click()');
  await until(() => evaluate('!!document.querySelector("#data-tab-objects")'), '待办对象类型详情');
  await evaluate('document.querySelector("#data-tab-objects").click()');
  await until(() => evaluate('!!document.querySelector(".data-query-controls summary")'), '对象查询入口');
  await evaluate('document.querySelector(".data-query-controls summary").click()');
  await until(() => evaluate(`(()=>{const b=[...document.querySelectorAll('.data-query-form button')].find(x=>x.textContent.trim()==='应用查询');return !!b&&!b.disabled})()`), '查询契约就绪');
  assert(await evaluate(`(()=>{const form=document.querySelector('.data-query-form'),submit=[...form.querySelectorAll('button')].find(b=>b.textContent.trim()==='应用查询'),add=[...form.querySelectorAll('button')].find(b=>b.textContent.trim()==='添加条件');return submit.classList.contains('action-button')&&submit.getAttribute('type')===null&&submit.type==='submit'&&add.getAttribute('type')==='button';})()`), '隐式 submit 与显式 button 类型保持原生表单语义');
  await clickText('添加条件', 'document.querySelector(".data-query-form")');
  await until(() => evaluate('!!document.querySelector(".data-query-form [aria-label^=移除条件]")'), '查询条件已添加');
  assert(await evaluate(`!document.querySelector('.data-query-controls summary').textContent.includes('已应用')`), '添加条件不会误提交查询表单');
  await evaluate('document.querySelector(".data-query-form [aria-label^=移除条件]").click()');
  await until(() => evaluate('!document.querySelector(".data-query-form [aria-label^=移除条件]")'), '查询条件已移除');
  await evaluate('document.querySelector(".data-query-form").requestSubmit()');
  await until(() => evaluate(`document.querySelector('.data-query-controls summary').textContent.includes('已应用')`), '隐式提交应用查询');
  assert(true, '隐式 submit 真实提交查询');

  await nav('自媒体'); await clickText('素材', 'document.querySelector(".media-subnav")');
  await until(() => evaluate('!!document.querySelector("[placeholder=素材标题]")'), '素材页');
  await setValue('[placeholder="素材标题"]', '全局操作隔离素材'); await clickText('入库');
  await until(() => evaluate(`[...document.querySelectorAll('.media-topic-row')].some(row=>row.textContent.includes('全局操作隔离素材'))`), '隔离素材创建');
  const materialRow = `[...document.querySelectorAll('.media-topic-row')].find(row=>row.textContent.includes('全局操作隔离素材'))`;
  await evaluate(`(${materialRow}).scrollIntoView({block:'center'})`);
  const materialPoint = await evaluate(`(()=>{const r=(${materialRow}).querySelector('[aria-label=删除素材]').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: materialPoint.x, y: materialPoint.y });
  assert(await evaluate(`(()=>{const b=(${materialRow}).querySelector('[aria-label=删除素材]');return !!b&&b.classList.contains('action-button')&&b.textContent.trim()==='删除'&&b.querySelectorAll('svg').length===1&&Number(getComputedStyle(b).opacity)>0;})()`), '素材删除操作可见且使用图标和文字');
  await inspectActions('窄窗自媒体素材操作');
  await evaluate(`(${materialRow}).querySelector('[aria-label=删除素材]').click()`);
  await until(() => evaluate(`!(${materialRow})`), '隔离素材删除');
  assert(true, '素材删除操作保留原行为'); await shot('窄窗-自媒体素材');

  writeFileSync(join(evidence, 'result.json'), JSON.stringify({ ok: true, assertions: passed.length, passed, packaged: !!packaged, binary: executable, evidence, work }, null, 2));
  console.log(JSON.stringify({ ok: true, assertions: passed.length, packaged: !!packaged, evidence }));
} catch (error) {
  if (send) try { const image = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(evidence, 'failure.png'), Buffer.from(image.data, 'base64')); } catch {}
  const result = { ok: false, assertions: passed.length, passed, error: error.stack || String(error), packaged: !!packaged, binary: executable, evidence, work, stderr };
  writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2)); console.error(JSON.stringify(result, null, 2)); process.exitCode = 1;
} finally {
  ws?.close();
  if (app && app.exitCode === null && app.signalCode === null) {
    app.kill('SIGTERM'); await Promise.race([new Promise(resolveExit => app.once('exit', resolveExit)), delay(5000)]);
    if (app.exitCode === null && app.signalCode === null) { app.kill('SIGKILL'); await Promise.race([new Promise(resolveExit => app.once('exit', resolveExit)), delay(1000)]); }
  }
  rmSync(work, { recursive: true, force: true });
}
