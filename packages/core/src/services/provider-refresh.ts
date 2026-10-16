// provider 专用持久队列：认领与提交用短事务，网络在事务外，旧执行者必须通过 fencing。
import { randomUUID } from 'node:crypto';
import { inTx, readSnapshot, type DbAdapter } from '../db';
import type { HttpJsonConfig } from '../extension-types';
import type { EventImportInput, EventImportResult, RuntimeActor } from '../runtime-types';
import type { ProviderRefreshApi, ProviderWorker, ProviderNetwork, ProviderRun, ProviderError, RefreshContext } from '../provider-types';
import { canonical, digest, providerFor } from './event-model';
import { validateHttpConfig } from './extension-package';
import { readHttpsJson, mapProviderJson } from './provider-network';
import { runtimeError, runtimeErrorInfo } from '../utils/schedule';

type Row=Record<string,unknown>;
const ACTIVE="'queued','fetching','validating','committing'",LEASE_MS=45000;
const errorOf=(value:unknown):ProviderError|null=>{
  if(value==null)return null;
  try{return JSON.parse(String(value)) as ProviderError;}catch{return {code:'HTTP_SOURCE_FAILED',message:String(value),retryable:false};}
};
const publicRun=(row:Row):ProviderRun=>({id:String(row.id),providerId:String(row.provider_id),status:row.status as ProviderRun['status'],error:errorOf(row.error),mode:row.request_kind==='external'?'external-agent':'http-json',createdAt:String(row.created_at),finishedAt:row.finished_at==null?null:String(row.finished_at)});

export function createProviderRefreshService(db:DbAdapter,deps:{
  guard:(command:string)=>void;
  importEvents:(extensionId:string,input:EventImportInput)=>EventImportResult;
  network?:ProviderNetwork;
}) {
  const context=(providerId:string,actor:RuntimeActor={}):{provider:Row;context:RefreshContext}=>{
    const provider=providerFor(db,providerId,actor,'providers.refresh',true);
    const extension=db.prepare('SELECT * FROM extensions WHERE id=?').get(provider.extension_id)!;
    const grants=db.prepare('SELECT capability,scope,grant_revision,authorization_digest FROM extension_grants WHERE extension_id=? ORDER BY capability,scope').all(provider.extension_id);
    if(!grants.some(grant=>grant.capability==='providers.refresh'&&grant.scope===providerId))return runtimeError('PERMISSION_DENIED','该来源未获刷新权限');
    if(!extension.active_release_id)return runtimeError('PERMISSION_DENIED','来源尚未安装为完整工具包');
    if(provider.kind==='http-json')validateHttpConfig(JSON.parse(String(provider.config_json)) as HttpJsonConfig);
    return {provider,context:{extensionId:String(provider.extension_id),extensionRevision:Number(extension.revision),releaseId:String(extension.active_release_id),grantDigest:digest(grants),providerRevision:Number(provider.revision),kind:String(provider.kind),configJson:String(provider.config_json)}};
  };
  const finish=(id:string,status:'failed'|'cancelled',error:ProviderError)=>db.prepare('UPDATE provider_sync_runs SET status=?,error=?,finished_at=?,lease_token=NULL,lease_expires_at=NULL WHERE id=?').run(status,JSON.stringify(error),new Date().toISOString(),id);
  const forActor=(actor:RuntimeActor={}):ProviderRefreshApi=>({
    refresh:input=>inTx(db,()=>{
      deps.guard('refresh_event_provider');
      const state=context(input.providerId,actor),now=new Date().toISOString(),hash=digest(state.context);
      const current=db.prepare(`SELECT * FROM provider_sync_runs WHERE provider_id=? AND request_kind IN ('refresh','external') AND status IN (${ACTIVE})`).get(input.providerId);
      if(current&&current.input_digest===hash)return {effect:'reused',run:publicRun(current)};
      if(current)finish(String(current.id),'cancelled',{code:'REVISION_CONFLICT',message:'来源或授权已变更，较旧刷新已撤销',retryable:false});
      const generation=Number(db.prepare('SELECT MAX(fencing_generation) value FROM provider_sync_runs WHERE provider_id=?').get(input.providerId)?.value??0)+1;
      const id=randomUUID(),kind=state.provider.kind==='http-json'?'refresh':'external';
      db.prepare("INSERT INTO provider_sync_runs(id,provider_id,base_revision,fencing_generation,status,input_digest,context_json,request_kind,created_at) VALUES(?,?,?,?,'queued',?,?,?,?)").run(id,input.providerId,state.context.providerRevision,generation,hash,canonical(state.context),kind,now);
      return {effect:'queued',run:publicRun(db.prepare('SELECT * FROM provider_sync_runs WHERE id=?').get(id)!)};
    }),
    getRun:input=>readSnapshot(db,()=>{
      const row=db.prepare("SELECT * FROM provider_sync_runs WHERE id=? AND request_kind IN ('refresh','external')").get(input.runId);
      if(!row)return runtimeError('RUN_NOT_FOUND','刷新记录不存在');
      providerFor(db,String(row.provider_id),actor,'events.read');return publicRun(row);
    }),
    getStatus:input=>readSnapshot(db,()=>{
      const provider=providerFor(db,input.providerId,actor,'events.read');
      const active=db.prepare(`SELECT * FROM provider_sync_runs WHERE provider_id=? AND request_kind IN ('refresh','external') AND status IN (${ACTIVE}) ORDER BY created_at DESC LIMIT 1`).get(input.providerId);
      const success=db.prepare("SELECT finished_at FROM provider_sync_runs WHERE provider_id=? AND status='succeeded' AND request_kind=? ORDER BY finished_at DESC LIMIT 1").get(input.providerId,provider.kind==='http-json'?'refresh':'import');
      const latest=db.prepare("SELECT error FROM provider_sync_runs WHERE provider_id=? AND request_kind IN ('refresh','external') AND finished_at IS NOT NULL ORDER BY finished_at DESC,rowid DESC LIMIT 1").get(input.providerId);
      return {revision:Number(provider.revision),lastSuccessAt:success?.finished_at==null?null:String(success.finished_at),activeRun:active?publicRun(active):null,lastError:errorOf(latest?.error),mode:provider.kind==='http-json'?'http-json':'external-agent'};
    }),
  });

  const recover=()=>{
    const now=new Date().toISOString();
    db.prepare("UPDATE provider_sync_runs SET status='queued',lease_token=NULL,lease_expires_at=NULL,error=NULL WHERE request_kind='refresh' AND status IN ('fetching','validating','committing') AND lease_expires_at<=?").run(now);
  };
  const assertLease=(row:Row)=>{
    const actual=db.prepare('SELECT * FROM provider_sync_runs WHERE id=?').get(row.id);
    if(!actual||actual.lease_token!==row.lease_token||actual.fencing_generation!==row.fencing_generation||String(actual.lease_expires_at)<=new Date().toISOString()||!['fetching','validating','committing'].includes(String(actual.status)))return runtimeError('LEASE_LOST','刷新租约已失效，旧响应不能提交');
    const latest=Number(db.prepare('SELECT MAX(fencing_generation) value FROM provider_sync_runs WHERE provider_id=?').get(row.provider_id)?.value??0);
    if(latest!==Number(row.fencing_generation))return runtimeError('LEASE_LOST','已有较新的刷新认领，旧响应不能提交');
    const state=context(String(row.provider_id));
    if(digest(state.context)!==row.input_digest)return runtimeError('REVISION_CONFLICT','来源、工具、授权或数据基线已变化，请重新拉取');
    deps.guard('refresh_event_provider');return state;
  };
  const claim=()=>inTx(db,()=>{
    recover();
    // 每次只认领一个已授权来源，异常行终结后留下一次 tick 继续其他来源。
    const row=db.prepare("SELECT * FROM provider_sync_runs WHERE request_kind='refresh' AND status='queued' ORDER BY created_at,rowid LIMIT 1").get();
    if(!row)return null;
    try{
      deps.guard('refresh_event_provider');const state=context(String(row.provider_id));
      if(digest(state.context)!==row.input_digest)return runtimeError('REVISION_CONFLICT','排队期间来源或授权已变更');
      const generation=Number(db.prepare('SELECT MAX(fencing_generation) value FROM provider_sync_runs WHERE provider_id=?').get(row.provider_id)?.value??0)+1;
      db.prepare("UPDATE provider_sync_runs SET status='fetching',lease_token=?,fencing_generation=?,lease_expires_at=? WHERE id=? AND status='queued'").run(randomUUID(),generation,new Date(Date.now()+LEASE_MS).toISOString(),row.id);
      return db.prepare('SELECT * FROM provider_sync_runs WHERE id=?').get(row.id)!;
    }catch(error){const info=runtimeErrorInfo(error);finish(String(row.id),'failed',info);return null;}
  });
  let running=false,timer:ReturnType<typeof setInterval>|undefined,pending:Promise<boolean>|null=null;
  let controller:AbortController|null=null;
  const execute=async():Promise<boolean>=>{
    const row=claim();if(!row)return false;
    controller=new AbortController();
    try{
      const saved=JSON.parse(String(row.context_json)) as RefreshContext,config=JSON.parse(saved.configJson) as HttpJsonConfig;
      const raw=await (deps.network??readHttpsJson)(config.url,{signal:controller.signal,maxBytes:5*1024*1024,timeoutMs:15000});
      inTx(db,()=>{assertLease(row);db.prepare("UPDATE provider_sync_runs SET status='validating' WHERE id=?").run(row.id);});
      const events=mapProviderJson(raw,config);
      inTx(db,()=>{
        const state=assertLease(row);db.prepare("UPDATE provider_sync_runs SET status='committing' WHERE id=?").run(row.id);
        const result=deps.importEvents(state.context.extensionId,{providerId:String(row.provider_id),batchId:'refresh:'+String(row.id)+':'+String(row.fencing_generation),expectedProviderRevision:Number(row.base_revision),events});
        db.prepare("UPDATE provider_sync_runs SET status='succeeded',result_json=?,error=NULL,finished_at=?,lease_token=NULL,lease_expires_at=NULL WHERE id=?").run(JSON.stringify(result),new Date().toISOString(),row.id);
      });
    }catch(error){
      inTx(db,()=>{
        const actual=db.prepare('SELECT * FROM provider_sync_runs WHERE id=?').get(row.id);
        // 被接力或撤销的旧执行者既不能写事件，也不能覆盖新执行者的任务结果。
        if(actual&&actual.lease_token===row.lease_token&&actual.fencing_generation===row.fencing_generation&&['fetching','validating','committing'].includes(String(actual.status))){const info=runtimeErrorInfo(error);finish(String(row.id),info.code==='REFRESH_CANCELLED'?'cancelled':'failed',info);}
      });
    }finally{controller=null;}
    return true;
  };
  const tick=():Promise<boolean>=>{
    if(pending)return pending;
    pending=execute().finally(()=>{pending=null;});return pending;
  };
  const scheduleDue=()=>inTx(db,()=>{
    if(db.prepare("SELECT status FROM ont_action_types WHERE api_name='refresh_event_provider'").get()?.status!=='active')return 0;
    let count=0;const now=Date.now();
    const providers=db.prepare("SELECT p.* FROM event_providers p JOIN extensions e ON e.id=p.extension_id WHERE p.kind='http-json' AND p.enabled=1 AND e.status='active' AND p.refresh_seconds IS NOT NULL ORDER BY p.id").all();
    for(const provider of providers){
      if(db.prepare(`SELECT 1 FROM provider_sync_runs WHERE provider_id=? AND request_kind IN ('refresh','external') AND status IN (${ACTIVE})`).get(provider.id))continue;
      const last=db.prepare("SELECT created_at FROM provider_sync_runs WHERE provider_id=? AND request_kind='refresh' ORDER BY created_at DESC LIMIT 1").get(provider.id);
      if(last&&now-Date.parse(String(last.created_at))<Number(provider.refresh_seconds)*1000)continue;
      try{forActor().refresh({providerId:String(provider.id)});count++;}catch{/* 停用或撤权来源不自动恢复授权。 */}
    }
    return count;
  });
  const worker:ProviderWorker={
    tick,scheduleDue,
    start:()=>{if(running)return;running=true;const pump=()=>{if(!running)return;try{scheduleDue();void tick().catch(()=>{});}catch{/* 下轮短检查恢复数据库瞬时忙。 */}};timer=setInterval(pump,1000);timer.unref();pump();},
    stop:async()=>{running=false;if(timer){clearInterval(timer);timer=undefined;}controller?.abort();await pending;},
  };
  return {forActor,worker};
}
