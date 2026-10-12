// 今日概览测试
import { describe, expect, it } from 'vitest';
import { addDays, nowIso, todayStr } from '../src/utils/date';
import { mkCore } from './helpers';

describe('今日概览', () => {
  it('聚合逾期/今日待办、今日计划条目与打卡摘要', () => {
    const { core, cleanup } = mkCore();
    try {
      const today = todayStr();
      core.todos.add({ title: '过期未做', due_date: addDays(today, -2) });
      core.todos.add({ title: '今天到期', due_date: today });
      core.todos.add({ title: '已完成', due_date: today });

      const plan = core.plans.create({
        title: '英语课',
        start_date: addDays(today, -1),
        items: [
          { date: addDays(today, -1), content: '昨天:音标' },
          { date: today, content: '今天:对话练习', item_type: 'practice' },
        ],
      });
      const todayItem = plan.items.find((i) => i.date === today)!;
      core.todos.complete(core.todos.list({ search: '已完成' })[0].id);
      core.plans.updateItemStatus(todayItem.id, 'done');
      core.checkins.checkin({ ref_type: 'day', note: '每日打卡' });

      const t = core.today.getToday();
      expect(t.date).toBe(today);
      // 逾期 = 手工建的「过期未做」+ 计划昨天生成的「昨天:音标」待办
      expect(t.overdue_todos.map((x) => x.title)).toEqual(['过期未做', '昨天:音标']);
      expect(t.due_today_todos.map((x) => x.title)).toEqual(['今天到期']);
      // 今日完成 = 手工完成的「已完成」+ 计划条目联动完成的「今天:对话练习」待办
      expect(t.completed_today_todos).toHaveLength(2);
      expect(t.today_plan_items).toHaveLength(1);
      expect(t.today_plan_items[0].plan_title).toBe('英语课');
      expect(t.today_plan_items[0].status).toBe('done');
      expect(t.summary.plan_item_done_count).toBe(1);
      expect(t.summary.todo_done_count).toBe(2);
      expect(t.summary.manual_checkin_count).toBe(1);
      expect(t.streak).toBeGreaterThanOrEqual(1);
      // 一句话摘要包含关键信息
      expect(t.summary_text).toContain('2 项待办已逾期');
      expect(t.summary_text).toContain('学习安排 1 项（已完成 1）');
      expect(t.summary_text).toContain('连续打卡');
      // 打卡数 = 每日 1 + 计划条目 1 + 待办完成 1
      expect(t.checkins).toHaveLength(3);
    } finally {
      cleanup();
    }
  });

  it('nowIso 生成本地时间戳（长度 23，日期前缀等于本地今天）', () => {
    expect(nowIso().length).toBe(23);
    expect(nowIso().startsWith(todayStr())).toBe(true);
    expect(new Date(nowIso()).toString()).not.toBe('Invalid Date');
  });
});
