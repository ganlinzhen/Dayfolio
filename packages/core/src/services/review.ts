// 间隔复习调度服务：为刚学完的知识点按遗忘曲线批量生成复习条目。
// 复用学习计划（item_type='review'），打卡、待办生成、进度统计全部继承现有联动。
import type { NewPlanInput, NewPlanItemInput, PlanDetail } from '../types';
import type { PlanService } from './plan';
import { addDays, ensureValidDateStr, todayStr } from '../utils/date';

/** 单个复习主题：知识点名称 + 学完日期（缺省取 schedule 的 start_date） */
export interface ReviewTopicInput {
  name: string;
  learned_date?: string;
}

export interface NewReviewScheduleInput {
  /** 计划标题，缺省「间隔复习：<前几个主题>」 */
  title?: string;
  topics: Array<ReviewTopicInput | string>;
  /** 首次复习基准日，缺省今天 */
  start_date?: string;
  /** 复习间隔（天），缺省 [1, 3, 7, 21] */
  intervals?: number[];
  /** 每次复习预计时长（分钟），缺省 15 */
  duration_min?: number | null;
  /** 是否为每条复习生成待办，默认 true（透传给学习计划） */
  create_todos?: boolean;
}

export const DEFAULT_REVIEW_INTERVALS = [1, 3, 7, 21];

/** 归一化主题：字符串视为 { name } */
function normalizeTopics(
  topics: NewReviewScheduleInput['topics'],
  fallbackDate: string,
): Required<ReviewTopicInput>[] {
  if (!Array.isArray(topics) || topics.length === 0) {
    throw new Error('topics 不能为空：至少提供一个知识点名称');
  }
  return topics.map((t) => {
    const topic = typeof t === 'string' ? { name: t } : t;
    const name = topic.name?.trim();
    if (!name) throw new Error('知识点名称不能为空');
    return { name, learned_date: ensureValidDateStr(topic.learned_date ?? fallbackDate) };
  });
}

export function createReviewService(deps: { plans: PlanService }) {
  /**
   * 为一批知识点生成间隔复习计划：每个主题 × 每个间隔各一条 review 条目，
   * 日期 = 学完日期 + 间隔天数。过去的日期照常生成（会以逾期形式提醒补复习）。
   */
  const schedule = (input: NewReviewScheduleInput): PlanDetail => {
    const startDate = ensureValidDateStr(input.start_date ?? todayStr());
    const topics = normalizeTopics(input.topics, startDate);

    const intervals = (input.intervals ?? DEFAULT_REVIEW_INTERVALS)
      .map((n) => {
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(`复习间隔必须为正整数（天），收到 "${n}"`);
        }
        return n;
      })
      .filter((n, i, arr) => arr.indexOf(n) === i) // 去重
      .sort((a, b) => a - b);
    if (intervals.length === 0) throw new Error('复习间隔不能为空');

    const duration = input.duration_min ?? 15;
    const items: NewPlanItemInput[] = [];
    for (const topic of topics) {
      for (const gap of intervals) {
        items.push({
          date: addDays(topic.learned_date, gap),
          content: `复习：${topic.name}（第 ${gap} 天）`,
          item_type: 'review',
          duration_min: duration,
        });
      }
    }

    const title =
      input.title?.trim() ||
      `间隔复习：${topics.map((t) => t.name).slice(0, 3).join('、')}${topics.length > 3 ? ' 等' : ''}`;
    // 计划起点扩展到最早复习日：补学过的主题时（learned_date 在 start_date 之前），
    // 早期复习日不能落在区间外
    const earliest = items.reduce((m, it) => (it.date < m ? it.date : m), items[0].date);
    const planInput: NewPlanInput = {
      title,
      goal: `遗忘曲线复习（间隔 ${intervals.join('/')} 天），共 ${topics.length} 个知识点`,
      start_date: earliest < startDate ? earliest : startDate,
      // end_date 缺省取条目最大日期（plans.create 内已处理）
      notes: input.title ? undefined : '由间隔复习调度器自动生成',
      items,
      create_todos: input.create_todos,
    };
    return deps.plans.create(planInput);
  };

  return { schedule };
}

export type ReviewService = ReturnType<typeof createReviewService>;
