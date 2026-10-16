import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCore, openNodeSqliteDb } from '../src';
import { mkCore, type TestCtx } from './helpers';

let ctx: TestCtx;
beforeEach(() => { ctx = mkCore(); ctx.core.ontology.createObjectType({ apiName: 'reading_entry', title: '阅读记录', properties: [
  { apiName: 'title', dataType: 'string', nullable: false }, { apiName: 'minutes', dataType: 'integer' }, { apiName: 'note', dataType: 'string' },
] }); });
afterEach(() => ctx.cleanup());

describe('持久化基础动作与旧写入口', () => {
  it('基础动作可发现，创建/编辑/删除的旧入口都经过动作停用检查', () => {
    const c = ctx.core;
    const create = c.ontology.getTemplateAction('object', 'reading_entry', 'create');
    expect(create.template?.version).toBe(1);
    expect(create.targetBindings).toEqual([{ objectType: 'reading_entry' }]);
    const row = c.objects.insert('reading_entry', { title: '读书', minutes: 20 });
    const update = c.ontology.getTemplateAction('object', 'reading_entry', 'update');
    c.ontology.updateActionType(update.apiName, { status: 'disabled' });
    expect(() => c.objects.update('reading_entry', row.id, { minutes: 30 })).toThrow(/ACTION_DISABLED/);
    c.ontology.updateActionType(update.apiName, { status: 'active' });
    expect(c.objects.update('reading_entry', row.id, { note: null }).minutes).toBe(20);
    expect(() => c.objects.update('reading_entry', row.id, { unknown: true })).toThrow(/未知字段/);
    const remove = c.ontology.getTemplateAction('object', 'reading_entry', 'delete');
    c.ontology.updateActionType(remove.apiName, { status: 'disabled' });
    expect(() => c.objects.remove('reading_entry', row.id)).toThrow(/ACTION_DISABLED/);
    expect(() => c.ontology.deleteActionType(create.apiName)).toThrow(/不可删除|停用/);
  });

  it('动作模板升级保留停用与用户命名，不覆盖同名自定义动作', () => {
    const c = ctx.core;
    c.ontology.createActionType({ apiName: 'object_collision_create', title: '用户已有动作', parameters: [], operations: [] });
    c.ontology.createObjectType({ apiName: 'collision', title: '名称冲突夹具', properties: [{ apiName: 'title', dataType: 'string' }] });
    expect(c.ontology.getActionType('object_collision_create').title).toBe('用户已有动作');
    expect(c.ontology.getTemplateAction('object', 'collision', 'create').apiName).not.toBe('object_collision_create');
    const action = c.ontology.getTemplateAction('object', 'reading_entry', 'update');
    c.ontology.updateActionType(action.apiName, { title: '我自己的编辑名称', status: 'disabled' });
    c.ontology.updateObjectType('reading_entry', { addProperties: [{ apiName: 'rating', dataType: 'integer' }] });
    const db = openNodeSqliteDb(ctx.dbPath);
    try {
      const other = createCore(db, { dbPath: ctx.dbPath });
      expect(other.ontology.getTemplateAction('object', 'reading_entry', 'update')).toMatchObject({ apiName: action.apiName, title: '我自己的编辑名称', status: 'disabled' });
      expect(other.ontology.getTemplateAction('object', 'reading_entry', 'update').parameters.find(p => p.name === 'values')?.jsonSchema).toHaveProperty('properties.rating');
      expect(other.ontology.listActionTypes().filter(a => a.template?.targetName === 'reading_entry')).toHaveLength(3);
    } finally { db.close(); }
  });

  it('扩展字段模板不能混入系统核心字段，关系旧入口也服从动作启停', () => {
    const c = ctx.core;
    c.ontology.updateObjectType('todo', { addProperties: [{ apiName: 'reading_id', dataType: 'string' }] });
    const todo = c.todos.add({ title: '业务待办' });
    const row = c.objects.insert('reading_entry', { title: '阅读' });
    c.ontology.createLinkType({ apiName: 'reading_todos', title: '阅读待办', leftType: 'reading_entry', rightType: 'todo', cardinality: 'one_to_many', fkColumn: 'reading_id' });
    expect(() => c.objects.update('todo', todo.id, { reading_id: row.id, status: 'done' })).toThrow(/WRITE_REQUIRES_ACTION/);
    const linkAction = c.ontology.getTemplateAction('link', 'reading_todos', 'create');
    c.ontology.updateActionType(linkAction.apiName, { status: 'disabled' });
    expect(() => c.relations.create('reading_todos', row.id, todo.id)).toThrow(/ACTION_DISABLED/);
    c.ontology.updateActionType(linkAction.apiName, { status: 'active' });
    expect(c.relations.create('reading_todos', row.id, todo.id).changes).toBe(1);
    expect(c.relations.create('reading_todos', row.id, todo.id).changes).toBe(0);
    expect(() => c.objects.updateBy('reading_entry', 'title', '阅读', { title: '绕过' })).toThrow(/WRITE_REQUIRES_ACTION/);
  });

  it('删除类型和关系只清理自己的基础动作，用户动作引用仍受保护', () => {
    const c = ctx.core;
    c.ontology.deleteObjectType('reading_entry');
    expect(c.ontology.listActionTypes().some(a => a.template?.targetName === 'reading_entry')).toBe(false);
    expect(c.ontology.getActionType('add_todo').isBuiltin).toBe(true);
  });

  it('可不生成基础动作，显式自定义 Action 仍按自身定义执行', () => {
    const c = ctx.core;
    c.ontology.createObjectType({ apiName: 'no_template', title: '自行定义动作', generateActions: false, properties: [{ apiName: 'title', dataType: 'string' }] });
    expect(() => c.objects.insert('no_template', { title: '不走模板' })).toThrow(/WRITE_REQUIRES_ACTION/);
    c.ontology.createActionType({ apiName: 'write_no_template', title: '明确自定义动作', parameters: [], operations: [{ kind: 'create_object', objectType: 'no_template', propertyMappings: { title: { literal: '独立动作' } } }] });
    expect(c.actions.execute('write_no_template', {}).results).toHaveLength(1);
    expect(c.objects.count('no_template')).toBe(1);
  });

  it('结构化动作参数拒绝未知嵌套字段，缺省与显式 null 分开', () => {
    const c = ctx.core;
    c.ontology.createActionType({ apiName: 'validated_reading', title: '结构化阅读', parameters: [{ name: 'input', dataType: 'json', required: true, jsonSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } }], operations: [
      { kind: 'create_object', objectType: 'reading_entry', propertyMappings: { title: { literal: '校验后创建' } } },
    ] });
    expect(() => c.actions.execute('validated_reading', { input: { title: '有效', approved: true } })).toThrow(/未知字段/);
    expect(c.objects.count('reading_entry')).toBe(0);
    expect(c.actions.execute('validated_reading', { input: { title: '有效' } }).results).toHaveLength(1);
    expect(() => c.ontology.createActionType({ apiName: 'unsupported_schema', title: '不支持的 schema', parameters: [{ name: 'input', dataType: 'json', jsonSchema: { pattern: '.*' } }], operations: [] })).toThrow(/不支持/);
  });
});
