import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkCore, type TestCtx } from './helpers';
import type { ActionOperation } from '../src/ontology/types';
import { buildSync } from 'esbuild';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';

let ctx: TestCtx;
beforeEach(() => {
  ctx = mkCore();
  const c = ctx.core;
  c.ontology.createObjectType({ apiName: 'reading_entry', title: '阅读记录', properties: [{ apiName: 'title', dataType: 'string', nullable: false }, { apiName: 'status', dataType: 'enum', enumValues: ['done', 'pending'], nullable: false }] });
  c.ontology.updateObjectType('todo', { addProperties: [{ apiName: 'reading_id', dataType: 'string' }] });
  c.ontology.createLinkType({ apiName: 'reading_todos', title: '阅读复习', leftType: 'reading_entry', rightType: 'todo', cardinality: 'one_to_many', fkColumn: 'reading_id' });
  c.ontology.createActionType({ apiName: 'finish_reading', title: '完成阅读并安排复习', parameters: [{ name: 'title', dataType: 'string', required: true }], operations: [
    { kind: 'create_object', objectType: 'reading_entry', propertyMappings: { title: { source: { parameter: 'title' } }, status: { literal: 'done' } } },
    { kind: 'invoke_command', command: 'add_todo', params: { title: { source: { parameter: 'title' } }, notes: { result: { step: 0, path: ['objectId'] } } } },
    { kind: 'create_link', linkType: 'reading_todos', leftId: { result: { step: 0, path: ['objectId'] } }, rightId: { result: { step: 1, path: ['value', 'id'] } } },
  ] });
});
afterEach(() => ctx.cleanup());

describe('受限命令组合与执行一致性', () => {
  it('纯命令组合可按目标类型发现，并保留参数绑定', () => {
    const action = ctx.core.ontology.createActionType({ apiName: 'finish_todo_command', title: '组合完成待办', parameters: [{ name: 'todo_id', dataType: 'integer', required: true }], operations: [
      { kind: 'invoke_command', command: 'complete_todo', params: { id: { source: { parameter: 'todo_id' } } } },
    ] });
    expect(action.targetBindings).toEqual([{ objectType: 'todo', parameter: 'todo_id' }]);
  });

  it('阅读记录、业务待办和关联同一事务落库，引用前步真实主键', () => {
    const c = ctx.core;
    const result = c.actions.execute('finish_reading', { title: '复习本章' });
    expect(result.results).toHaveLength(3);
    const reading = c.objects.list('reading_entry').rows[0];
    const todo = c.todos.list({ status: 'all' })[0];
    expect(reading.status).toBe('done');
    expect(todo.notes).toBe(reading.id);
    expect(c.relations.list('reading_entry', reading.id, 'reading_todos', 'left').items[0].targetId).toBe(todo.id);
  });

  it('下游命令停用或结果路径缺失时前面的自定义写入全部回滚', () => {
    const c = ctx.core;
    c.ontology.updateActionType('add_todo', { status: 'disabled' });
    expect(() => c.actions.execute('finish_reading', { title: '必须回滚' })).toThrow(/ACTION_DISABLED/);
    expect(c.objects.count('reading_entry')).toBe(0);
    expect(c.todos.list({ status: 'all' })).toHaveLength(0);
    c.ontology.updateActionType('add_todo', { status: 'active' });
    c.ontology.createActionType({ apiName: 'bad_output', title: '结果缺失', parameters: [], operations: [
      { kind: 'create_object', objectType: 'reading_entry', propertyMappings: { title: { literal: '先创建' }, status: { literal: 'done' } } },
      { kind: 'invoke_command', command: 'add_todo', params: { title: { result: { step: 0, path: ['missing'] } } } },
    ] });
    expect(() => c.actions.execute('bad_output', {})).toThrow(/ACTION_RESULT_NOT_FOUND/);
    expect(c.objects.count('reading_entry')).toBe(0);
  });

  it('文件、人工命令及前向或原型路径引用在定义阶段拒绝', () => {
    const c = ctx.core;
    for (const command of ['import_course', 'add_tool', 'confirm_course_sample', 'review_media_version']) {
      expect(() => c.ontology.createActionType({ apiName: 'unsafe_action', title: '不允许组合', parameters: [], operations: [{ kind: 'invoke_command', command, params: {} }] })).toThrow(/ACTION_NOT_COMPOSABLE/);
    }
    for (const ref of [{ step: 1, path: ['objectId'] }, { step: 0, path: ['constructor'] }]) {
      const operations: ActionOperation[] = [{ kind: 'invoke_command', command: 'add_todo', params: { title: { result: ref } } }];
      expect(() => c.ontology.createActionType({ apiName: 'unsafe_action', title: '引用不合法', parameters: [], operations })).toThrow(/之前步骤|安全路径/);
    }
  });

  it('幂等请求返回同一执行，不重复创建；同键不同参数拒绝', () => {
    const c = ctx.core;
    const first = c.actions.execute('finish_reading', { title: '幂等复习' }, { idempotencyKey: 'reading-run-1' });
    const replay = c.actions.execute('finish_reading', { title: '幂等复习' }, { idempotencyKey: 'reading-run-1' });
    expect(replay.executionId).toBe(first.executionId);
    expect(replay.replayed).toBe(true);
    expect(c.objects.count('reading_entry')).toBe(1);
    expect(c.todos.list({ status: 'all' })).toHaveLength(1);
    expect(() => c.actions.execute('finish_reading', { title: '不同参数' }, { idempotencyKey: 'reading-run-1' })).toThrow(/IDEMPOTENCY_CONFLICT/);
    expect(c.actionRuns.list({ action: 'finish_reading' }).rows.filter(r => r.status === 'succeeded')).toHaveLength(1);
  });

  it('按对象读取修订后执行，过期修订拒绝且不覆盖另一入口的修改', () => {
    const c = ctx.core;
    const row = c.objects.insert('reading_entry', { title: '原文', status: 'pending' });
    const action = c.ontology.getTemplateAction('object', 'reading_entry', 'update');
    const preview = c.actions.preview(action.apiName, { id: row.id, values: { title: '新文' } });
    c.objects.update('reading_entry', row.id, { title: '另一个入口修改' });
    expect(() => c.actions.execute(action.apiName, { id: row.id, values: { title: '新文' } }, { expectedObjects: preview.targets, expectedDefinitionRevision: preview.definitionRevision })).toThrow(/REVISION_CONFLICT/);
    expect(c.objects.get('reading_entry', row.id)?.title).toBe('另一个入口修改');
  });

  it('两进程争用同一幂等键只有一次真实执行，重连后仍可重放', async () => {
    const module = join(dirname(ctx.dbPath), 'action-worker.cjs');
    buildSync({ entryPoints: [new URL('../src/index.ts', import.meta.url).pathname], outfile: module, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
    const signal = new SharedArrayBuffer(4);
    const gate = new Int32Array(signal);
    let ready = 0;
    const worker = () => new Promise<{ id: string; replayed: boolean }>((resolve, reject) => {
      const w = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
        const {createCore,openNodeSqliteDb}=require(workerData.module);const db=openNodeSqliteDb(workerData.path);
        try {const c=createCore(db,{dbPath:workerData.path});parentPort.postMessage({ready:true});
          const gate=new Int32Array(workerData.signal);Atomics.wait(gate,0,0,10000);
          const result=c.actions.execute('finish_reading',{title:'并发幂等'},{idempotencyKey:'concurrent-key'});
          parentPort.postMessage({id:result.executionId,replayed:result.replayed===true});
        } catch(e){parentPort.postMessage({error:e.message});}finally{db.close();}`, { eval: true, workerData: { module, path: ctx.dbPath, signal } });
      let result: { id: string; replayed: boolean } | undefined;
      const timeout = setTimeout(() => { void w.terminate(); reject(new Error('并发执行超时')); }, 15000);
      w.on('message', message => {
        if (message.ready) { if (++ready === 2) { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0, 2); } }
        else if (message.error) reject(new Error(message.error));
        else result = message;
      });
      w.on('error', reject);
      w.on('exit', code => { clearTimeout(timeout); if (code || !result) reject(new Error('并发执行器异常退出')); else resolve(result); });
    });
    const results = await Promise.all([worker(), worker()]);
    expect(new Set(results.map(r => r.id)).size).toBe(1);
    expect(results.filter(r => r.replayed)).toHaveLength(1);
    expect(ctx.core.objects.count('reading_entry')).toBe(1);
    expect(ctx.core.actions.execute('finish_reading', { title: '并发幂等' }, { idempotencyKey: 'concurrent-key' }).replayed).toBe(true);
  });

  it('非事务文件/任务命令不接受通用幂等选项，审计也不保存认领凭证', () => {
    const c = ctx.core;
    const task = c.news.createTask({ title: '审计凭据边界' });
    expect(() => c.actions.execute('claim_news_task', { task_id: task.id }, { idempotencyKey: 'not-atomic' })).toThrow(/ACTION_NOT_ATOMIC/);
    const claimed = c.actions.execute('claim_news_task', { task_id: task.id });
    expect(claimed.result).toHaveProperty('claim_token');
    expect(c.db.prepare('SELECT result_json FROM ont_action_executions WHERE id=?').get(claimed.executionId)?.result_json).toBeNull();
    expect(c.actionRuns.get(claimed.executionId!)).not.toHaveProperty('result_json');
    expect(() => c.queries.list({ version: 1, objectType: 'action_execution', select: ['result_json'] })).toThrow(/FIELD_NOT_READABLE/);
    expect(() => c.objects.insert('action_execution', { action_name: '伪造记录' })).toThrow(/WRITE_REQUIRES_ACTION/);
  });
});
