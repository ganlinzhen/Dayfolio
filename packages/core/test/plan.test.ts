// 学习计划服务测试
import { describe, expect, it } from 'vitest';
import { addDays, todayStr } from '../src/utils/date';
import { mkCore } from './helpers';

describe('学习计划服务', () => {
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

  it('计划列表带进度；更新状态；删除计划保留生成的待办', () => {
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
      // 生成的待办保留
      expect(core.todos.list()).toHaveLength(2);
      expect(() => core.plans.get(plan.id)).toThrow('不存在');
    } finally {
      cleanup();
    }
  });
});
