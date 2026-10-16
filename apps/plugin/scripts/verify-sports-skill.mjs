#!/usr/bin/env node
// 赛事技能边界及工具箱往返验收；只使用临时库、临时 HOME 和临时工具文件。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePage } from '../skills/tododesk-sports/scripts/validate-page.mjs';

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'dayfolio-sports-'));
const home = join(work, 'home'), db = join(work, 'probe.db'), packageDir = join(work, 'page');
mkdirSync(home); mkdirSync(packageDir);
assert.ok(db.startsWith(work+'/') && home.startsWith(work+'/'));
const beforeTime = new Date(Date.now()-60000).toISOString(), now = new Date().toISOString();
const config = {
  schemaVersion:1, pageId:'isolated-sports-probe', revision:1,
  event:{id:'sample',name:'隔离赛事',sport:'模拟项目',edition:'验收届次',scope:'single_sport'},
  participantKinds:['team'],modules:['schedule','sources'],preferences:{timezone:'Asia/Shanghai',following:['team-a']},
  target:{kind:'local',entry:'index.html'},stages:[{id:'stage-a',name:'示例阶段',format:'simulation'}],
  sources:[{id:'source-a',kind:'user',url:null,coverage:'仅隔离测试',status:'ok',checkedAt:beforeTime,lastSuccessAt:beforeTime},{id:'ai-a',kind:'ai',coverage:'示例介绍',status:'pending',prompt:'为当前模拟赛事整理有来源的介绍，不使用真实比赛结果。'}],
  records:[{id:'match-a',type:'match',stageId:'stage-a',sourceId:'source-a',data:{score:'待赛',note:'保留我的备注'},fieldOwners:{note:'user'}},{id:'manual',type:'note',sourceId:'source-a',owner:'user',data:{content:'人工附件说明'}}],
  lastCheckedAt:beforeTime,lastUpdatedAt:beforeTime,
};
let checks=0;
const check = (name, fn) => { fn(); checks++; console.log('✓ '+name); };
const clone = value => structuredClone(value);
check('合法侧车配置',()=>assert.deepEqual(validatePage(config),[]));
const updated=clone(config);updated.revision=2;updated.lastCheckedAt=now;updated.lastUpdatedAt=now;updated.records[0].data.score='2:1';
check('保留身份、偏好和人工字段的结果更新',()=>assert.deepEqual(validatePage(updated,config),[]));
for(const [name,change] of [
  ['重复记录',x=>x.records.push(clone(x.records[0]))],
  ['未知来源',x=>x.records[0].sourceId='missing'],
  ['未知阶段',x=>x.records[0].stageId='missing'],
  ['缺少 AI 提示词',x=>delete x.sources[1].prompt],
  ['无时区的检查时间',x=>x.lastCheckedAt='2026-10-16 12:00:00'],
  ['工具入口穿越',x=>x.target.entry='../index.html'],
]) check(name+'被拒绝',()=>{const x=clone(config);change(x);assert.ok(validatePage(x).length>0)});
for(const [name,change] of [
  ['跨届更新',x=>x.event.edition='另一届'],
  ['更换页面身份',x=>x.pageId='other'],
  ['覆盖关注',x=>x.preferences.following=[]],
  ['覆盖人工字段',x=>x.records[0].data.note='覆盖'],
  ['删除人工记录',x=>x.records=x.records.filter(r=>r.id!=='manual')],
  ['失败来源伪造成功时间',x=>{x.sources[0].status='failed';x.sources[0].lastSuccessAt=now}],
]) check(name+'被拒绝',()=>{const x=clone(updated);change(x);assert.ok(validatePage(x,config).length>0)});
const noChange=clone(config);noChange.revision=2;noChange.lastCheckedAt=now;
check('无事实变化只记录检查时间',()=>assert.deepEqual(validatePage(noChange,config),[]));
check('无事实变化伪造更新时间被拒绝',()=>{const x=clone(noChange);x.lastUpdatedAt=now;assert.ok(validatePage(x,config).length>0)});

let child;
try {
  child=spawn(process.execPath,[join(plugin,'mcp/mcp-server.cjs')],{cwd:work,env:{PATH:process.env.PATH,HOME:home,TODODESK_DB:db},stdio:['pipe','pipe','pipe']});
  let buffer='',nextId=1;const pending=new Map();let stderr='';
  child.stderr.on('data',d=>{stderr+=d.toString()});
  child.stdout.on('data',chunk=>{buffer+=chunk;let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);try{const m=JSON.parse(line);if(pending.has(m.id)){const item=pending.get(m.id);clearTimeout(item.timer);pending.delete(m.id);m.error?item.reject(new Error(m.error.message)):item.resolve(m.result)}}catch{/* 忽略非协议行 */}}});
  const request=(method,params)=>new Promise((resolve,reject)=>{const id=nextId++;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('MCP 超时 '+stderr.slice(-500)))},20000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')});
  const call=async(name,args={})=>{const result=await request('tools/call',{name,arguments:args});assert.ok(!result.isError,JSON.stringify(result));const body=JSON.parse(result.content.find(c=>c.type==='text').text);assert.equal(body.ok,true);return body.data};
  await request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'sports-isolation-test',version:'1'}});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized',params:{}})+'\n');
  writeFileSync(join(packageDir,'index.html'),'<!doctype html><html lang="zh-CN"><body>模拟赛事 v1</body></html>');
  writeFileSync(join(packageDir,'sports-page.json'),JSON.stringify(config));
  writeFileSync(join(packageDir,'style.css'),'body { color: #123; }');
  writeFileSync(join(packageDir,'user-note.txt'),'不可丢失的用户附件');
  const added=await call('add_tool',{title:'隔离赛事页面',category_name:'验收',entry_file:'index.html',file_paths:[packageDir]});
  const id=added.tool.id;
  check('MCP 新增完整赛事工具',()=>{assert.ok(id>0);assert.ok(added.files.includes('sports-page.json'));assert.ok(added.files.includes('user-note.txt'))});
  const root=join(dirname(db),'tools',String(id));
  assert.equal(JSON.parse(readFileSync(join(root,'sports-page.json'))).pageId,config.pageId);
  const bound=clone(config);bound.target={kind:'dayfolio',entry:'index.html',toolId:id};
  writeFileSync(join(packageDir,'sports-page.json'),JSON.stringify(bound));
  await call('update_tool',{id,entry_file:'index.html',file_paths:[packageDir]});
  const boundUpdate=clone(updated);boundUpdate.target=clone(bound.target);
  writeFileSync(join(packageDir,'sports-page.json'),JSON.stringify(boundUpdate));
  writeFileSync(join(packageDir,'index.html'),'<!doctype html><html lang="zh-CN"><body>模拟赛事 v2 比分 2:1</body></html>');
  await call('update_tool',{id,entry_file:'index.html',file_paths:[packageDir]});
  const listed=await call('list_tools');
  check('MCP 原位更新不重复建工具',()=>{assert.equal(listed.count,1);assert.equal(listed.tools[0].id,id);assert.equal(listed.tools[0].title,'隔离赛事页面')});
  check('完整替换保留样式、附件、关注与人工字段',()=>{assert.ok(existsSync(join(root,'style.css')));assert.equal(readFileSync(join(root,'user-note.txt'),'utf8'),'不可丢失的用户附件');assert.deepEqual(validatePage(JSON.parse(readFileSync(join(root,'sports-page.json'))),bound),[])});
  check('MCP 目录收集保留非隐藏侧车',()=>assert.ok(listed.tools[0].files.includes('sports-page.json')));
  await call('update_tool',{id,entry_file:'index.html',file_paths:[packageDir]});
  const repeated=await call('list_tools');
  check('重复更新不创建重复工具或改变页面身份',()=>{assert.equal(repeated.count,1);assert.equal(JSON.parse(readFileSync(join(root,'sports-page.json'))).pageId,config.pageId)});
  const savedManifest=readFileSync(join(root,'sports-page.json'),'utf8'),savedHtml=readFileSync(join(root,'index.html'),'utf8');
  await assert.rejects(()=>call('update_tool',{id,entry_file:'missing.html',file_paths:[packageDir]}));
  check('无效更新失败后保留原配置与入口',()=>{assert.equal(readFileSync(join(root,'sports-page.json'),'utf8'),savedManifest);assert.equal(readFileSync(join(root,'index.html'),'utf8'),savedHtml)});
  console.log(JSON.stringify({ok:true,checks,isolated:true,realDatabaseTouched:false}));
} finally {
  if(child){await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);child.kill()})}
  rmSync(work,{recursive:true,force:true});
}
