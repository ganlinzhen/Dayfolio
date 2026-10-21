// HTML 只发布本工具的来源资料；持续关注的授权、去重和待办保护由宿主管理。
import { inTx, readSnapshot, type DbAdapter } from '../db';
import type { NewTodoInput } from '../types';
import type { ToolService } from './tool';
import { normalizeToolTodoDraft, resolveToolTodoCategory, type ToolTodoCategoryInput, type ToolTodoDraft, type ToolTodoService } from './tool-todos';
import type { TodoService } from './todo';
import { canonical, digest } from './event-model';
import { managedSnapshot } from './subscriptions';
import { dateInZone, displayTimezone, runtimeError } from '../utils/schedule';

export const TOOL_FOLLOW_FILE='dayfolio-follow.json';
export const TOOL_FOLLOW_BYTES=512*1024;
export type ToolFollowScope={kind:'item'|'group';key:string};
export interface ToolFollowSource extends ToolTodoDraft { groupKeys?:string[];sourceStatus?:'scheduled'|'postponed'|'cancelled'|'finished' }
export interface ToolFollowSnapshot {schemaVersion:1;revision:number;groups?:Array<{key:string;title:string}>;items:ToolFollowSource[];category?:ToolTodoCategoryInput}
export interface ToolFollowInput {toolId:number;scope:ToolFollowScope}
type Row=Record<string,unknown>;
type Source={draft:ToolTodoDraft;groups:string[];status:string;revision:number};
const key=(value:unknown,max=240)=>typeof value==='string'&&!!value.trim()&&value.length<=max;
const exact=(value:unknown,fields:string[])=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>fields.includes(k));
const identity=(toolId:number,kind:string,value:string)=>`tool:${toolId}:${kind}:${value}`;

export function createToolFollowingService(db:DbAdapter,deps:{tools:ToolService;toolTodos:()=>ToolTodoService;todos:()=>TodoService;managedWrite:<T>(fn:()=>T)=>T}) {
  const tool=(id:number)=>{if(!Number.isSafeInteger(id)||id<=0)runtimeError('CONTRACT_INVALID','工具 ID 无效');return deps.tools.getTool(id);};
  const source=(row:Row):Source=>({draft:JSON.parse(String(row.draft_json)),groups:JSON.parse(String(row.groups_json)),status:String(row.source_status),revision:Number(row.revision)});
  const catalog=(toolId:number)=>db.prepare('SELECT * FROM tool_follow_catalogs WHERE tool_id=?').get(toolId);
  const sources=(toolId:number)=>db.prepare('SELECT * FROM tool_follow_sources WHERE tool_id=? ORDER BY source_key').all(toolId);
  const link=(toolId:number,sourceKey:string)=>db.prepare('SELECT * FROM tool_todo_links WHERE tool_id=? AND source_key=?').get(toolId,sourceKey);
  const rules=(toolId:number)=>db.prepare('SELECT * FROM tool_follow_rules WHERE tool_id=? ORDER BY id').all(toolId);
  const matches=(rule:Row,s:Source)=>rule.kind==='item'?rule.target_key===s.draft.sourceKey:s.groups.includes(String(rule.target_key));
  const activeRule=(toolId:number,s:Source)=>rules(toolId).find(r=>r.active&&matches(r,s));
  const eligible=(s:Source)=>!['cancelled','finished'].includes(s.status)&&(s.draft.startAt?Date.parse(s.draft.startAt)>Date.now():s.draft.dueDate?s.draft.dueDate>=dateInZone(new Date(),displayTimezone(db)):true);
  const sourcePatch=(s:Source):NewTodoInput=>s.status!=='cancelled'&&s.draft.startAt
    ?{title:s.draft.title,time_mode:'instant',scheduled_start_at:s.draft.startAt,scheduled_end_at:s.draft.endAt??null}
    :{title:s.draft.title,time_mode:'floating',scheduled_start_at:null,scheduled_end_at:null,due_date:s.status==='cancelled'?null:s.draft.dueDate??null,end_date:null,start_time:null,end_time:null};
  const currentScope=(input:ToolFollowInput)=>{
    tool(input.toolId);
    if(!exact(input.scope,['kind','key'])||!['item','group'].includes(input.scope.kind)||!key(input.scope.key,input.scope.kind==='group'?80:240))return runtimeError('CONTRACT_INVALID','关注范围须为稳定事项键或分组键');
    return input.scope;
  };
  const summarize=(toolId:number,s:Source)=>{
    const l=link(toolId,s.draft.sourceKey),todo=l?.todo_id?deps.todos().get(Number(l.todo_id)):null;
    const following=!!activeRule(toolId,s)&&!l?.excluded;
    return {sourceKey:s.draft.sourceKey,todoId:todo?.id??null,status:!l?'missing':!todo?'deleted':todo.status,
      following,mode:following?(todo?.status==='done'?'completed':l?.follow_mode==='manual'?'manual':'follow'):'snapshot',
      sourceStatus:s.status,sourceRevision:s.revision,pendingSourceRevision:l&&l.applied_source_revision!==s.revision?s.revision:null};
  };
  const getState=(input:{toolId:number;sourceKeys?:string[]})=>readSnapshot(db,()=>{
    tool(input.toolId);
    if(input.sourceKeys!==undefined&&(!Array.isArray(input.sourceKeys)||input.sourceKeys.length>500||input.sourceKeys.some(k=>!key(k))))runtimeError('CONTRACT_INVALID','每次最多查询 500 个本工具来源键');
    const c=catalog(input.toolId),all=sources(input.toolId),selected=input.sourceKeys?all.filter(r=>input.sourceKeys!.includes(String(r.source_key))):all.slice(0,500);
    return {revision:c?Number(c.revision):0,sourceCount:all.length,truncated:!input.sourceKeys&&all.length>500,
      rules:rules(input.toolId).map(r=>({kind:r.kind,key:r.target_key,title:r.title,active:!!r.active})),items:selected.map(r=>summarize(input.toolId,source(r)))};
  });
  const preview=(input:ToolFollowInput)=>readSnapshot(db,()=>{
    const scope=currentScope(input),t=tool(input.toolId),c=catalog(input.toolId);
    if(!c)return runtimeError('CONTRACT_INVALID','工具尚未发布持续关注资料');
    const groups=JSON.parse(String(c.groups_json)) as Array<{key:string;title:string}>;
    const candidates=sources(input.toolId).map(source).filter(s=>scope.kind==='item'?s.draft.sourceKey===scope.key:s.groups.includes(scope.key)&&eligible(s))
      .sort((a,b)=>(a.draft.startAt??a.draft.dueDate??'9999').localeCompare(b.draft.startAt??b.draft.dueDate??'9999')||a.draft.sourceKey.localeCompare(b.draft.sourceKey));
    const title=scope.kind==='item'?candidates[0]?.draft.title:groups.find(g=>g.key===scope.key)?.title;
    if(!title)return runtimeError('CONTRACT_INVALID','来源事项或分组不存在，请刷新资料');
    const category=resolveToolTodoCategory(db,input.toolId,t.title,c.category_json?JSON.parse(String(c.category_json)):undefined);
    return {toolId:t.id,toolTitle:t.title,scope,title,revision:Number(c.revision),timezone:displayTimezone(db),category,
      active:!!rules(t.id).find(r=>r.active&&r.kind===scope.kind&&r.target_key===scope.key),
      items:candidates.map(s=>({...s.draft,...summarize(t.id,s)}))};
  });
  const reconcile=(toolId:number,s:Source)=>{
    const rule=activeRule(toolId,s);let l=link(toolId,s.draft.sourceKey);
    if(!rule||l?.excluded||l&&!l.todo_id)return {created:0,updated:0,protected:0};
    let created=0;
    if(!l){
      if(!eligible(s))return {created:0,updated:0,protected:0};
      const result=deps.toolTodos().create({toolId,category:JSON.parse(String(rule.category_json)),items:[s.draft]});
      created=result.created;l=link(toolId,s.draft.sourceKey)!;
    }
    const todo=deps.todos().get(Number(l.todo_id));
    if(db.prepare('SELECT 1 FROM plan_items WHERE todo_id=?').get(todo.id)||db.prepare("SELECT 1 FROM event_subscriptions WHERE todo_id=? AND status='active'").get(todo.id))return runtimeError('REFERENCE_CONFLICT','该待办已关联学习计划或其他订阅，不能接管');
    let mode=String(l.follow_mode);
    if(mode==='snapshot'){
      // 旧记录没有创建基线时采取保守策略，不能把用户现有内容当作可覆盖的来源。
      const expected=l.last_applied_json??managedSnapshot({...todo,...sourcePatch(s)} as typeof todo);
      mode=managedSnapshot(todo)===expected?'follow':'manual';
      db.prepare('UPDATE tool_todo_links SET follow_mode=? WHERE tool_id=? AND source_key=?').run(mode,toolId,s.draft.sourceKey);
    }
    if(mode==='manual'||todo.status==='done')return {created,updated:0,protected:1};
    if(mode==='follow'&&l.last_applied_json&&managedSnapshot(todo)!==l.last_applied_json){
      db.prepare("UPDATE tool_todo_links SET follow_mode='manual' WHERE tool_id=? AND source_key=?").run(toolId,s.draft.sourceKey);
      return {created,updated:0,protected:1};
    }
    const patch=sourcePatch(s);
    const next=managedSnapshot({...todo,...patch} as typeof todo)===managedSnapshot(todo)?todo:deps.managedWrite(()=>deps.todos().update(todo.id,patch));
    db.prepare("UPDATE tool_todo_links SET follow_mode='follow',last_applied_json=?,applied_source_revision=? WHERE tool_id=? AND source_key=?").run(managedSnapshot(next),s.revision,toolId,s.draft.sourceKey);
    return {created,updated:next.revision!==todo.revision?1:0,protected:0};
  };
  const publish=(input:{toolId:number;snapshot:ToolFollowSnapshot})=>inTx(db,()=>{
    const t=tool(input.toolId),snapshot=input.snapshot;
    if(!exact(snapshot,['schemaVersion','revision','groups','items','category'])||snapshot.schemaVersion!==1||!Number.isSafeInteger(snapshot.revision)||snapshot.revision<1||!Array.isArray(snapshot.items)||snapshot.items.length>500||Buffer.byteLength(canonical(snapshot))>TOOL_FOLLOW_BYTES)return runtimeError('CONTRACT_INVALID','来源清单须为 v1、正整数修订、最多 500 项且不超过 512 KiB');
    const groups=snapshot.groups??[];
    if(!Array.isArray(groups)||groups.length>200||groups.some(g=>!exact(g,['key','title'])||!key(g.key,80)||!key(g.title,80))||new Set(groups.map(g=>g.key)).size!==groups.length)return runtimeError('CONTRACT_INVALID','分组键和名称须唯一且不超过 80 字');
    if(snapshot.category)resolveToolTodoCategory(db,t.id,t.title,snapshot.category);
    const normalized=snapshot.items.map(item=>{
      const {groupKeys=[],sourceStatus='scheduled',...draft}=item;
      if(!Array.isArray(groupKeys)||groupKeys.length>20||groupKeys.some(k=>!groups.some(g=>g.key===k))||new Set(groupKeys).size!==groupKeys.length||!['scheduled','postponed','cancelled','finished'].includes(sourceStatus))return runtimeError('CONTRACT_INVALID','事项包含未知分组或来源状态');
      return {draft:normalizeToolTodoDraft(draft,displayTimezone(db)),groups:[...groupKeys].sort(),status:sourceStatus,revision:snapshot.revision};
    }).sort((a,b)=>a.draft.sourceKey.localeCompare(b.draft.sourceKey));
    if(new Set(normalized.map(s=>s.draft.sourceKey)).size!==normalized.length)return runtimeError('CONTRACT_INVALID','来源清单包含重复事项键');
    const category=snapshot.category?JSON.parse(JSON.stringify(snapshot.category)):null;
    const fingerprint=digest({items:normalized.map(({revision:_revision,...s})=>s),groups:[...groups].sort((a,b)=>a.key.localeCompare(b.key)),category}),old=catalog(t.id);
    if(old&&snapshot.revision<Number(old.revision))return runtimeError('REVISION_CONFLICT','来源修订已过期，拒绝旧页面覆盖');
    if(old&&snapshot.revision===old.revision){if(old.digest!==fingerprint)return runtimeError('REVISION_CONFLICT','同一来源修订不能提交不同内容');return {revision:snapshot.revision,created:0,updated:0,protected:0,unchanged:true};}
    const now=new Date().toISOString();
    db.prepare('INSERT INTO tool_follow_catalogs VALUES(?,?,?,?,?,?) ON CONFLICT(tool_id) DO UPDATE SET revision=excluded.revision,digest=excluded.digest,groups_json=excluded.groups_json,category_json=excluded.category_json,updated_at=excluded.updated_at').run(t.id,snapshot.revision,fingerprint,JSON.stringify(groups),category?JSON.stringify(category):null,now);
    const result={revision:snapshot.revision,created:0,updated:0,protected:0,unchanged:false};
    for(const s of normalized){
      const current=db.prepare('SELECT * FROM tool_follow_sources WHERE tool_id=? AND source_key=?').get(t.id,s.draft.sourceKey);
      const changed=!current||canonical({draft:source(current).draft,groups:source(current).groups,status:source(current).status})!==canonical({draft:s.draft,groups:s.groups,status:s.status});
      if(changed)db.prepare('INSERT INTO tool_follow_sources VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(tool_id,source_key) DO UPDATE SET draft_json=excluded.draft_json,groups_json=excluded.groups_json,source_status=excluded.source_status,revision=excluded.revision,updated_at=excluded.updated_at').run(identity(t.id,'source',s.draft.sourceKey),t.id,s.draft.sourceKey,JSON.stringify(s.draft),JSON.stringify(s.groups),s.status,s.revision,now);
      else s.revision=Number(current!.revision);
      const counts=reconcile(t.id,s);result.created+=counts.created;result.updated+=counts.updated;result.protected+=counts.protected;
    }
    return result;
  });
  const follow=(input:ToolFollowInput&{expectedRevision:number})=>inTx(db,()=>{
    const p=preview(input);
    if(input.expectedRevision!==p.revision)return runtimeError('REVISION_CONFLICT','来源资料已变化，请重新预览关注范围');
    if(p.scope.kind==='item'&&p.items[0]?.status==='deleted')return runtimeError('CONTRACT_INVALID','已删除的来源待办不重新关注或恢复');
    const {key:categoryKey,title,color}=p.category,category={key:categoryKey,title,color},now=new Date().toISOString();
    db.prepare('INSERT INTO tool_follow_rules VALUES(?,?,?,?,?,1,?,?,?,?) ON CONFLICT(tool_id,kind,target_key) DO UPDATE SET title=excluded.title,active=1,category_id=excluded.category_id,category_json=excluded.category_json,updated_at=excluded.updated_at').run(identity(p.toolId,p.scope.kind,p.scope.key),p.toolId,p.scope.kind,p.scope.key,p.title,p.category.id,JSON.stringify(category),now,now);
    if(p.scope.kind==='item')db.prepare('UPDATE tool_todo_links SET excluded=0 WHERE tool_id=? AND source_key=?').run(p.toolId,p.scope.key);
    const counts={created:0,updated:0,protected:0};
    for(const item of p.items){const s=source(db.prepare('SELECT * FROM tool_follow_sources WHERE tool_id=? AND source_key=?').get(p.toolId,item.sourceKey)!);const result=reconcile(p.toolId,s);counts.created+=result.created;counts.updated+=result.updated;counts.protected+=result.protected;}
    return {...counts,...getState({toolId:p.toolId})};
  });
  const unfollow=(input:ToolFollowInput)=>inTx(db,()=>{
    const scope=currentScope(input);
    db.prepare('UPDATE tool_follow_rules SET active=0,updated_at=? WHERE tool_id=? AND kind=? AND target_key=?').run(new Date().toISOString(),input.toolId,scope.kind,scope.key);
    if(scope.kind==='item'&&db.prepare('SELECT 1 FROM tool_follow_sources WHERE tool_id=? AND source_key=?').get(input.toolId,scope.key))db.prepare('INSERT INTO tool_todo_links(tool_id,source_key,todo_id,created_at,excluded) VALUES(?,?,NULL,?,1) ON CONFLICT(tool_id,source_key) DO UPDATE SET excluded=1').run(input.toolId,scope.key,new Date().toISOString());
    return getState({toolId:input.toolId});
  });
  const getTodo=(input:{todoId:number})=>readSnapshot(db,()=>{
    const l=db.prepare('SELECT * FROM tool_todo_links WHERE todo_id=? ORDER BY tool_id LIMIT 1').get(input.todoId);
    if(!l)return null;
    const row=db.prepare('SELECT * FROM tool_follow_sources WHERE tool_id=? AND source_key=?').get(l.tool_id,l.source_key);
    if(!row)return null;
    const s=source(row),state=summarize(Number(l.tool_id),s),t=tool(Number(l.tool_id));
    if(l.follow_mode==='snapshot'&&!state.following)return null;
    return {toolId:t.id,toolTitle:t.title,...state,source:s.draft,todoRevision:deps.todos().get(input.todoId).revision};
  });
  const resume=(input:{todoId:number;expectedSourceRevision:number;expectedTodoRevision:number})=>inTx(db,()=>{
    const current=getTodo({todoId:input.todoId});
    if(!current?.following)return runtimeError('SUBSCRIPTION_INACTIVE','该事项未持续关注，请先在工具中确认关注');
    if(current.sourceRevision!==input.expectedSourceRevision||current.todoRevision!==input.expectedTodoRevision)return runtimeError('REVISION_CONFLICT','来源或待办已变化，请重新打开详情');
    const todo=deps.todos().get(input.todoId);if(todo.status==='done')return {...current,protectedCompleted:true};
    db.prepare("UPDATE tool_todo_links SET follow_mode='follow',last_applied_json=? WHERE tool_id=? AND source_key=?").run(managedSnapshot(todo),current.toolId,current.sourceKey);
    reconcile(current.toolId,source(db.prepare('SELECT * FROM tool_follow_sources WHERE tool_id=? AND source_key=?').get(current.toolId,current.sourceKey)!));
    return {...getTodo({todoId:input.todoId}),protectedCompleted:false};
  });
  const stopTodo=(input:{todoId:number})=>{
    const current=getTodo(input);if(!current)return null;
    unfollow({toolId:current.toolId,scope:{kind:'item',key:current.sourceKey}});return getTodo(input);
  };
  return {publish,preview,follow,unfollow,getState,getTodo,resume,stopTodo};
}
export type ToolFollowingService=ReturnType<typeof createToolFollowingService>;
