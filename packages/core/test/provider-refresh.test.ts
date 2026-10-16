import {describe,it,expect,vi} from 'vitest';
import {mkCore} from './helpers';
import {installProvider,providerJson} from './provider-fixtures';
import {eventFixture} from './runtime-fixtures';
import {createCore,openNodeSqliteDb,type TodoDeskCore} from '../src';

function deferred(){let resolve!:(value:unknown)=>void;const promise=new Promise<unknown>(done=>resolve=done);return {promise,resolve};}

describe('持久刷新任务与并发提交保护',()=>{
 it('请求复用、真实共库读写锁释放、公开命令导入与个人备注保护',async()=>{
  let host:TodoDeskCore,dbPath='';const raw={...eventFixture(),title:'来源新标题'};
  const context=mkCore({providerNetwork:async()=>{const other=openNodeSqliteDb(dbPath);other.exec('BEGIN IMMEDIATE');other.exec('ROLLBACK');other.close();return providerJson(raw);}});host=context.core;dbPath=context.dbPath;
  try{
   const p=installProvider(host,dbPath),event=host.externalEvents.list({providerId:p.providerId}).items[0],sub=host.subscriptions.subscribe({eventId:event.id});host.todos.update(sub.todo!.id,{notes:'个人备注'});
   const first=host.externalEvents.refresh({providerId:p.providerId});expect(first.effect).toBe('queued');expect(host.externalEvents.refresh({providerId:p.providerId})).toMatchObject({effect:'reused',run:{id:first.run.id}});
   expect(first.run).not.toHaveProperty('lease_token');expect(first.run).not.toHaveProperty('context_json');expect(host.externalEvents.getStatus({providerId:p.providerId}).activeRun?.id).toBe(first.run.id);
   expect(await host.providerWorker.tick()).toBe(true);expect(host.externalEvents.getRun({runId:first.run.id}).status).toBe('succeeded');
   expect(host.todos.get(sub.todo!.id)).toMatchObject({title:raw.title,notes:'个人备注'});expect(host.externalEvents.getStatus({providerId:p.providerId})).toMatchObject({activeRun:null,lastError:null});
   expect(host.externalEvents.getStatus({providerId:p.providerId}).lastSuccessAt).toBeTruthy();
   expect(()=>host.forExtension(p.extensionId).externalEvents.import({providerId:p.providerId,batchId:'not-granted',expectedProviderRevision:2,events:[raw]})).toThrow('PERMISSION_DENIED');
  }finally{await host!.providerWorker.stop();context.cleanup();}
 });
 it('先发请求的旧响应不能覆盖随后提交的新事件',async()=>{
  const slow=deferred(),{core,dbPath,cleanup}=mkCore({providerNetwork:()=>slow.promise});
  try{
   const p=installProvider(core,dbPath),run=core.externalEvents.refresh({providerId:p.providerId}).run,pending=core.providerWorker.tick();
   core.externalEvents.import({providerId:p.providerId,batchId:'newer',expectedProviderRevision:1,events:[{...eventFixture(),title:'较新事实'}]});
   slow.resolve(providerJson({...eventFixture(),title:'过时响应'}));await pending;
   expect(core.externalEvents.getRun({runId:run.id})).toMatchObject({status:'failed',error:{code:'REVISION_CONFLICT'}});
   expect(core.externalEvents.list({providerId:p.providerId}).items[0].title).toBe('较新事实');
  }finally{await core.providerWorker.stop();cleanup();}
 });
 it('租约过期后另一连接接力，旧执行者不能覆盖新结果或任务状态',async()=>{
  const slow=deferred(),{core,dbPath,cleanup}=mkCore({providerNetwork:()=>slow.promise});let second:TodoDeskCore|undefined;
  const now=Date.now();vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now);
  try{
   const p=installProvider(core,dbPath),run=core.externalEvents.refresh({providerId:p.providerId}).run,first=core.providerWorker.tick();
   vi.setSystemTime(now+46000);second=createCore(openNodeSqliteDb(dbPath),{dbPath,providerNetwork:async()=>providerJson({...eventFixture(),title:'接力的新事实'})});
   expect(await second.providerWorker.tick()).toBe(true);expect(second.externalEvents.getRun({runId:run.id}).status).toBe('succeeded');
   slow.resolve(providerJson({...eventFixture(),title:'旧执行者数据'}));await first;
   expect(core.externalEvents.list({providerId:p.providerId}).items[0].title).toBe('接力的新事实');expect(core.externalEvents.getRun({runId:run.id}).status).toBe('succeeded');
  }finally{vi.useRealTimers();await core.providerWorker.stop();if(second){await second.providerWorker.stop();second.db.close();}cleanup();}
 });
 it('撤权、停用或公共导入动作停用后，网络响应整批拒绝',async()=>{
  for(const change of ['grant','provider','extension','action'] as const){
   const slow=deferred(),{core,dbPath,cleanup}=mkCore({providerNetwork:()=>slow.promise});
   try{
    const p=installProvider(core,dbPath),run=core.externalEvents.refresh({providerId:p.providerId}).run,pending=core.providerWorker.tick();
    if(change==='grant')core.db.prepare("DELETE FROM extension_grants WHERE extension_id=? AND capability='providers.refresh'").run(p.extensionId);
    if(change==='provider')core.externalEvents.updateProvider({providerId:p.providerId,expectedRevision:1,enabled:false});
    if(change==='extension'){const ext=core.extensions.get({extensionId:p.extensionId})!;core.extensions.setEnabled({extensionId:p.extensionId,expectedRevision:ext.revision,enabled:false});}
    if(change==='action')core.ontology.updateActionType('import_external_events',{status:'disabled'});
    slow.resolve(providerJson({...eventFixture(),title:'不能写入'}));await pending;
    expect(core.externalEvents.getRun({runId:run.id}).status).toBe('failed');expect(core.externalEvents.list({providerId:p.providerId}).items[0].title).toBe(eventFixture().title);
   }finally{await core.providerWorker.stop();cleanup();}
  }
 });
 it('任一条非法则整批拒绝；空响应和失败都不清空旧数据',async()=>{
  let raw:unknown={records:[providerJson(eventFixture('valid-new')).records[0],{...providerJson(eventFixture('bad')).records[0],when:{start:'无效时间'}}]},failed=false;
  const {core,dbPath,cleanup}=mkCore({providerNetwork:async()=>{if(failed)throw Object.assign(new Error('连接失败'),{code:'HTTP_SOURCE_FAILED'});return raw;}});
  try{
   const p=installProvider(core,dbPath);let run=core.externalEvents.refresh({providerId:p.providerId}).run;await core.providerWorker.tick();expect(core.externalEvents.getRun({runId:run.id}).status).toBe('failed');expect(core.externalEvents.list({providerId:p.providerId}).items).toHaveLength(1);
   raw={records:[]};run=core.externalEvents.refresh({providerId:p.providerId}).run;await core.providerWorker.tick();expect(core.externalEvents.getRun({runId:run.id}).status).toBe('succeeded');const lastSuccessAt=core.externalEvents.getStatus({providerId:p.providerId}).lastSuccessAt;
   failed=true;run=core.externalEvents.refresh({providerId:p.providerId}).run;await core.providerWorker.tick();expect(core.externalEvents.getStatus({providerId:p.providerId})).toMatchObject({lastSuccessAt,lastError:{code:'HTTP_SOURCE_FAILED'}});expect(core.externalEvents.list({providerId:p.providerId}).items).toHaveLength(1);
  }finally{await core.providerWorker.stop();cleanup();}
 });
 it('到期或长时间休眠恢复最多排一次，不补跑错过的每个周期',async()=>{
  const {core,dbPath,cleanup}=mkCore({providerNetwork:async()=>providerJson(eventFixture())});const now=Date.now();vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now);
  try{
   const p=installProvider(core,dbPath);expect(core.providerWorker.scheduleDue()).toBe(1);expect(core.providerWorker.scheduleDue()).toBe(0);await core.providerWorker.tick();expect(core.providerWorker.scheduleDue()).toBe(0);
   vi.setSystemTime(now+3*86400000);expect(core.providerWorker.scheduleDue()).toBe(1);expect(core.providerWorker.scheduleDue()).toBe(0);expect(core.externalEvents.getStatus({providerId:p.providerId}).activeRun?.status).toBe('queued');
  }finally{vi.useRealTimers();await core.providerWorker.stop();cleanup();}
 });
 it('外部助手来源只排队等待，实际标准导入后才完成请求',async()=>{
  let networkCalls=0;const {core,dbPath,cleanup}=mkCore({providerNetwork:async()=>{networkCalls++;return {};}});
  try{
   const p=installProvider(core,dbPath,'test.external-provider','import'),run=core.externalEvents.refresh({providerId:p.providerId}).run;
   expect(run.mode).toBe('external-agent');expect(await core.providerWorker.tick()).toBe(false);expect(core.providerWorker.scheduleDue()).toBe(0);expect(networkCalls).toBe(0);
   expect(core.externalEvents.getStatus({providerId:p.providerId}).activeRun?.status).toBe('queued');
   core.externalEvents.import({providerId:p.providerId,batchId:'agent-update',expectedProviderRevision:1,events:[{...eventFixture(),title:'助手核验后导入'}]});expect(core.externalEvents.getRun({runId:run.id}).status).toBe('succeeded');
  }finally{await core.providerWorker.stop();cleanup();}
 });
 it('工具不能读取他人任务；停用后的历史状态仅受信宿主可读',async()=>{
  const {core,dbPath,cleanup}=mkCore();try{
   const a=installProvider(core,dbPath,'test.source-a','import'),b=installProvider(core,dbPath,'test.source-b','import'),run=core.externalEvents.refresh({providerId:b.providerId}).run,scope=core.forExtension(a.extensionId);
   expect(()=>scope.externalEvents.refresh({providerId:b.providerId})).toThrow('PERMISSION_DENIED');expect(()=>scope.externalEvents.getRun({runId:run.id})).toThrow('PERMISSION_DENIED');
   expect(Object.keys(scope)).toEqual(['externalEvents','subscriptions']);const ext=core.extensions.get({extensionId:b.extensionId})!;core.extensions.setEnabled({extensionId:b.extensionId,expectedRevision:ext.revision,enabled:false});
   expect(core.externalEvents.getRun({runId:run.id}).status).toBe('queued');expect(()=>core.forExtension(b.extensionId).externalEvents.getRun({runId:run.id})).toThrow('PERMISSION_DENIED');
  }finally{await core.providerWorker.stop();cleanup();}
 });
});
