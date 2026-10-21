import { afterEach, describe, expect, it } from 'vitest';
import { mkCore, type TestCtx } from './helpers';

let ctx: TestCtx;
afterEach(() => ctx?.cleanup());
const setup = () => {
  ctx = mkCore();
  const tool = ctx.core.tools.addTool({ title: '赛事资料', entry_file: 'index.html' });
  return { c: ctx.core, toolId: tool.id };
};
const match = { sourceKey: 'uefa:2026:123', title: '观看 A vs B', startAt: '2026-11-04T04:00:00+08:00', sourceUrl: 'https://example.com/match/123' };

describe('HTML 工具待办业务', () => {
  it('预览和未确认请求不创建分类，首次创建按工具名称归类，后续复用', () => {
    const { c, toolId } = setup();
    const before = c.runtime.listCollections();
    const revision = c.runtime.getRevision();
    const preview = c.toolTodos.preview({ toolId, items: [match] });
    expect(preview.category).toMatchObject({ title: '赛事资料', exists: false });
    expect(c.runtime.listCollections()).toEqual(before);
    expect(c.runtime.getRevision()).toBe(revision);
    const first = c.toolTodos.create({ toolId, items: [match] });
    expect(first.category).toMatchObject({ id: preview.category.id, title: '赛事资料', exists: true });
    expect(c.todos.get(first.items[0].todoId!).collection_id).toBe(preview.category.id);
    c.toolTodos.create({ toolId, items: [{ sourceKey: 'next', title: '下一项' }] });
    expect(c.runtime.listCollections()).toHaveLength(before.length + 1);
    expect(c.runtime.listCollections().find(i => i.id === preview.category.id)?.visible).toBe(true);
  });

  it('自定义分类对任意工具通用，稳定键复用，工具之间隔离，日历可显示和隐藏', () => {
    const { c, toolId } = setup();
    const category = { key: 'reading', title: '读书会', color: 'green' as const };
    const first = c.toolTodos.create({ toolId, category, items: [{ sourceKey: 'reading:1', title: '阅读第一章', dueDate: '2026-11-05' }] });
    const collectionId = first.category!.id;
    c.runtime.setVisibility({ collectionId, visible: false });
    c.toolTodos.create({ toolId, category: { ...category, title: '来源改名', color: 'rose' }, items: [{ sourceKey: 'reading:2', title: '阅读第二章', dueDate: '2026-11-05' }] });
    expect(c.runtime.listCollections().find(i => i.id === collectionId)).toMatchObject({ title: '读书会', color: 'green', visible: false });
    c.runtime.setDisplayTimezone('Asia/Shanghai');
    const range = { fromDate: '2026-11-05', toDateExclusive: '2026-11-06', displayTimezone: 'Asia/Shanghai' };
    expect(c.calendar.queryItems(range).items).toHaveLength(0);
    c.runtime.setVisibility({ collectionId, visible: true });
    expect(c.calendar.queryItems(range).items).toHaveLength(2);
    expect(c.todos.list({ collection_id: collectionId })).toHaveLength(2);
    const other = c.tools.addTool({ title: '展览日程', entry_file: 'index.html' });
    const second = c.toolTodos.create({ toolId: other.id, category, items: [{ sourceKey: 'exhibit:1', title: '参观展览' }] });
    expect(second.category!.id).not.toBe(collectionId);
    c.tools.deleteTool(toolId);
    expect(c.runtime.listCollections().find(i => i.id === collectionId)?.title).toBe('读书会');
    expect(c.todos.list({ collection_id: collectionId })).toHaveLength(2);
  });

  it('无效批次、禁用动作或写入失败均不遗留空分类，已有待办不产生新分类', () => {
    const { c, toolId } = setup();
    const initial = c.runtime.listCollections().length;
    const category = { key: 'tasks', title: '行动清单' };
    expect(() => c.toolTodos.create({ toolId, category, items: [match, { sourceKey: 'invalid', title: ' ' }] })).toThrow();
    c.ontology.updateActionType('add_todo', { status: 'disabled' });
    expect(() => c.toolTodos.create({ toolId, category, items: [match] })).toThrow();
    expect(c.runtime.listCollections()).toHaveLength(initial);
    c.ontology.updateActionType('add_todo', { status: 'active' });
    c.db.exec("CREATE TRIGGER reject_tool_link BEFORE INSERT ON tool_todo_links BEGIN SELECT RAISE(ABORT, '模拟关联失败'); END");
    expect(() => c.toolTodos.create({ toolId, category, items: [match] })).toThrow('模拟关联失败');
    expect(c.todos.list()).toHaveLength(0);
    expect(c.runtime.listCollections()).toHaveLength(initial);
    c.db.exec('DROP TRIGGER reject_tool_link');
    const id = c.toolTodos.create({ toolId, category, items: [match] }).items[0].todoId!;
    c.todos.remove(id);
    const duplicate = c.toolTodos.create({ toolId, category: { key: 'unused', title: '不应创建' }, items: [match] });
    expect(duplicate.deleted).toBe(1);
    expect(duplicate.category).toBeNull();
    expect(c.runtime.listCollections()).toHaveLength(initial + 1);
  });

  it('分类声明拒绝伪造宿主分类 ID、未知颜色和空名', () => {
    const { c, toolId } = setup();
    const count = c.runtime.listCollections().length;
    for (const category of [{ key: 'a', title: ' ' }, { key: '../builtin.todo', title: '伪造' }, { key: 'a', title: '伪造', id: 'builtin.todo' }, { key: 'a', title: '颜色', color: 'red' }]) {
      expect(() => c.toolTodos.create({ toolId, category, items: [match] })).toThrow();
    }
    expect(c.runtime.listCollections()).toHaveLength(count);
  });

  it('分类筛选先于分页，并按实际计划关联判断学习归属', () => {
    const { c, toolId } = setup();
    const plan = c.plans.create({ title: '学习计划', start_date: '2026-11-05', items: [{ date: '2026-11-05', content: '阅读' }] });
    const manual = c.todos.add({ title: '只有来源标记', source: 'plan' });
    expect(c.todos.list({ collection_id: 'builtin.study' }).map(t => t.id)).toEqual([plan.items[0].todo_id]);
    expect(c.todos.list({ collection_id: 'builtin.todo' }).map(t => t.id)).toEqual([manual.id]);
    const added = c.toolTodos.create({ toolId, items: [{ sourceKey: 'filtered', title: '工具事项' }] });
    expect(c.todos.list({ collection_id: added.category!.id, limit: 1 }).map(t => t.id)).toEqual([added.items[0].todoId]);
    expect(() => c.todos.list({ collection_id: 'missing' })).toThrow();
  });

  it('预览不写库；单场与批量添加共用稳定身份，跨时区保存真实时刻', () => {
    const { c, toolId } = setup();
    expect(c.toolTodos.preview({ toolId, items: [match] }).items[0].startAt).toBe('2026-11-03T20:00:00.000Z');
    expect(c.todos.list()).toHaveLength(0);
    const first = c.toolTodos.create({ toolId, items: [match] });
    const second = c.toolTodos.create({ toolId, items: [match, { sourceKey: 'other', title: '另一场', dueDate: '2026-11-05' }] });
    expect(first.created).toBe(1);
    expect(second).toMatchObject({ created: 1, reused: 1, deleted: 0 });
    const todo = c.todos.get(first.items[0].todoId!);
    expect(todo.scheduled_start_at).toBe('2026-11-03T20:00:00.000Z');
    expect(todo.scheduled_end_at).toBeNull();
    expect(todo.notes).toContain(match.sourceUrl);
    expect(c.todos.list()).toHaveLength(2);
  });

  it('重复添加不覆盖用户标题、排期、备注或完成状态；删除后不自动复活', () => {
    const { c, toolId } = setup();
    const id = c.toolTodos.create({ toolId, items: [match] }).items[0].todoId!;
    c.todos.update(id, { title: '我的标题', notes: '个人笔记', scheduled_start_at: '2026-11-03T21:00:00Z' });
    c.todos.complete(id);
    c.toolTodos.create({ toolId, items: [{ ...match, title: '来源已改名', startAt: '2026-11-03T22:00:00Z' }] });
    expect(c.todos.get(id)).toMatchObject({ title: '我的标题', notes: '个人笔记', status: 'done', scheduled_start_at: '2026-11-03T21:00:00.000Z' });
    c.todos.remove(id);
    expect(c.toolTodos.create({ toolId, items: [match] })).toMatchObject({ created: 0, deleted: 1 });
    expect(c.todos.list()).toHaveLength(0);
  });

  it('工具身份隔离，状态接口只返回本工具关联摘要；删除工具保留待办', () => {
    const { c, toolId } = setup();
    const other = c.tools.addTool({ title: '另一个工具', entry_file: 'other.html' });
    const id = c.toolTodos.create({ toolId, items: [match] }).items[0].todoId!;
    c.todos.update(id, { notes: '不能泄露的个人备注' });
    expect(c.toolTodos.getStatus({ toolId: other.id, sourceKeys: [match.sourceKey] })[0].status).toBe('missing');
    const summary = c.toolTodos.getStatus({ toolId, sourceKeys: [match.sourceKey] });
    expect(summary).toEqual([{ sourceKey: match.sourceKey, todoId: id, status: 'open' }]);
    c.toolTodos.create({ toolId: other.id, items: [match] });
    expect(c.todos.list()).toHaveLength(2);
    c.tools.deleteTool(toolId);
    expect(c.todos.get(id).notes).toBe('不能泄露的个人备注');
    expect(() => c.toolTodos.create({ toolId, items: [match] })).toThrow();
  });

  it('批量先校验再写入，拒绝无时区、矛盾时间、未知字段、重复键和超限', () => {
    const { c, toolId } = setup();
    for (const invalid of [
      { ...match, startAt: '2026-11-04T04:00:00' },
      { ...match, dueDate: '2026-11-04' },
      { ...match, endAt: '2026-11-02T00:00:00Z' },
      { ...match, sourceUrl: 'javascript:alert(1)' },
      { ...match, title: ' ' },
      { ...match, source: 'app' },
    ]) expect(() => c.toolTodos.create({ toolId, items: [{ sourceKey: 'valid', title: '有效' }, invalid] })).toThrow();
    expect(() => c.toolTodos.create({ toolId, items: [match, match] })).toThrow();
    expect(() => c.toolTodos.create({ toolId, items: Array.from({ length: 101 }, (_, i) => ({ sourceKey: String(i), title: '过量' })) })).toThrow();
    expect(c.todos.list()).toHaveLength(0);
  });

  it('时间待定保持未排期，动作禁用时不创建记录', () => {
    const { c, toolId } = setup();
    const result = c.toolTodos.create({ toolId, items: [{ sourceKey: 'tbd', title: '开球时间待定' }] });
    expect(c.todos.get(result.items[0].todoId!)).toMatchObject({ due_date: null, scheduled_start_at: null });
    c.ontology.updateActionType('add_todo', { status: 'disabled' });
    expect(() => c.toolTodos.create({ toolId, items: [match] })).toThrow();
    expect(c.toolTodos.getStatus({ toolId, sourceKeys: [match.sourceKey] })[0].status).toBe('missing');
  });
});
