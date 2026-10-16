// 所有夹具使用临时库；固定时刻与墙钟日期必须跨入口一致。
import { describe, it, expect, vi } from 'vitest';
import { mkCore } from './helpers';
import { createCore, runtimeErrorInfo } from '../src';

describe('运行时日程时间语义', () => {
  it('旧待办默认 floating，仅开始时刻与跨午夜合法', () => {
    const { core, cleanup } = mkCore();
    try {
      expect(core.todos.add({ title: '日期' }).time_mode).toBe('floating');
      expect(core.todos.add({ title: '仅开始', due_date: '2026-11-01', start_time: '03:00' })).toMatchObject({ end_time: null, time_mode: 'floating' });
      const t = core.todos.add({ title: '跨午夜', due_date: '2026-11-01', end_date: '2026-11-02', start_time: '23:30', end_time: '01:30' });
      expect(t.end_date).toBe('2026-11-02');
      expect(() => core.todos.add({ title: '倒序', due_date: '2026-11-01', start_time: '23:30', end_time: '01:30' })).toThrow();
    } finally { cleanup(); }
  });
  it('instant 以 UTC 为事实，切换显示时区只移动镜像，floating 不动', () => {
    const { core, cleanup } = mkCore();
    try {
      core.runtime.setDisplayTimezone('Asia/Shanghai');
      const a = core.todos.add({ title: '比赛', time_mode: 'instant', scheduled_start_at: '2026-10-31T19:00:00Z' });
      const b = core.todos.add({ title: '早读', due_date: '2026-11-01', start_time: '09:00' });
      expect(a).toMatchObject({ due_date: '2026-11-01', start_time: '03:00', scheduled_end_at: null });
      core.runtime.setDisplayTimezone('Europe/London');
      expect(core.todos.get(a.id)).toMatchObject({ due_date: '2026-10-31', start_time: '19:00', scheduled_start_at: '2026-10-31T19:00:00.000Z' });
      expect(core.todos.get(b.id)).toMatchObject({ due_date: '2026-11-01', start_time: '09:00' });
      expect(() => core.todos.add({ title: '冲突输入', time_mode: 'instant', due_date: '2026-11-01', scheduled_start_at: '2026-10-31T19:00:00Z' })).toThrow();
    } finally { cleanup(); }
  });
  it('真实结束判定过期；未知结束按开始日的显示时区日终判断', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-01T01:00:00Z'));
    const { core, cleanup } = mkCore();
    try {
      core.runtime.setDisplayTimezone('Asia/Shanghai');
      const openEnd = core.todos.add({ title: '未知结束', time_mode: 'instant', scheduled_start_at: '2026-10-31T19:00:00Z' });
      const ended = core.todos.add({ title: '已结束', time_mode: 'instant', scheduled_start_at: '2026-10-31T19:00:00Z', scheduled_end_at: '2026-10-31T21:00:00Z' });
      expect(core.todos.get(openEnd.id).is_overdue).toBe(false);
      expect(core.todos.get(ended.id).is_overdue).toBe(true);
      expect(core.todos.list({ overdue: true }).map(t => t.id)).toEqual([ended.id]);
      expect(core.today.getToday().overdue_todos.map(t => t.id)).toEqual([ended.id]);
      vi.setSystemTime(new Date('2026-11-01T16:00:00Z'));
      expect(core.todos.get(openEnd.id).is_overdue).toBe(true);
    } finally { cleanup(); vi.useRealTimers(); }
  });
  it('有效变更递增行修订，空更新不改变，失败事务不增加运行修订', () => {
    const { core, cleanup } = mkCore();
    try {
      const t = core.todos.add({ title: '修订' }); const rev = core.runtime.getRevision();
      expect(core.todos.update(t.id, { title: t.title }).revision).toBe(t.revision);
      expect(core.runtime.getRevision()).toBe(rev);
      expect(core.todos.update(t.id, { notes: '备注' }).revision).toBeGreaterThan(t.revision);
      const last = core.runtime.getRevision();
      expect(() => core.todos.update(t.id, { due_date: '不存在' })).toThrow();
      expect(core.runtime.getRevision()).toBe(last);
    } finally { cleanup(); }
  });
});


describe('时间边界补充', () => {
  it('夏令时回拨产生相同镜像但保持不同 UTC 权威值', () => {
    const { core, cleanup } = mkCore(); try {
      core.runtime.setDisplayTimezone('Europe/London'); const a = core.todos.add({ title: '回拨前', time_mode: 'instant', scheduled_start_at: '2026-10-25T00:30:00Z' }); const b = core.todos.add({ title: '回拨后', time_mode: 'instant', scheduled_start_at: '2026-10-25T01:30:00Z' });
      expect(a.start_time).toBe('01:30'); expect(b.start_time).toBe('01:30'); expect(a.scheduled_start_at).not.toBe(b.scheduled_start_at);
    } finally { cleanup(); }
  });
  it('时区修改失败整体回滚，不留下半更新镜像', () => {
    const { core, cleanup } = mkCore(); try {
      core.runtime.setDisplayTimezone('Asia/Shanghai'); const a = core.todos.add({ title: '时区事务', time_mode: 'instant', scheduled_start_at: '2026-10-31T19:00:00Z' }); core.ontology.updateActionType('update_todo', { status: 'disabled' });const rev=core.runtime.getRevision();
      expect(() => core.runtime.setDisplayTimezone('Europe/London')).toThrow('ACTION_DISABLED'); expect(core.runtime.getDisplayTimezone()).toBe('Asia/Shanghai'); expect(core.todos.get(a.id).due_date).toBe(a.due_date); expect(core.runtime.getRevision()).toBe(rev);
    } finally { cleanup(); }
  });
});

it('更高数据库或合同版本在任何结构初始化前拒绝', () => {
  const { core, cleanup } = mkCore(); try {
    core.db.exec('PRAGMA user_version=999'); const before = core.db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all();
    expect(() => createCore(core.db)).toThrow('SCHEMA_TOO_NEW'); expect(core.db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all()).toEqual(before);
    core.db.exec('PRAGMA user_version=16'); core.db.exec('UPDATE runtime_revision SET contract_major=2 WHERE id=1'); const rev = core.runtime.getRevision();
    expect(() => createCore(core.db)).toThrow('HOST_API_UNSUPPORTED'); expect(core.runtime.getRevision()).toBe(rev);
  } finally { cleanup(); }
});

it('两种 SQLite 驱动的忙错误统一为可重试 SQL 状态', () => {
  const native = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }); const node = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
  expect(runtimeErrorInfo(native)).toMatchObject({ code: 'SQLITE_BUSY', retryable: true }); expect(runtimeErrorInfo(node)).toMatchObject({ code: 'SQLITE_BUSY', retryable: true });
  expect(runtimeErrorInfo(Object.assign(new Error('无权'), { code: 'PERMISSION_DENIED' })).retryable).toBe(false);
});
