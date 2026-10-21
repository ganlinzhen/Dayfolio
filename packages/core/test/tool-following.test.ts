import { afterEach,describe,expect,it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname,join } from 'node:path';
import { mkCore,type TestCtx } from './helpers';
import type { ToolFollowSnapshot,ToolFollowSource } from '../src';

let ctx:TestCtx;
afterEach(()=>ctx?.cleanup());
const item=(sourceKey='one',extra:Partial<ToolFollowSource>={}):ToolFollowSource=>({sourceKey,title:'参加活动 '+sourceKey,startAt:'2099-11-04T04:00:00+08:00',groupKeys:['a','b'],...extra});
const snapshot=(revision=1,items=[item()]):ToolFollowSnapshot=>({schemaVersion:1,revision,groups:[{key:'a',title:'分组 A'},{key:'b',title:'分组 B'}],category:{key:'events',title:'活动',color:'violet'},items});
const setup=()=>{
  ctx=mkCore();const c=ctx.core;c.runtime.setDisplayTimezone('Asia/Shanghai');
  const t=c.tools.addTool({title:'通用活动页',entry_file:'index.html'});
  const publish=(s:ToolFollowSnapshot)=>c.toolFollowing.publish({toolId:t.id,snapshot:s});
  const follow=(kind:'item'|'group'='group',key='a')=>c.toolFollowing.follow({toolId:t.id,scope:{kind,key},expectedRevision:c.toolFollowing.getState({toolId:t.id}).revision});
  return {c,t,publish,follow};
};
describe('HTML 通用持续关注',()=>{
  it('发布、预览和取消预览都不创建待办或空分类，确认关注后才写入',()=>{
    const {c,t,publish,follow}=setup();const count=c.runtime.listCollections().length;
    publish(snapshot());const before=c.runtime.getRevision();
    expect(c.toolFollowing.preview({toolId:t.id,scope:{kind:'group',key:'a'}}).items).toHaveLength(1);
    expect(c.runtime.getRevision()).toBe(before);expect(c.todos.list()).toEqual([]);expect(c.runtime.listCollections()).toHaveLength(count);
    expect(follow().created).toBe(1);expect(c.runtime.listCollections()).toHaveLength(count+1);
    expect(c.toolFollowing.getState({toolId:t.id}).items[0]).toMatchObject({following:true,mode:'follow',status:'open'});
  });
  it('单项与多个分组关注复用快照待办，来源改期只同步标题与时间',()=>{
    const {c,t,publish,follow}=setup();const draft=item();const {groupKeys:_groups,...plain}=draft;
    const first=c.toolTodos.create({toolId:t.id,items:[plain]}),id=first.items[0].todoId!;
    publish(snapshot());follow('item','one');follow('group','a');follow('group','b');
    c.todos.update(id,{notes:'私人备注',priority:'high',tags:['私人标签']});
    publish(snapshot(2,[item('one',{title:'来源更新标题',startAt:'2099-11-06T00:00:00Z',endAt:'2099-11-06T02:00:00Z'})]));
    expect(c.todos.list()).toHaveLength(1);expect(c.todos.get(id)).toMatchObject({title:'来源更新标题',scheduled_start_at:'2099-11-06T00:00:00.000Z',notes:'私人备注',priority:'high',tags:['私人标签']});
  });
  it('标题和排期手动接管、已完成及已删除记录全部受保护，未受影响的事项继续更新',()=>{
    const {c,t,publish,follow}=setup();publish(snapshot(1,[item('manual'),item('done'),item('deleted'),item('normal')]));follow();
    const states=c.toolFollowing.getState({toolId:t.id}).items,ids=Object.fromEntries(states.map(s=>[s.sourceKey,s.todoId!]));
    c.todos.update(ids.manual,{title:'我的标题',due_date:'2099-12-01',start_time:'10:00'});c.todos.complete(ids.done);c.todos.remove(ids.deleted);
    const personal=c.todos.get(ids.manual),done=c.todos.get(ids.done);
    publish(snapshot(2,['manual','done','deleted','normal'].map(k=>item(k,{title:'新的来源 '+k,startAt:'2099-11-08T01:00:00Z'}))));
    expect(c.todos.get(ids.manual)).toEqual(personal);expect(c.todos.get(ids.done)).toEqual(done);expect(c.todos.list()).toHaveLength(3);
    expect(c.todos.get(ids.normal).title).toBe('新的来源 normal');
    expect(c.toolFollowing.getState({toolId:t.id}).items.find(s=>s.sourceKey==='manual')?.mode).toBe('manual');
    expect(c.toolFollowing.getState({toolId:t.id}).items.find(s=>s.sourceKey==='deleted')?.status).toBe('deleted');
    expect(()=>c.toolFollowing.resume({todoId:ids.manual,expectedTodoRevision:personal.revision,expectedSourceRevision:1})).toThrow('REVISION_CONFLICT');
    c.toolFollowing.resume({todoId:ids.manual,expectedTodoRevision:personal.revision,expectedSourceRevision:2});
    expect(c.todos.get(ids.manual).title).toBe('新的来源 manual');
    expect(c.toolFollowing.resume({todoId:ids.done,expectedTodoRevision:done.revision,expectedSourceRevision:2}).protectedCompleted).toBe(true);
    expect(c.todos.get(ids.done)).toEqual(done);
  });
  it('取消单项阻止分组重新启用，取消全部分组保留已有待办并停止新增',()=>{
    const {c,t,publish,follow}=setup();publish(snapshot());follow();follow('group','b');
    c.toolFollowing.unfollow({toolId:t.id,scope:{kind:'item',key:'one'}});const before=c.todos.list()[0];
    publish(snapshot(2,[item('one',{title:'不应覆盖'}),item('two')]));expect(c.todos.get(before.id)).toEqual(before);expect(c.todos.list()).toHaveLength(2);
    c.toolFollowing.unfollow({toolId:t.id,scope:{kind:'group',key:'a'}});c.toolFollowing.unfollow({toolId:t.id,scope:{kind:'group',key:'b'}});
    publish(snapshot(3,[item('three')]));expect(c.todos.list()).toHaveLength(2);
  });
  it('空分组可关注，不提前创建分类，新增未来事项后自动加入；过去事项跳过',()=>{
    const {c,publish,follow}=setup();publish(snapshot(1,[]));expect(follow().created).toBe(0);expect(c.runtime.listCollections()).toHaveLength(3);
    publish(snapshot(2,[item('past',{startAt:'2000-01-01T00:00:00Z'}),item('future')]));expect(c.todos.list()).toHaveLength(1);expect(c.runtime.listCollections()).toHaveLength(4);
  });
  it('时间待定、取消和结束状态不编造时长、不自动删除或完成；遗漏旧事项保留',()=>{
    const {c,t,publish,follow}=setup();publish(snapshot());follow();const id=c.todos.list()[0].id;
    publish(snapshot(2,[item('one',{startAt:null,sourceStatus:'postponed'})]));expect(c.todos.get(id)).toMatchObject({due_date:null,scheduled_start_at:null,status:'open'});
    publish(snapshot(3,[item('one',{sourceStatus:'cancelled'})]));expect(c.todos.get(id).due_date).toBeNull();
    publish(snapshot(4,[]));expect(c.todos.list()).toHaveLength(1);expect(c.toolFollowing.getState({toolId:t.id}).items[0].sourceStatus).toBe('cancelled');
    publish(snapshot(5,[item('one',{sourceStatus:'finished'})]));expect(c.todos.get(id).status).toBe('open');
  });
  it('拒绝旧资料、同修订不同内容、重复键、非法字段及跨工具范围',()=>{
    const {c,t,publish}=setup();publish(snapshot(2));const revision=c.runtime.getRevision();
    expect(publish(snapshot(2)).unchanged).toBe(true);expect(c.runtime.getRevision()).toBe(revision);
    expect(()=>publish(snapshot(1))).toThrow('REVISION_CONFLICT');expect(()=>publish(snapshot(2,[item('other')]))).toThrow('REVISION_CONFLICT');
    expect(()=>publish(snapshot(3,[item(),item()]))).toThrow('CONTRACT_INVALID');
    expect(()=>publish(snapshot(3,[{...item(),toolId:999} as ToolFollowSource]))).toThrow('未知字段');
    const other=c.tools.addTool({title:'另一个工具',entry_file:'index.html'});
    expect(()=>c.toolFollowing.follow({toolId:other.id,scope:{kind:'group',key:'a'},expectedRevision:2})).toThrow();
    expect(()=>c.toolFollowing.follow({toolId:t.id,scope:{kind:'group',key:'a'},expectedRevision:1})).toThrow('REVISION_CONFLICT');
  });
  it('隐藏偏好保持，删除分类停止关注；删除工具保留个人待办',()=>{
    const {c,t,publish,follow}=setup();publish(snapshot());follow();const category=c.runtime.listCollections().find(g=>g.title==='活动')!;
    c.runtime.setVisibility({collectionId:category.id,visible:false});publish(snapshot(2,[item('two')]));expect(c.runtime.listCollections().find(g=>g.id===category.id)?.visible).toBe(false);
    c.runtime.deleteCollection({collectionId:category.id,expectedTitle:category.title});publish(snapshot(3,[item('three')]));expect(c.todos.list()).toHaveLength(2);expect(c.runtime.listCollections().some(g=>g.id===category.id)).toBe(false);
    c.tools.deleteTool(t.id);expect(c.todos.list()).toHaveLength(2);expect(c.db.prepare('SELECT * FROM tool_follow_rules').all()).toEqual([]);
  });
  it('动作停用时发布同步、来源修订、文件更新一起回滚',()=>{
    const {c,t,publish,follow}=setup();publish(snapshot());follow();const original=c.todos.list()[0];
    c.ontology.updateActionType('update_todo',{status:'disabled'});
    expect(()=>publish(snapshot(2,[item('one',{title:'失败更新'})]))).toThrow('ACTION_DISABLED');expect(c.toolFollowing.getState({toolId:t.id}).revision).toBe(1);expect(c.todos.get(original.id)).toEqual(original);
    c.ontology.updateActionType('update_todo',{status:'active'});
    const files=(s:ToolFollowSnapshot)=>[{name:'index.html',contentBase64:Buffer.from('<h1>活动</h1>').toString('base64')},{name:'dayfolio-follow.json',contentBase64:Buffer.from(JSON.stringify(s)).toString('base64')}];
    c.tools.updateTool(t.id,{files:files(snapshot(2))});
    const file=join(dirname(ctx.dbPath),'tools',String(t.id),'dayfolio-follow.json'),before=readFileSync(file,'utf8');
    c.ontology.updateActionType('publish_tool_follow_sources',{status:'disabled'});
    expect(()=>c.tools.updateTool(t.id,{files:files(snapshot(3))})).toThrow('ACTION_DISABLED');expect(readFileSync(file,'utf8')).toBe(before);expect(c.toolFollowing.getState({toolId:t.id}).revision).toBe(2);
    c.ontology.updateActionType('publish_tool_follow_sources',{status:'active'});
    expect(()=>c.tools.updateTool(t.id,{files:[files(snapshot(3))[0]]})).toThrow('保留来源清单');expect(readFileSync(file,'utf8')).toBe(before);
  });
  it('升级前缺少基线的快照采取保守接管，不覆盖旧个人安排',()=>{
    const {c,t,publish,follow}=setup();const {groupKeys:_group,...draft}=item();const id=c.toolTodos.create({toolId:t.id,items:[draft]}).items[0].todoId!;
    c.db.prepare('UPDATE tool_todo_links SET last_applied_json=NULL WHERE todo_id=?').run(id);
    c.todos.update(id,{title:'升级前的个人标题'});publish(snapshot());follow();
    expect(c.toolFollowing.getTodo({todoId:id})?.mode).toBe('manual');publish(snapshot(2,[item('one',{title:'新来源标题'})]));expect(c.todos.get(id).title).toBe('升级前的个人标题');
  });
});
