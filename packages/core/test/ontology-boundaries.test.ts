import { afterEach, describe, expect, it } from 'vitest';
import { mkCore, type TestCtx } from './helpers';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

let ctx: TestCtx;
afterEach(() => ctx?.cleanup());
describe('本体公开写边界', () => {
  it('系统状态不能裸写，用户扩展字段可以更新', () => {
    ctx = mkCore(); const c = ctx.core;
    const todo = c.todos.add({ title: '完成入口一致性' });
    expect(() => c.objects.update('todo', todo.id, { status: 'done' })).toThrow(/WRITE_REQUIRES_ACTION/);
    expect(c.todos.get(todo.id).status).toBe('open');
    c.ontology.updateObjectType('todo', { addProperties: [{ apiName: 'memo', dataType: 'string' }] });
    expect(c.objects.update('todo', todo.id, { memo: '复盘' }).memo).toBe('复盘');
    expect(() => c.objects.update('todo', todo.id, { memo: '错误', status: 'done' })).toThrow();
    expect(c.objects.get('todo', todo.id)?.memo).toBe('复盘');
  });
  it('动作停用约束专用服务和状态更新别名', () => {
    ctx = mkCore(); const c = ctx.core; const todo = c.todos.add({ title: '启停一致性' });
    c.ontology.updateActionType('complete_todo', { status: 'disabled' });
    expect(() => c.todos.complete(todo.id)).toThrow(/ACTION_DISABLED/);
    expect(() => c.todos.update(todo.id, { status: 'done' })).toThrow(/ACTION_DISABLED/);
    expect(c.todos.get(todo.id).status).toBe('open');
  });
  it('已有课程、知识库、自媒体登记，任务凭据不能通用读取', () => {
    ctx = mkCore(); const c = ctx.core;
    for (const t of ['course', 'course_lesson', 'vault_note', 'media_content', 'media_metric', 'news_task']) {
      expect(c.ontology.getObjectType(t).isSystem).toBe(true);
      expect(c.objects.list(t).total).toBe(0);
    }
    const task = c.news.createTask({ title: '令牌保护' });
    c.news.claimTask(task.id, '隔离测试');
    expect(c.objects.get('news_task', task.id)).not.toHaveProperty('claim_token');
    expect(() => c.objects.list('news_task', { where: [{ property: 'claim_token', op: 'eq', value: 'x' }] })).toThrow();
  });
  it('组合完成遇到打卡或待办停用时整体回滚',()=>{
    ctx=mkCore();const c=ctx.core;
    const plan=c.plans.create({title:'组合动作',start_date:'2026-10-13',end_date:'2026-10-13',items:[{date:'2026-10-13',content:'学习'}]});
    const item=plan.items[0];c.ontology.updateActionType('complete_todo',{status:'disabled'});
    expect(()=>c.plans.updateItemStatus(item.id,'done')).toThrow(/ACTION_DISABLED/);
    expect(c.plans.getItem(item.id).status).toBe('pending');expect(c.checkins.list()).toHaveLength(0);
    c.ontology.updateActionType('complete_todo',{status:'active'});c.ontology.updateActionType('checkin',{status:'disabled'});
    expect(()=>c.todos.complete(item.todo_id!)).toThrow(/ACTION_DISABLED/);expect(c.todos.get(item.todo_id!).status).toBe('open');
  });
  it('共享输入契约拒绝未知嵌套字段和非法枚举，不写入数据',()=>{
    ctx=mkCore();const c=ctx.core;
    expect(()=>c.commands.execute('add_media_content',{input:{title:'非法字段',approved:true}})).toThrow(/未知字段/);
    expect(()=>c.commands.execute('add_media_material',{input:{title:'非法枚举',kind:'video'}})).toThrow(/素材类型/);
    expect(c.objects.count('media_content')).toBe(0);expect(c.objects.count('media_material')).toBe(0);
    expect(c.ontology.getActionType('add_media_content').parameters[0].jsonSchema).toHaveProperty('properties.title');
  });
  it('工具删除在数据库提交失败时恢复记录和文件',()=>{
    ctx=mkCore();const c=ctx.core;const html='<html><body>保留旧工具</body></html>';
    const tool=c.tools.addTool({title:'恢复测试',entry_file:'index.html',files:[{name:'index.html',contentBase64:Buffer.from(html).toString('base64')}]});
    const file=join(dirname(ctx.dbPath),'tools',String(tool.id),'index.html');
    c.db.exec('CREATE TABLE deferred_tool_ref(tool_id INTEGER REFERENCES tools(id) DEFERRABLE INITIALLY DEFERRED)');
    c.db.prepare('INSERT INTO deferred_tool_ref(tool_id) VALUES(?)').run(tool.id);
    expect(()=>c.tools.deleteTool(tool.id)).toThrow();
    expect(c.tools.getTool(tool.id).title).toBe('恢复测试');expect(existsSync(file)).toBe(true);expect(readFileSync(file,'utf8')).toBe(html);
  });
});
