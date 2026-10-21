import { describe, expect, it } from 'vitest';
import type { Todo } from '../src/renderer/src/components/TodoPanel';
import { addDays, groupOf, matchesDate, mergeTags, scheduleChanged, scheduleInput, scheduleOf, sortTodos } from '../src/renderer/src/components/todo-view';

const todo = (patch: Partial<Todo> = {}): Todo => ({
  id: 1, title: '练习待办', notes: '', priority: 'medium', status: 'open', due_date: '2026-10-21',
  start_time: null, end_time: null, end_date: null, time_mode: 'floating', scheduled_start_at: null,
  scheduled_end_at: null, revision: 1, source_status: null, source_time_kind: null,
  collection_id: 'builtin.todo', tags: [], source: 'app', completed_at: null, is_overdue: false, ...patch,
});

describe('待办日期筛选与排序', () => {
  it('今天与未来七天包含跨日重叠事项，但不包含窗口外事项', () => {
    const spanning = todo({ due_date: '2026-10-20', end_date: '2026-10-22' });
    expect(matchesDate(spanning, 'today', '2026-10-21')).toBe(true);
    expect(matchesDate(spanning, 'week', '2026-10-21')).toBe(true);
    expect(matchesDate(todo({ due_date: '2026-10-27' }), 'week', '2026-10-21')).toBe(true);
    expect(matchesDate(todo({ due_date: '2026-10-28' }), 'week', '2026-10-21')).toBe(false);
    expect(matchesDate(todo({ due_date: '2026-10-20' }), 'week', '2026-10-21')).toBe(false);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('逾期沿用服务端权威判断，已完成优先进入完成分组', () => {
    const overdue = todo({ is_overdue: true });
    expect(matchesDate(overdue, 'overdue', '2026-10-21')).toBe(true);
    expect(groupOf(overdue, '2026-10-21')).toBe('已逾期');
    expect(groupOf(todo({ status: 'done', is_overdue: false }), '2026-10-21')).toBe('已完成');
    expect(groupOf(todo({ due_date: null }), '2026-10-21')).toBe('无日期');
    expect(matchesDate(todo({ due_date: null }), 'today', '2026-10-21')).toBe(false);
    expect(matchesDate(todo({ due_date: null }), 'unscheduled', '2026-10-21')).toBe(true);
  });
  it('按时间排序时同日的明确时刻优先，也支持优先级和最近添加', () => {
    const list = [todo({ id: 1, priority: 'high' }), todo({ id: 2, start_time: '18:00' }), todo({ id: 3, start_time: '09:00', priority: 'low' })];
    expect(sortTodos(list, 'date').map(t => t.id)).toEqual([3, 2, 1]);
    expect(sortTodos(list, 'priority').map(t => t.id)).toEqual([1, 2, 3]);
    expect(sortTodos(list, 'newest').map(t => t.id)).toEqual([3, 2, 1]);
    expect(list.map(t => t.id)).toEqual([1, 2, 3]);
  });
});

describe('待办编辑保护', () => {
  it('备注与标签编辑不触碰固定时刻，排期修改才提交时间字段', () => {
    const instant = todo({ time_mode: 'instant', start_time: '04:00', scheduled_start_at: '2026-10-20T20:00:00.000Z' });
    expect(scheduleChanged(instant, scheduleOf(instant))).toBe(false);
    expect(scheduleChanged(instant, { ...scheduleOf(instant), start: '05:00' })).toBe(true);
    expect(mergeTags('工作，工作,周报', ['plan:7', '旧标签'])).toEqual(['plan:7', '工作', '周报']);
  });
  it('拒绝缺少开始时间、倒置时段和错误跨日日期', () => {
    expect(() => scheduleInput({ due: '2026-10-21', dateOnly: false, start: '', end: '' })).toThrow('开始时间');
    expect(() => scheduleInput({ due: '2026-10-21', dateOnly: false, start: '23:00', end: '01:00' })).toThrow('跨午夜');
    expect(() => scheduleInput({ due: '2026-10-21', endDate: '2026-10-20', dateOnly: true, start: '', end: '' })).toThrow('结束日期');
    expect(scheduleInput({ due: '2026-10-21', endDate: '2026-10-22', dateOnly: false, start: '23:00', end: '01:00' })).toMatchObject({ end_date: '2026-10-22', end_time: '01:00' });
  });
  it('无日期和仅日期清空时间字段，保留合法的跨日范围', () => {
    expect(scheduleInput({ due: '', dateOnly: true, start: '10:00', end: '11:00' })).toEqual({ due_date: null, end_date: null, start_time: null, end_time: null });
    expect(scheduleInput({ due: '2026-10-21', endDate: '2026-10-22', dateOnly: true, start: '10:00', end: '11:00' })).toEqual({ due_date: '2026-10-21', end_date: '2026-10-22', start_time: null, end_time: null });
  });
});
