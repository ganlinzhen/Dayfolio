// 待办服务测试
import { describe, expect, it, vi } from 'vitest';
import { addDays, todayStr } from '../src/utils/date';
import { mkCore, mkLegacyDb } from './helpers';
import { openNodeSqliteDb } from '../src/adapters/node-sqlite';
import { createCore } from '../src';

describe('待办服务', () => {
  it('旧版 v14 日期待办升级后不丢失原值，也不伪造时段', () => {
    const { db, dbPath, cleanup } = mkLegacyDb(14);
    let upgraded: ReturnType<typeof openNodeSqliteDb> | undefined;
    try {
      const old = { title: '旧日期任务', due_date: todayStr(), tags: ['保留'], created_at: '2026-10-01T00:00:00.000' };
      const result = db.prepare('INSERT INTO todos(title,due_date,tags,created_at,updated_at) VALUES(?,?,?,?,?)').run(old.title, old.due_date, JSON.stringify(old.tags), old.created_at, old.created_at);
      expect(db.prepare('PRAGMA table_info(todos)').all().some(column => column.name === 'start_time')).toBe(false);
      db.close();
      upgraded = openNodeSqliteDb(dbPath);
      const next = createCore(upgraded, { dbPath });
      expect(next.todos.get(result.lastInsertRowid)).toMatchObject({ title: old.title, due_date: old.due_date, tags: old.tags, start_time: null, end_time: null, created_at: old.created_at });
      expect(upgraded.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally { upgraded?.close(); cleanup(); }
  });

  it('时段在新增、编辑、日历聚合和清除日期后保持一致', () => {
    const { core, cleanup } = mkCore();
    try {
      const date = todayStr();
      const t = core.todos.add({ title: '下午阅读', due_date: date, start_time: '14:00', end_time: '15:30' });
      expect(core.todos.get(t.id)).toMatchObject({ start_time: '14:00', end_time: '15:30' });
      expect(core.calendar.rangeAgenda({ from: date, to: date }).days[date].todos[0]).toMatchObject({ start_time: '14:00', end_time: '15:30' });
      expect(core.todos.update(t.id, { end_time: '16:00' }).end_time).toBe('16:00');
      expect(core.todos.update(t.id, { start_time: null, end_time: null })).toMatchObject({ due_date: date, start_time: null, end_time: null });
      core.todos.update(t.id, { start_time: '09:00', end_time: '10:00' });
      expect(core.todos.update(t.id, { due_date: null })).toMatchObject({ due_date: null, start_time: null, end_time: null });
    } finally { cleanup(); }
  });

  it('拒绝仅结束、倒序、非法时间与无日期时段，失败不改原记录', () => {
    const { core, cleanup } = mkCore();
    try {
      const base = { title: '时间校验', due_date: todayStr() };
      for (const timing of [
        { end_time: '10:00' },
        { start_time: '10:00', end_time: '10:00' },
        { start_time: '11:00', end_time: '10:00' },
        { start_time: '24:00', end_time: '25:00' },
        { start_time: '9:00', end_time: '10:00' },
      ]) expect(() => core.todos.add({ ...base, ...timing })).toThrow();
      expect(() => core.todos.add({ title: '无日期', start_time: '09:00', end_time: '10:00' })).toThrow('日期');
      const t = core.todos.add({ ...base, start_time: '09:00', end_time: '10:00' });
      expect(() => core.todos.update(t.id, { start_time: '11:00' })).toThrow('结束时间');
      expect(core.todos.get(t.id).start_time).toBe('09:00');
    } finally { cleanup(); }
  });

  it('时段结束时才逾期，列表与今日概览一致；仅日期当天不逾期', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 15, 9, 59));
    const { core, cleanup } = mkCore();
    try {
      const t = core.todos.add({ title: '有时段', due_date: todayStr(), start_time: '09:00', end_time: '10:00' });
      const day = core.todos.add({ title: '仅日期', due_date: todayStr() });
      expect(t.is_overdue).toBe(false);
      vi.setSystemTime(new Date(2026, 9, 15, 10, 0));
      expect(core.todos.get(t.id).is_overdue).toBe(true);
      expect(core.todos.list({ overdue: true }).map(t => t.id)).toEqual([t.id]);
      expect(core.today.getToday().overdue_todos.map(t => t.id)).toEqual([t.id]);
      expect(core.todos.get(day.id).is_overdue).toBe(false);
    } finally { cleanup(); vi.useRealTimers(); }
  });

  it('新增 → 查询：字段完整、默认值正确', () => {
    const { core, cleanup } = mkCore();
    try {
      const t = core.todos.add({ title: '写周报', priority: 'high', due_date: todayStr(), tags: ['工作'] });
      expect(t.id).toBeGreaterThan(0);
      expect(t.status).toBe('open');
      expect(t.priority).toBe('high');
      expect(t.tags).toEqual(['工作']);
      expect(t.source).toBe('app');
      expect(t.is_overdue).toBe(false);

      const found = core.todos.list().find((x) => x.id === t.id);
      expect(found?.title).toBe('写周报');
    } finally {
      cleanup();
    }
  });

  it('空标题 / 非法优先级报错', () => {
    const { core, cleanup } = mkCore();
    try {
      expect(() => core.todos.add({ title: '   ' })).toThrow('标题不能为空');
      // @ts-expect-error 故意传非法值
      expect(() => core.todos.add({ title: 'x', priority: 'urgent' })).toThrow('无效优先级');
    } finally {
      cleanup();
    }
  });

  it('完成待办：记 completed_at 并自动生成打卡；重开则清理打卡', () => {
    const { core, cleanup } = mkCore();
    try {
      const t = core.todos.add({ title: '读书 30 页' });
      const done = core.todos.complete(t.id);
      expect(done.status).toBe('done');
      expect(done.completed_at).toBeTruthy();
      const c = core.checkins.getRecord('todo', t.id, todayStr());
      expect(c).not.toBeNull();

      const reopened = core.todos.reopen(t.id);
      expect(reopened.status).toBe('open');
      expect(reopened.completed_at).toBeNull();
      expect(core.checkins.getRecord('todo', t.id, todayStr())).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('过期判定与 overdue 筛选', () => {
    const { core, cleanup } = mkCore();
    try {
      const past = core.todos.add({ title: '过期任务', due_date: addDays(todayStr(), -1) });
      const future = core.todos.add({ title: '未来任务', due_date: addDays(todayStr(), 3) });
      expect(core.todos.get(past.id).is_overdue).toBe(true);
      const overdueList = core.todos.list({ overdue: true });
      expect(overdueList.map((t) => t.id)).toEqual([past.id]);

      // 完成后不再算过期
      core.todos.complete(past.id);
      expect(core.todos.list({ overdue: true }).map((t) => t.id)).toEqual([]);
      expect(future.is_overdue).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('筛选：状态 / 优先级 / 搜索 / 标签；排序：高优先级在前', () => {
    const { core, cleanup } = mkCore();
    try {
      core.todos.add({ title: '低优先级买菜', priority: 'low' });
      core.todos.add({ title: '高优先级上线 Bug 修复', priority: 'high' });
      core.todos.add({ title: '复习英语单词', priority: 'medium', tags: ['学习'] });

      expect(core.todos.list({ priority: 'high' })).toHaveLength(1);
      expect(core.todos.list({ search: '英语' })).toHaveLength(1);
      expect(core.todos.list({ tag: '学习' })[0].title).toBe('复习英语单词');

      const open = core.todos.list({ status: 'open' });
      expect(open[0].priority).toBe('high');

      core.todos.complete(open[0].id);
      expect(core.todos.list({ status: 'open' })).toHaveLength(2);
      expect(core.todos.list({ status: 'done' })).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it('更新字段；删除待办同时清理其打卡', () => {
    const { core, cleanup } = mkCore();
    try {
      const t = core.todos.add({ title: '原始标题' });
      const updated = core.todos.update(t.id, {
        title: '新标题',
        priority: 'high',
        due_date: todayStr(),
        notes: '备注',
      });
      expect(updated.title).toBe('新标题');
      expect(updated.priority).toBe('high');

      core.todos.complete(t.id);
      expect(core.checkins.list({ ref_type: 'todo' })).toHaveLength(1);
      core.todos.remove(t.id);
      expect(core.checkins.list({ ref_type: 'todo' })).toHaveLength(0);
      expect(() => core.todos.get(t.id)).toThrow('不存在');
    } finally {
      cleanup();
    }
  });
});
