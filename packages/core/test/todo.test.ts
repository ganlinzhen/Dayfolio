// 待办服务测试
import { describe, expect, it } from 'vitest';
import { addDays, todayStr } from '../src/utils/date';
import { mkCore } from './helpers';

describe('待办服务', () => {
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
