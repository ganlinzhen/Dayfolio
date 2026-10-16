// 学习计划服务测试
import { describe, expect, it } from 'vitest';
import { addDays, todayStr } from '../src/utils/date';
import { mkCore } from './helpers';

describe('学习计划服务', () => {
  it('删除保护手工待办与其他计划共用的待办，并清理已完成待办的打卡', () => {
    const { core, cleanup } = mkCore();
    try {
      const today = todayStr();
      const plan = core.plans.create({ title: '删除测试', start_date: today, items: [
        { date: today, content: '独占待办' }, { date: today, content: '共用待办' }, { date: today, content: '手工关联' },
      ] });
      const other = core.plans.create({ title: '保留计划', start_date: today, create_todos: false, items: [{ date: today, content: '其他条目' }] });
      const manual = core.todos.add({ title: '手工待办' });
      core.todos.remove(plan.items[2].todo_id!);
      core.db.prepare('UPDATE plan_items SET todo_id = ? WHERE id = ?').run(manual.id, plan.items[2].id);
      core.db.prepare('UPDATE plan_items SET todo_id = ? WHERE id = ?').run(plan.items[1].todo_id, other.items[0].id);
      core.todos.complete(plan.items[0].todo_id!);
      core.checkins.checkin({ ref_type: 'day', date: today });
      core.plans.remove(plan.id);
      expect(() => core.todos.get(plan.items[0].todo_id!)).toThrow('不存在');
      expect(core.checkins.list({ ref_type: 'todo' })).toHaveLength(0);
      expect(core.checkins.list({ ref_type: 'plan_item' })).toHaveLength(0);
      expect(core.checkins.list({ ref_type: 'day' })).toHaveLength(1);
      expect(core.todos.get(manual.id).title).toBe('手工待办');
      expect(core.plans.get(other.id).items[0].todo_id).toBe(plan.items[1].todo_id);
      expect(core.todos.list()).toHaveLength(2);
    } finally { cleanup(); }
  });

  it('显式保留待办；无待办计划也可删除；不存在计划拒绝且不影响待办', () => {
    const { core, cleanup } = mkCore();
    try {
      const today = todayStr();
      const plan = core.plans.create({ title: '保留待办', start_date: today, items: [{ date: today, content: '保留' }] });
      core.plans.remove(plan.id, { delete_todos: false });
      expect(core.todos.get(plan.items[0].todo_id!).title).toBe('保留');
      const empty = core.plans.create({ title: '无待办', start_date: today, create_todos: false, items: [{ date: today, content: '无待办' }] });
      core.plans.remove(empty.id);
      expect(() => core.plans.remove(plan.id)).toThrow('不存在');
      expect(core.todos.list()).toHaveLength(1);
    } finally { cleanup(); }
  });

  it('中途删除失败时计划、待办、条目与打卡整体回滚', () => {
    const { core, cleanup } = mkCore();
    try {
      const today = todayStr();
      const plan = core.plans.create({ title: '回滚', start_date: today, items: [{ date: today, content: '一' }, { date: today, content: '二' }] });
      core.todos.complete(plan.items[0].todo_id!);
      core.db.exec(`CREATE TRIGGER reject_todo_delete BEFORE DELETE ON todos
        WHEN OLD.id = ${plan.items[1].todo_id} BEGIN SELECT RAISE(ABORT, '模拟失败'); END`);
      expect(() => core.plans.remove(plan.id)).toThrow('模拟失败');
      expect(core.plans.get(plan.id).items.map(it => it.todo_id)).toEqual(plan.items.map(it => it.todo_id));
      expect(core.todos.list()).toHaveLength(2);
      expect(core.checkins.list({ ref_type: 'todo' })).toHaveLength(1);
    } finally { cleanup(); }
  });

  it('创建计划：默认生成关联待办，进度正确', () => {
    const { core, cleanup } = mkCore();
    try {
      const today = todayStr();
      const plan = core.plans.create({
        title: 'TypeScript 入门课',
        goal: '两周掌握 TS 基础',
        start_date: today,
        items: [
          { date: today, content: '第 1 课：类型基础', item_type: 'learn', duration_min: 45 },
          { date: addDays(today, 1), content: '复习第 1 课', item_type: 'review', duration_min: 20 },
          { date: addDays(today, 2), content: '第 2 课：泛型', item_type: 'learn' },
        ],
      });
      expect(plan.items).toHaveLength(3);
      expect(plan.total_items).toBe(3);
      expect(plan.done_items).toBe(0);
      expect(plan.progress).toBe(0);
      // 结束日期缺省取条目最大日期
      expect(plan.end_date).toBe(addDays(today, 2));

      // 每个条目生成了待办且已关联
      const linkedTodos = core.todos.list({ tag: `plan:${plan.id}` });
      expect(linkedTodos).toHaveLength(3);
      expect(plan.items.every((it) => it.todo_id !== null)).toBe(true);
      const withTodo = plan.items.find((it) => it.content.includes('第 1 课'))!;
      expect(core.todos.get(withTodo.todo_id!).due_date).toBe(today);
      expect(core.todos.get(withTodo.todo_id!).source).toBe('plan');
    } finally {
      cleanup();
    }
  });

  it('条目日期越界报错；create_todos=false 时不生成待办', () => {
    const { core, cleanup } = mkCore();
    try {
      const today = todayStr();
      expect(() =>
        core.plans.create({
          title: '越界计划',
          start_date: today,
          end_date: addDays(today, 1),
          items: [{ date: addDays(today, 5), content: '超期条目' }],
        }),
      ).toThrow('不在计划区间');

      const plan = core.plans.create({
        title: '不生成待办的计划',
        start_date: today,
        items: [{ date: today, content: '只做安排' }],
        create_todos: false,
      });
      expect(plan.items[0].todo_id).toBeNull();
      expect(core.todos.list()).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it('条目打卡：置 done 记打卡并联动完成待办，撤销则双双回退', () => {
    const { core, cleanup } = mkCore();
    try {
      const today = todayStr();
      const plan = core.plans.create({
        title: 'Rust 课',
        start_date: today,
        items: [{ date: today, content: '所有权模型' }],
      });
      const item = plan.items[0];

      core.plans.updateItemStatus(item.id, 'done');
      expect(core.checkins.getRecord('plan_item', item.id, today)).not.toBeNull();
      expect(core.todos.get(item.todo_id!).status).toBe('done');
      // 关联待办的完成不应重复记一条 todo 打卡
      expect(core.checkins.list({ ref_type: 'todo' })).toHaveLength(0);
      expect(core.plans.get(plan.id).progress).toBe(1);

      core.plans.updateItemStatus(item.id, 'pending');
      expect(core.checkins.getRecord('plan_item', item.id, today)).toBeNull();
      expect(core.todos.get(item.todo_id!).status).toBe('open');
    } finally {
      cleanup();
    }
  });

  it('计划列表带进度；更新状态；删除计划连删生成的待办', () => {
    const { core, cleanup } = mkCore();
    try {
      const today = todayStr();
      const plan = core.plans.create({
        title: '算法课',
        start_date: today,
        items: [
          { date: today, content: '排序' },
          { date: addDays(today, 1), content: '查找' },
        ],
      });
      core.plans.updateItemStatus(plan.items[0].id, 'done');
      expect(core.plans.list()[0].done_items).toBe(1);

      core.plans.update(plan.id, { status: 'archived' });
      expect(core.plans.list('archived')[0].id).toBe(plan.id);

      core.plans.remove(plan.id);
      expect(core.plans.list()).toHaveLength(0);
      // 生成的待办与条目打卡一并删除
      expect(core.todos.list()).toHaveLength(0);
      expect(core.checkins.list({ ref_type: 'plan_item' })).toHaveLength(0);
      expect(() => core.plans.get(plan.id)).toThrow('不存在');
    } finally {
      cleanup();
    }
  });
});
