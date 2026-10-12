// 今日概览服务：聚合逾期/今日到期待办、今日计划条目、打卡状态
import type { DbAdapter } from '../db';
import { mapCheckin, mapTodo } from '../db';
import type { TodayOverview } from '../types';
import { todayStr } from '../utils/date';
import type { CheckinService } from './checkin';
import type { PlanService } from './plan';

export function createTodayService(db: DbAdapter, plans: PlanService, checkins: CheckinService) {
  const getToday = (date: string = todayStr()): TodayOverview => {
    const all = db.prepare('SELECT * FROM todos').all().map(mapTodo);
    const overdue_todos = all.filter((t) => t.status === 'open' && t.due_date && t.due_date < date);
    const due_today_todos = all.filter((t) => t.status === 'open' && t.due_date === date);
    const completed_today_todos = all.filter((t) => t.completed_at?.startsWith(date));
    const todayItems = plans.itemsOnDate(date);
    const todayCheckins = checkins.list({ from: date, to: date });
    const summary = {
      todo_done_count: completed_today_todos.length,
      plan_item_done_count: todayItems.filter((i) => i.status === 'done').length,
      manual_checkin_count: todayCheckins.filter((c) => c.ref_type === 'day').length,
    };
    const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
    const [y, m, d] = date.split('-').map(Number);
    const week = WEEK[new Date(y, m - 1, d).getDay()];
    const parts = [
      `${date}（周${week}）`,
      overdue_todos.length ? `${overdue_todos.length} 项待办已逾期` : null,
      due_today_todos.length ? `${due_today_todos.length} 项今天到期` : null,
      todayItems.length
        ? `学习安排 ${todayItems.length} 项（已完成 ${summary.plan_item_done_count}）`
        : '今日无学习安排',
      `今日完成待办 ${summary.todo_done_count} 项、打卡 ${todayCheckins.length} 次`,
      `已连续打卡 ${checkins.streak()} 天`,
    ].filter(Boolean);
    return {
      date,
      overdue_todos,
      due_today_todos,
      completed_today_todos,
      today_plan_items: todayItems,
      checkins: todayCheckins,
      streak: checkins.streak(),
      summary,
      summary_text: parts.join('；') + '。',
    };
  };

  return { getToday };
}
