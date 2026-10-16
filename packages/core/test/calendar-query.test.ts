import { describe, expect, it } from 'vitest';
import { mkCore } from './helpers';
import { provisionProvider, eventFixture, importOne } from './runtime-fixtures';
import { inTx } from '../src';
import { zonedInstant } from '../src/utils/zoned-time';

const range = { fromDate: '2026-11-01', toDateExclusive: '2026-11-04', displayTimezone: 'Asia/Shanghai' };

describe('统一日历只读投影', () => {
  it('先确定真实归属再过滤，计划和订阅不会从普通待办重复出现', () => {
    const { core, cleanup } = mkCore(); try {
      core.runtime.setDisplayTimezone(range.displayTimezone);
      const plan = core.plans.create({ title: '学习', start_date: '2026-11-01', items: [{ date: '2026-11-01', content: '真实关联' }] });
      const manual = core.todos.add({ title: '只有来源标签', source: 'plan', tags: ['学习计划'], due_date: '2026-11-01' });
      const local = core.calendar.add({ title: '本地日程', date: '2026-11-01' });
      const provider = provisionProvider(core); const { event } = importOne(core, provider.providerId, eventFixture());
      const sub = core.subscriptions.subscribe({ eventId: event.id }); core.todos.add({ title: '无日期' });
      const revision = core.runtime.getRevision(); const all = core.calendar.queryItems(range);
      expect(core.runtime.getRevision()).toBe(revision);
      expect(all.items).toHaveLength(4); expect(all.countsByDay['2026-11-01']).toBe(4);
      expect(all.items.find(i => i.id === `plan_item:${plan.items[0].id}`)?.target).toEqual({ objectType: 'plan_item', id: plan.items[0].id });
      expect(all.items.find(i => i.id === `todo:${manual.id}`)?.collectionId).toBe('builtin.todo');
      expect(all.items.find(i => i.id === `calendar_event:${local.id}`)?.target.objectType).toBe('calendar_event');
      expect(all.items.find(i => i.id === `todo:${sub.todo!.id}`)?.kind).toBe('external_subscription');
      core.runtime.setVisibility({ collectionId: provider.collectionId, visible: false });
      const hidden = core.calendar.queryItems(range); expect(hidden.items).toHaveLength(3);
      expect(hidden.items.some(i => i.target.id === sub.todo!.id && i.target.objectType === 'todo')).toBe(false);
      expect(core.todos.get(sub.todo!.id).id).toBe(sub.todo!.id);
      const beforeDisable=core.runtime.getRevision();core.ontology.updateActionType('complete_todo',{status:'disabled'});expect(core.runtime.getRevision()).toBeGreaterThan(beforeDisable);expect(core.calendar.queryItems(range).items.find(i=>i.id===`todo:${manual.id}`)?.allowedActions).not.toContain('complete');
      expect(core.calendar.queryItems({ ...range, collectionIds: [provider.collectionId] }).items).toHaveLength(1);
      const empty = core.calendar.queryItems({ ...range, collectionIds: [] }); expect(empty.items).toEqual([]); expect(Object.values(empty.countsByDay)).toEqual([0, 0, 0]);
      expect(() => core.calendar.queryItems({ ...range, collectionIds: ['不存在'] })).toThrow('CONTRACT_INVALID');
    } finally { cleanup(); }
  });

  it('全天排他、跨午夜、未知结束和 tbd 不编造时间', () => {
    const { core, cleanup } = mkCore(); try {
      core.runtime.setDisplayTimezone('Europe/London');
      const q = { ...range, displayTimezone: 'Europe/London' };
      core.todos.add({ title: '跨午夜', time_mode: 'instant', scheduled_start_at: '2026-11-01T23:30:00Z', scheduled_end_at: '2026-11-02T01:30:00Z' });
      core.todos.add({ title: '午夜排他', time_mode: 'instant', scheduled_start_at: '2026-11-01T21:00:00Z', scheduled_end_at: '2026-11-02T00:00:00Z' });
      core.todos.add({ title: '未知结束', time_mode: 'instant', scheduled_start_at: '2026-11-02T03:00:00Z' });
      core.todos.add({ title: '仅日期多日', due_date: '2026-11-01', end_date: '2026-11-02' });
      const p = provisionProvider(core); const { event } = importOne(core, p.providerId, { ...eventFixture(), timeKind: 'tbd', startAt: null, endAt: null });
      core.subscriptions.subscribe({ eventId: event.id });
      const result = core.calendar.queryItems(q); expect(result.items).toHaveLength(4);
      expect(result.countsByDay).toEqual({ '2026-11-01': 3, '2026-11-02': 3, '2026-11-03': 0 });
      expect(result.items.find(i => i.title === '未知结束')?.endAt).toBeNull();
      expect(result.items.find(i => i.title === '仅日期多日')).toMatchObject({ timeKind: 'all_day', endDateExclusive: '2026-11-03', startAt: null });
      expect(core.calendar.queryItems({ ...q, fromDate: '2026-11-02', toDateExclusive: '2026-11-03' }).items.some(i => i.title === '午夜排他')).toBe(false);
    } finally { cleanup(); }
  });

  it('手动取消保留来源状态，follow 取消与无日期安排不进入网格', () => {
    const { core, cleanup } = mkCore(); try {
      core.runtime.setDisplayTimezone(range.displayTimezone); const p = provisionProvider(core), raw = eventFixture();
      const a = importOne(core, p.providerId, raw); const sub = core.subscriptions.subscribe({ eventId: a.event.id });
      core.todos.update(sub.todo!.id, { title: '个人安排' }); importOne(core, p.providerId, { ...raw, status: 'cancelled' }, 'cancel');
      expect(core.calendar.queryItems(range).items[0]).toMatchObject({ title: '个人安排', sourceStatus: 'cancelled', kind: 'external_subscription' });
      const revision = core.subscriptions.get({ eventId: a.event.id }).todo!.revision;
      core.subscriptions.resumeFollowing({ eventId: a.event.id, expectedEventRevision: 2, expectedTodoRevision: revision });
      expect(core.calendar.queryItems(range).items).toEqual([]);
    } finally { cleanup(); }
  });

  it('分页超过 500 条仍完整且统计不受页大小影响，变更后游标失效', () => {
    const { core, cleanup } = mkCore(); try {
      core.runtime.setDisplayTimezone(range.displayTimezone);
      inTx(core.db, () => { for (let i = 0; i < 503; i++) core.todos.add({ title: `第${i}项`, due_date: '2026-11-01' }); });
      const first = core.calendar.queryItems({ ...range, limit: 500 }); expect(first.items).toHaveLength(500); expect(first.countsByDay['2026-11-01']).toBe(503);
      const last = core.calendar.queryItems({ ...range, limit: 500, cursor: first.nextCursor! }); expect(last.items).toHaveLength(3); expect(last.nextCursor).toBeNull();
      expect(new Set([...first.items, ...last.items].map(i => i.id)).size).toBe(503);
      core.todos.add({ title: '新增', due_date: '2026-11-01' });
      expect(() => core.calendar.queryItems({ ...range, cursor: first.nextCursor! })).toThrow('REVISION_CONFLICT');
      expect(() => core.calendar.queryItems({ ...range, toDateExclusive: '2027-11-01' })).toThrow('RANGE_TOO_LARGE');
      expect(() => core.calendar.queryItems({ ...range, displayTimezone: 'UTC' })).toThrow('REVISION_CONFLICT');
    } finally { cleanup(); }
  });

  it('来源停用保留分类与历史；冲突的历史关联明确诊断', () => {
    const { core, cleanup } = mkCore(); try {
      core.runtime.setDisplayTimezone(range.displayTimezone); const p = provisionProvider(core); const { event } = importOne(core, p.providerId, eventFixture()); const sub = core.subscriptions.subscribe({ eventId: event.id });
      core.db.prepare("UPDATE extensions SET status='uninstalled' WHERE id=?").run(p.extensionId);
      const result = core.calendar.queryItems(range); expect(result.items).toHaveLength(1); expect(result.collections.find(c => c.id === p.collectionId)?.extensionStatus).toBe('uninstalled');
      const plan = core.plans.create({ title: '历史异常', start_date: '2026-11-01', create_todos: false, items: [{ date: '2026-11-01', content: '异常条目' }] });
      core.db.prepare('UPDATE plan_items SET todo_id=? WHERE id=?').run(sub.todo!.id, plan.items[0].id);
      expect(() => core.calendar.queryItems(range)).toThrow('REFERENCE_CONFLICT');
    } finally { cleanup(); }
  });

  it('旧本地跨日日程缺少结束钟点时保留日期跨度，完整时段仍按定时投影', () => {
    const { core, cleanup } = mkCore(); try {
      core.runtime.setDisplayTimezone(range.displayTimezone);
      const legacy = core.calendar.add({ title: '旧跨日培训', date: '2026-11-01', end_date: '2026-11-03', start_time: '09:00' });
      const exact = core.calendar.add({ title: '完整跨日时段', date: '2026-11-01', end_date: '2026-11-02', start_time: '23:00', end_time: '01:00' });
      const query = { ...range, fromDate: '2026-11-02', toDateExclusive: '2026-11-04' };
      const result = core.calendar.queryItems(query);
      expect(result.items.find(item => item.target.id === legacy.id)).toMatchObject({ timeKind: 'all_day', startDate: '2026-11-01', endDateExclusive: '2026-11-04', startAt: null, endAt: null });
      expect(result.items.find(item => item.target.id === exact.id)).toMatchObject({ timeKind: 'timed', startAt: '2026-11-01T15:00:00.000Z', endAt: '2026-11-01T17:00:00.000Z' });
      expect(result.countsByDay).toEqual({ '2026-11-02': 2, '2026-11-03': 1 });
      expect(core.calendar.get(legacy.id)).toMatchObject({ date: '2026-11-01', end_date: '2026-11-03', start_time: '09:00', end_time: null });
    } finally { cleanup(); }
  });

  it('浮动钟点转换规则固定，夏令时回拨和跳时可复查', () => {
    expect(zonedInstant('2026-10-25', '01:30', 'Europe/London')).toBe('2026-10-25T00:30:00.000Z');
    expect(zonedInstant('2026-03-29', '01:30', 'Europe/London')).toBe('2026-03-29T01:30:00.000Z');
    expect(zonedInstant('2026-11-01', '03:00', 'Asia/Shanghai')).toBe('2026-10-31T19:00:00.000Z');
  });
});
