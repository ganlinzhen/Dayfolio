import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkCore, type TestCtx } from './helpers';
import { createCore, openNodeSqliteDb } from '../src';
import { createQueryService } from '../src/ontology/query';

let ctx: TestCtx;
beforeEach(() => {
  ctx = mkCore();
  ctx.core.ontology.createObjectType({ apiName: 'query_item', title: '查询夹具', properties: [
    { apiName: 'title', dataType: 'string', nullable: false },
    { apiName: 'note', dataType: 'string' },
    { apiName: 'active', dataType: 'boolean', nullable: false },
    { apiName: 'score', dataType: 'float' },
    { apiName: 'tags', dataType: 'json' },
    { apiName: 'date', dataType: 'date' },
  ] });
  for (const values of [
    { id: 'a', title: '包含 100%_ 字面量', active: true, score: 10, tags: ['甲'], date: '2026-10-01' },
    { id: 'b', title: '另一条', note: '有备注', active: false, score: 10, tags: [], date: '2026-10-02' },
    { id: 'c', title: '第三条', active: true, score: null, tags: null, date: null },
  ]) ctx.core.objects.insert('query_item', values);
});
afterEach(() => ctx.cleanup());

const query = (extra: Record<string, unknown> = {}) => ({ version: 1, objectType: 'query_item', ...extra });

describe('统一查询 v1：公开合同', () => {
  it('字段投影保留主键，新 JSON 解析与旧通用返回并存', () => {
    const result = ctx.core.queries.list(query({ select: ['title', 'tags'], includeTotal: true }));
    expect(result.contractVersion).toBe(1);
    expect(result.total).toBe(3);
    expect(result.rows.find(r => r.id === 'a')).toEqual({ id: 'a', title: '包含 100%_ 字面量', tags: ['甲'] });
    expect(ctx.core.objects.get('query_item', 'a')?.tags).toBe('["甲"]');
    expect(ctx.core.queries.get(query({ id: 'a', select: ['active'] }))).toEqual({ id: 'a', active: true });
    expect(ctx.core.queries.get(query({ id: 'missing' }))).toBeNull();
  });

  it('AND/OR/NOT、NULL 与布尔过滤在同一语义中执行', () => {
    const result = ctx.core.queries.list(query({ where: { and: [
      { property: 'active', op: 'eq', value: true },
      { or: [{ property: 'note', op: 'eq', value: null }, { not: { property: 'score', op: 'gte', value: 5 } }] },
    ] } }));
    expect(result.rows.map(r => r.id)).toEqual(['c', 'a']);
    expect(ctx.core.queries.list(query({ where: { property: 'note', op: 'ne', value: null } })).rows.map(r => r.id)).toEqual(['b']);
  });

  it('in 只接受类型一致的数组，空数组无匹配，contains 按字面匹配', () => {
    expect(ctx.core.queries.list(query({ where: { property: 'id', op: 'in', value: ['a', 'c'] } })).rows.map(r => r.id)).toEqual(['c', 'a']);
    expect(ctx.core.queries.list(query({ where: { property: 'id', op: 'in', value: [] } })).rows).toEqual([]);
    expect(ctx.core.queries.list(query({ where: { property: 'title', op: 'contains', value: '%_' } })).rows.map(r => r.id)).toEqual(['a']);
    expect(() => ctx.core.queries.list(query({ where: { property: 'score', op: 'in', value: ['10'] } }))).toThrow(/QUERY_INVALID/);
  });

  it('多字段排序统一 NULL 位置并补主键，分页信息真实', () => {
    const result = ctx.core.queries.list(query({ orderBy: [{ property: 'score', direction: 'asc', nulls: 'last' }], page: { limit: 1, offset: 0 }, includeTotal: true }));
    expect(result.rows[0].id).toBe('b');
    expect(result.page).toEqual({ limit: 1, offset: 0, hasMore: true });
    expect(result.total).toBe(3);
  });

  it('未知参数、字段、运算符、类型、日期及超限都明确拒绝', () => {
    for (const input of [query({ unsafe: true }), query({ select: ['missing'] }), query({ where: { property: 'score', op: 'raw', value: 1 } }),
      query({ where: { property: 'active', op: 'eq', value: 1 } }), query({ where: { property: 'date', op: 'eq', value: '2026-02-30' } }),
      query({ page: { limit: 501 } }), query({ page: { offset: -1 } }), query({ orderBy: [{ property: 'tags' }] }),
    ]) expect(() => ctx.core.queries.list(input)).toThrow(/QUERY_INVALID/);
    expect(() => ctx.core.queries.get({ version: 1, objectType: 'todo', id: '1' })).toThrow(/QUERY_INVALID/);
  });

  it('敏感字段在读取、过滤和排序中均不可使用，虚拟类型明确拒绝', () => {
    const task = ctx.core.news.createTask({ title: '敏感字段夹具' });
    ctx.core.news.claimTask(task.id, 'query-test');
    for (const extra of [{ select: ['claim_token'] }, { where: { property: 'claim_token', op: 'is_null' } }, { orderBy: [{ property: 'claim_token' }] }]) {
      expect(() => ctx.core.queries.list({ version: 1, objectType: 'news_task', ...extra })).toThrow(/FIELD_NOT_READABLE/);
    }
    expect(() => ctx.core.queries.list({ version: 1, objectType: 'day' })).toThrow(/QUERY_UNSUPPORTED/);
  });

  it('非法存量 JSON 不能静默伪造，读事务在异常后释放', () => {
    ctx.core.db.prepare('UPDATE ont_obj_query_item SET tags=? WHERE id=?').run('{broken', 'a');
    expect(() => ctx.core.queries.list(query())).toThrow(/DATA_VALUE_INVALID/);
    ctx.core.objects.insert('query_item', { title: '异常后仍可写', active: true });
    expect(ctx.core.objects.count('query_item')).toBe(4);
  });

  it('混合时区时间戳与非法数值在比较/聚合前诊断，不把坏值默认为零', () => {
    ctx.core.db.prepare('UPDATE ont_obj_query_item SET score=? WHERE id=?').run('不是数字', 'a');
    expect(() => ctx.core.queries.aggregate(query({ metrics: [{ op: 'sum', property: 'score', as: 'n' }] }))).toThrow(/DATA_VALUE_INVALID/);
    ctx.core.db.prepare('UPDATE ont_obj_query_item SET score=?,created_at=? WHERE id=?').run(10, '2026-10-16T00:00:00.000Z', 'a');
    expect(() => ctx.core.queries.list(query({ orderBy: [{ property: 'created_at' }] }))).toThrow(/DATA_VALUE_INVALID/);
    ctx.core.db.prepare('UPDATE ont_obj_query_item SET created_at=? WHERE id=?').run('2026-02-30T24:00:00.000', 'a');
    expect(() => ctx.core.queries.list(query({ orderBy: [{ property: 'created_at' }] }))).toThrow(/DATA_VALUE_INVALID/);
    expect(ctx.core.queries.list(query({ select: ['title'] })).rows).toHaveLength(3);
  });

  it('能力发现描述受支持操作和查询限制，不暴露不可读字段', () => {
    const contract = ctx.core.queries.describe('query_item');
    expect(contract.version).toBe(1);
    expect(contract.limits.pageSize).toBe(500);
    expect(contract.properties.find(p => p.apiName === 'tags')?.sortable).toBe(false);
    expect(ctx.core.queries.describe('news_task').properties.some(p => p.apiName === 'claim_token')).toBe(false);
  });

  it('计数后另一连接可提交写入，而当前行列表保持相同读快照', () => {
    const otherDb = openNodeSqliteDb(ctx.dbPath);
    try {
      const other = createCore(otherDb, { dbPath: ctx.dbPath });
      let inserted = false;
      const statements: string[] = [];
      const reader = createQueryService({ ...ctx.core.db,
        exec: sql => { statements.push(sql); ctx.core.db.exec(sql); },
        prepare: sql => {
          const statement = ctx.core.db.prepare(sql);
          return { ...statement, get: (...params) => {
            const result = statement.get(...params);
            if (sql.includes('COUNT(*)') && !inserted) { inserted = true; other.objects.insert('query_item', { title: '并发新增', active: true }); }
            return result;
          } };
        },
      }, ctx.core.ontology);
      const result = reader.list(query({ includeTotal: true }));
      expect(result.total).toBe(3);
      expect(result.rows).toHaveLength(3);
      expect(ctx.core.objects.count('query_item')).toBe(4);
      expect(statements).toEqual(['BEGIN', 'COMMIT']);
    } finally { otherDb.close(); }
  });
});

describe('统一查询：分组聚合与关系', () => {
  it('有限浮点溢出和不安全整数聚合明确报错，异常后事务释放', () => {
    const c = ctx.core;
    c.objects.update('query_item', 'a', { score: 1e308 });
    c.objects.update('query_item', 'b', { score: 1e308 });
    expect(() => c.queries.aggregate(query({ metrics: [{ op: 'sum', property: 'score', as: 'n' }] }))).toThrow(/QUERY_RESULT_OUT_OF_RANGE/);
    c.ontology.createObjectType({ apiName: 'large_integer', title: '大整数', properties: [{ apiName: 'n', dataType: 'integer' }] });
    for (let i = 0; i < 2; i++) c.objects.insert('large_integer', { n: Number.MAX_SAFE_INTEGER });
    expect(() => c.queries.aggregate({ version: 1, objectType: 'large_integer', metrics: [{ op: 'sum', property: 'n', as: 'n' }] })).toThrow(/QUERY_RESULT_OUT_OF_RANGE/);
    c.objects.insert('query_item', { title: '异常后可写', active: true });
    expect(c.objects.count('query_item')).toBe(4);
  });

  it('统计 NULL、空集合和分组，并区分对象数、组数及当前组页', () => {
    const all = ctx.core.queries.aggregate(query({ metrics: [
      { op: 'count', as: 'n' }, { op: 'count', property: 'score', as: 'scored' },
      { op: 'sum', property: 'score', as: 'sum' }, { op: 'avg', property: 'score', as: 'avg' },
      { op: 'min', property: 'title', as: 'first_title' }, { op: 'max', property: 'score', as: 'max' },
    ] }));
    expect(all.objectCount).toBe(3);
    expect(all.groupCount).toBe(1);
    expect(all.rows[0].metrics).toMatchObject({ n: 3, scored: 2, sum: 20, avg: 10, max: 10 });
    const grouped = ctx.core.queries.aggregate(query({ groupBy: ['score'], metrics: [{ op: 'count', as: 'n' }],
      having: { property: 'n', op: 'gte', value: 1 }, orderBy: [{ metric: 'n', direction: 'desc' }], page: { limit: 1 } }));
    expect(grouped.objectCount).toBe(3);
    expect(grouped.groupCount).toBe(2);
    expect(grouped.page.hasMore).toBe(true);
    expect(grouped.rows).toEqual([{ dimensions: { score: 10 }, metrics: { n: 2 } }]);
    const empty = ctx.core.queries.aggregate(query({ where: { property: 'id', op: 'in', value: [] }, metrics: [{ op: 'count', as: 'n' }, { op: 'sum', property: 'score', as: 'sum' }] }));
    expect(empty.rows).toEqual([{ dimensions: {}, metrics: { n: 0, sum: null } }]);
    expect(ctx.core.queries.aggregate(query({ groupBy: ['active'], metrics: [{ op: 'count', as: 'n' }] })).rows.some(r => r.dimensions.active === true)).toBe(true);
  });

  it('聚合、分组、having 和排序不能绕过字段与别名校验', () => {
    for (const extra of [
      { metrics: [{ op: 'sum', property: 'title', as: 'n' }] },
      { groupBy: ['tags'], metrics: [{ op: 'count', as: 'n' }] },
      { metrics: [{ op: 'count', as: 'x); DROP TABLE todos;' }] },
      { metrics: [{ op: 'count', as: 'n' }], having: { property: 'missing', op: 'eq', value: 1 } },
      { metrics: [{ op: 'count', as: 'n' }], orderBy: [{ metric: 'missing' }] },
    ]) expect(() => ctx.core.queries.aggregate(query(extra))).toThrow(/QUERY_INVALID|QUERY_UNSUPPORTED/);
    for (const extra of [{ groupBy: ['claim_token'], metrics: [{ op: 'count', as: 'n' }] }, { metrics: [{ op: 'count', property: 'claim_token', as: 'n' }] }]) {
      expect(() => ctx.core.queries.aggregate({ version: 1, objectType: 'news_task', ...extra })).toThrow(/FIELD_NOT_READABLE/);
    }
  });

  it('单跳 N:M 双向筛选与读取不重复根对象，也不重复聚合计数', () => {
    const c = ctx.core;
    c.ontology.createObjectType({ apiName: 'query_tag', title: '标签', properties: [{ apiName: 'title', dataType: 'string' }] });
    c.ontology.createObjectType({ apiName: 'query_edge', title: '关联', properties: [{ apiName: 'item_id', dataType: 'string' }, { apiName: 'tag_id', dataType: 'string' }] });
    c.ontology.createLinkType({ apiName: 'query_item_tags', title: '标签关系', leftType: 'query_item', rightType: 'query_tag', cardinality: 'many_to_many', linkTable: 'query_edge', backingLeftProperty: 'item_id', backingRightProperty: 'tag_id' });
    for (const id of ['t1', 't2']) {
      c.objects.insert('query_tag', { id, title: `匹配 ${id}` });
      c.relations.create('query_item_tags', 'a', id);
    }
    const where = { related: { linkType: 'query_item_tags', side: 'left', where: { property: 'title', op: 'contains', value: '匹配' } } };
    expect(c.queries.list(query({ where })).rows.map(r => r.id)).toEqual(['a']);
    expect(c.queries.aggregate(query({ where, metrics: [{ op: 'count', as: 'n' }] })).rows[0].metrics.n).toBe(1);
    const related = c.queries.related({ version: 1, objectType: 'query_item', id: 'a', linkType: 'query_item_tags', side: 'left', select: ['title'], includeTotal: true });
    expect(related.total).toBe(2);
    expect(related.rows.map(r => r.id)).toEqual(['t2', 't1']);
    expect(c.queries.related({ version: 1, objectType: 'query_tag', id: 't1', linkType: 'query_item_tags', side: 'right' }).rows.map(r => r.id)).toEqual(['a']);
    expect(c.queries.list(query({ where: { related: { linkType: 'query_item_tags', side: 'left', exists: false } } })).rows.map(r => r.id)).toEqual(['c', 'b']);
  });

  it('一对多、系统多态引用与方向匹配，拒绝二跳和虚拟对端', () => {
    const c = ctx.core;
    c.ontology.createObjectType({ apiName: 'query_parent', title: '父对象', properties: [{ apiName: 'title', dataType: 'string' }] });
    c.ontology.updateObjectType('query_item', { addProperties: [{ apiName: 'parent_id', dataType: 'string' }] });
    c.ontology.createLinkType({ apiName: 'query_parent_items', title: '一对多', leftType: 'query_parent', rightType: 'query_item', cardinality: 'one_to_many', fkColumn: 'parent_id' });
    c.objects.insert('query_parent', { id: 'p', title: '父' });
    c.relations.create('query_parent_items', 'p', 'a');
    expect(c.queries.list(query({ where: { related: { linkType: 'query_parent_items', side: 'right', where: { property: 'id', op: 'eq', value: 'p' } } } })).rows.map(r => r.id)).toEqual(['a']);
    expect(() => c.queries.list(query({ where: { related: { linkType: 'query_parent_items', side: 'left' } } }))).toThrow(/QUERY_INVALID/);
    expect(() => c.queries.list(query({ where: { related: { linkType: 'query_parent_items', side: 'right', where: { related: { linkType: 'query_parent_items', side: 'left' } } } } }))).toThrow(/QUERY_UNSUPPORTED/);
    const todo = c.todos.add({ title: '多态引用' });
    c.todos.complete(todo.id);
    const link = c.ontology.listLinkTypes().find(l => l.leftType === 'todo' && l.rightType === 'checkin')!;
    expect(c.queries.list({ version: 1, objectType: 'todo', where: { related: { linkType: link.apiName, side: 'left' } } }).rows.map(r => r.id)).toEqual([todo.id]);
  });

  it('一对一双向查询遵守实际目标存在，历史悬空引用保留旧详情诊断', () => {
    const c = ctx.core;
    c.ontology.createObjectType({ apiName: 'query_owner', title: '拥有者', properties: [{ apiName: 'title', dataType: 'string' }] });
    c.ontology.updateObjectType('query_item', { addProperties: [{ apiName: 'owner_id', dataType: 'string' }] });
    c.ontology.createLinkType({ apiName: 'query_owner_item', title: '一对一', leftType: 'query_owner', rightType: 'query_item', cardinality: 'one_to_one', fkColumn: 'owner_id' });
    c.objects.insert('query_owner', { id: 'owner', title: '拥有者' });
    c.relations.create('query_owner_item', 'owner', 'a');
    expect(c.queries.related({ version: 1, objectType: 'query_owner', id: 'owner', linkType: 'query_owner_item', side: 'left' }).rows.map(r => r.id)).toEqual(['a']);
    expect(c.queries.related({ version: 1, objectType: 'query_item', id: 'a', linkType: 'query_owner_item', side: 'right' }).rows.map(r => r.id)).toEqual(['owner']);
    const plan = c.plans.create({ title: '历史计划', start_date: '2026-10-16', daily_minutes: 30, items: [{ date: '2026-10-16', content: '学习' }] });
    const session = c.study.recordSession({ plan_item_id: plan.items[0].id, knowledge_key: 'history', actual_minutes: 10 });
    c.plans.remove(plan.id);
    const link = 'plan_item__study_session';
    const input = { version: 1, objectType: 'study_session', where: { related: { linkType: link, side: 'right' } } };
    expect(c.queries.list(input).rows).toEqual([]);
    expect(c.queries.list({ ...input, where: { related: { linkType: link, side: 'right', exists: false } } }).rows.map(r => r.id)).toEqual([session.id]);
    expect(c.relations.list('study_session', session.id, link, 'right').items[0].targetExists).toBe(false);
  });
});

describe('统一查询：绑定合同的游标', () => {
  it('多字段和 NULL 游标保持顺序，排序字段未投影也可继续分页', () => {
    const c = ctx.core;
    const input = query({ select: ['title'], orderBy: [{ property: 'score', direction: 'asc', nulls: 'last' }], includeTotal: true });
    const first = c.queries.list({ ...input, page: { mode: 'cursor', limit: 1 } });
    expect(first.rows[0].id).toBe('b');
    expect(first.rows[0]).not.toHaveProperty('score');
    expect(first.page.nextCursor).toBeTruthy();
    c.objects.insert('query_item', { id: 'before', title: '插入到游标之前', active: true, score: 5 });
    const second = c.queries.list({ ...input, page: { mode: 'cursor', limit: 1, cursor: first.page.nextCursor } });
    expect(second.rows[0].id).toBe('a');
    expect(second.total).toBe(4);
    const third = c.queries.list({ ...input, page: { mode: 'cursor', limit: 1, cursor: second.page.nextCursor } });
    expect(third.rows[0].id).toBe('c');
    expect(third.page.hasMore).toBe(false);
    expect(third.page.nextCursor).toBeUndefined();
  });

  it('游标拒绝篡改与换条件，数据库重连后仍可使用', () => {
    const input = query({ page: { mode: 'cursor', limit: 1 } });
    const first = ctx.core.queries.list(input);
    const cursor = first.page.nextCursor!;
    expect(() => ctx.core.queries.list(query({ where: { property: 'active', op: 'eq', value: true }, page: { mode: 'cursor', cursor } }))).toThrow(/CURSOR_INVALID/);
    expect(() => ctx.core.queries.list(query({ page: { mode: 'cursor', cursor: `${cursor}x` } }))).toThrow(/CURSOR_INVALID/);
    const db = openNodeSqliteDb(ctx.dbPath);
    try {
      const other = createCore(db, { dbPath: ctx.dbPath });
      expect(other.queries.list(query({ page: { mode: 'cursor', limit: 1, cursor } })).rows[0].id).toBe('b');
    } finally { db.close(); }
    ctx.core.ontology.updateObjectType('query_item', { addProperties: [{ apiName: 'new_field', dataType: 'string' }] });
    expect(() => ctx.core.queries.list(query({ page: { mode: 'cursor', cursor } }))).toThrow(/CURSOR_INVALID/);
  });
});
