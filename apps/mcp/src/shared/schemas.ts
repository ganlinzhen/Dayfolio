import { z } from 'zod';
import { parseDateInput, type Priority, type PlanItemType, type TodoDeskCore } from '../../../../packages/core/src/index';

import { dateInZone } from '../../../../packages/core/src/utils/schedule';

const PRIORITY_ALIASES: Record<string, Priority> = {
  high: 'high', p0: 'high', '高': 'high', 紧急: 'high', 重要: 'high', urgent: 'high', 1: 'high',
  medium: 'medium', p1: 'medium', 中: 'medium', 一般: 'medium', normal: 'medium', 2: 'medium',
  low: 'low', p2: 'low', 低: 'low', 不急: 'low', 3: 'low',
};

export const prioritySchema = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v === '') return 'medium' as Priority;
    const n = PRIORITY_ALIASES[v.trim().toLowerCase()] ?? PRIORITY_ALIASES[v.trim()];
    if (!n) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `无法识别优先级 "${v}"，可用：high/medium/low、P0/P1/P2、高/中/低`,
      });
      return z.NEVER;
    }
    return n;
  });

export function dateSchemas(core: TodoDeskCore) {
const dateSchema = z
  .string()
  .transform((v, ctx) => {
    try {
      return parseDateInput(v, dateInZone(new Date(), core.runtime.getDisplayTimezone()));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${msg}；也支持 today/tomorrow/yesterday（今天/明天/昨天/后天）等别名`,
      });
      return z.NEVER;
    }
  });

return { dateSchema, nullableDateSchema: dateSchema.nullable() };
}

const ITEM_TYPE_ALIASES: Record<string, PlanItemType> = {
  learn: 'learn', 学习: 'learn', 上课: 'learn', 新学: 'learn',
  review: 'review', 复习: 'review', 巩固: 'review',
  practice: 'practice', 练习: 'practice', 作业: 'practice', 实战: 'practice', practise: 'practice',
  rest: 'rest', 休息: 'rest', 缓冲: 'rest',
};

export const itemTypeSchema = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v === '') return 'learn' as PlanItemType;
    const n = ITEM_TYPE_ALIASES[v.trim().toLowerCase()] ?? ITEM_TYPE_ALIASES[v.trim()];
    if (!n) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `无法识别条目类型 "${v}"，可用：learn/review/practice/rest（学习/复习/练习/休息）`,
      });
      return z.NEVER;
    }
    return n;
  });

