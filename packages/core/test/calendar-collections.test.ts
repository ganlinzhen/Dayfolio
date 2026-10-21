import { afterEach, describe, expect, it } from 'vitest';
import { mkCore, type TestCtx } from './helpers';
import { provisionProvider } from './runtime-fixtures';

let ctx:TestCtx;
afterEach(()=>ctx?.cleanup());
const setup=()=>{
  ctx=mkCore();const core=ctx.core;
  core.runtime.setDisplayTimezone('Asia/Shanghai');
  const tool=core.tools.addTool({title:'阅读工具',entry_file:'index.html'});
  const batch=core.toolTodos.create({toolId:tool.id,items:[{sourceKey:'chapter:1',title:'读第一章',dueDate:'2026-11-01'}]});
  return {core,toolId:tool.id,id:batch.category!.id,todoId:batch.items[0].todoId!};
};
const range={fromDate:'2026-11-01',toDateExclusive:'2026-11-02',displayTimezone:'Asia/Shanghai'};

describe('共用日历分类管理',()=>{
  it('编辑保留身份和隐藏偏好，工具重复添加沿用用户名称和颜色',()=>{
    const {core,toolId,id}=setup();core.runtime.setVisibility({collectionId:id,visible:false});
    const revision=core.runtime.getRevision();
    const edited=core.calendar.updateCollection({collectionId:id,expectedTitle:'阅读工具',expectedColor:'blue',title:'  读书会  ',color:'rose'});
    expect(edited).toMatchObject({id,title:'读书会',color:'rose',visible:false,deleteBlockedReason:null});
    expect(core.runtime.getRevision()).toBeGreaterThan(revision);
    core.toolTodos.create({toolId,items:[{sourceKey:'chapter:2',title:'读第二章',dueDate:'2026-11-01'}]});
    expect(core.runtime.listCollections().find(c=>c.id===id)).toMatchObject({title:'读书会',color:'rose',visible:false});
    expect(core.calendar.queryItems(range).items).toEqual([]);
    core.runtime.setVisibility({collectionId:id,visible:true});
    expect(core.calendar.queryItems(range).items.every(i=>i.collectionId===id)).toBe(true);
    const unchanged=core.runtime.getRevision();
    core.runtime.updateCollection({collectionId:id,expectedTitle:'读书会',expectedColor:'rose',title:'读书会',color:'rose'});
    expect(core.runtime.getRevision()).toBe(unchanged);
  });
  it('删除保留已完成待办、日程、去重关联，并回到默认分类',()=>{
    const {core,toolId,id,todoId}=setup();core.todos.complete(todoId);
    const todo=core.todos.get(todoId), event=core.calendar.add({title:'讨论',date:'2026-11-01',note:'保留备注',color:'green'});
    // 仅隔离夹具安排分类，正式入口由分类业务命令维护。
    core.db.prepare('UPDATE calendar_events SET collection_id=? WHERE id=?').run(id,event.id);
    core.runtime.setVisibility({collectionId:'builtin.todo',visible:false});
    const removed=core.calendar.deleteCollection({collectionId:id,expectedTitle:'阅读工具'});
    expect(removed).toEqual({collectionId:id,movedTodos:1,movedEvents:1});
    expect(core.runtime.listCollections().some(c=>c.id===id)).toBe(false);
    expect(core.todos.get(todoId)).toMatchObject({title:todo.title,status:'done',completed_at:todo.completed_at,due_date:todo.due_date,collection_id:'builtin.todo'});
    expect(core.calendar.get(event.id)).toMatchObject({title:'讨论',note:'保留备注',color:'green'});
    expect(core.calendar.queryItems(range).items).toHaveLength(1);
    expect(core.calendar.queryItems(range).items[0].collectionId).toBe('builtin.local');
    expect(core.runtime.listCollections().find(c=>c.id==='builtin.todo')?.visible).toBe(false);
    expect(core.toolTodos.create({toolId,items:[{sourceKey:'chapter:1',title:'不覆盖'}]}).items[0]).toMatchObject({status:'done',todoId});
    expect(core.runtime.listCollections().some(c=>c.id===id)).toBe(false);
    core.toolTodos.preview({toolId,items:[{sourceKey:'chapter:2',title:'第二章'}]});
    expect(core.runtime.listCollections().some(c=>c.id===id)).toBe(false);
    expect(core.toolTodos.create({toolId,items:[{sourceKey:'chapter:2',title:'第二章'}]}).category?.id).toBe(id);
    expect(core.todos.get(todoId).collection_id).toBe('builtin.todo');
  });
  it('内置及来源分类拒绝删除，名称与颜色仍可编辑',()=>{
    const {core}=setup(),p=provisionProvider(core);
    for(const id of ['builtin.todo','builtin.study','builtin.local',p.collectionId]){
      const c=core.runtime.listCollections().find(c=>c.id===id)!;
      expect(c.deleteBlockedReason).toBeTruthy();
      expect(()=>core.runtime.deleteCollection({collectionId:id,expectedTitle:c.title})).toThrow('REFERENCE_CONFLICT');
    }
    expect(core.runtime.updateCollection({collectionId:'builtin.study',expectedTitle:'学习计划',expectedColor:'green',title:'学习',color:'amber'})).toMatchObject({id:'builtin.study',title:'学习',color:'amber'});
  });
  it('过期编辑或删除、非法名称及颜色不产生部分修改',()=>{
    const {core,id}=setup();const revision=core.runtime.getRevision();
    for(const patch of [{expectedTitle:'旧名称'},{expectedColor:'green'},{title:' '},{title:'字'.repeat(81)},{color:'red'}]){
      expect(()=>core.runtime.updateCollection({collectionId:id,expectedTitle:'阅读工具',expectedColor:'blue',title:'阅读',color:'green',...patch})).toThrow();
    }
    expect(()=>core.runtime.deleteCollection({collectionId:id,expectedTitle:'旧名称'})).toThrow('REVISION_CONFLICT');
    expect(core.runtime.getRevision()).toBe(revision);
  });
  it('写入动作被停用或删除失败时，分类和归属整体回滚',()=>{
    const {core,id,todoId}=setup();const input={collectionId:id,expectedTitle:'阅读工具'};
    core.ontology.updateActionType('update_todo',{status:'disabled'});
    expect(()=>core.runtime.deleteCollection(input)).toThrow('ACTION_DISABLED');
    core.ontology.updateActionType('update_todo',{status:'active'});
    core.db.exec("CREATE TRIGGER refuse_collection_delete BEFORE DELETE ON calendar_collections BEGIN SELECT RAISE(ABORT,'模拟删除失败'); END");
    const revision=core.runtime.getRevision();
    expect(()=>core.runtime.deleteCollection(input)).toThrow('模拟删除失败');
    expect(core.runtime.getRevision()).toBe(revision);
    expect(core.todos.get(todoId).collection_id).toBe(id);
    expect(core.runtime.listCollections().find(c=>c.id===id)?.visible).toBe(true);
    core.db.exec('DROP TRIGGER refuse_collection_delete');
    core.ontology.updateActionType('delete_calendar_collection',{status:'disabled'});
    expect(()=>core.calendar.deleteCollection(input)).toThrow('ACTION_DISABLED');
  });
});
