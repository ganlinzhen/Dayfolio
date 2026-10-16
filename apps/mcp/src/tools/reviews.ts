import type { ToolRegistrar, McpContext } from '../shared/context';
import { z } from 'zod';
import { dateSchemas } from '../shared/schemas';
import { wrap } from '../shared/response';

export function registerTools(server: ToolRegistrar, { core }: McpContext): void {
  const { dateSchema } = dateSchemas(core);
  // ---------- 间隔复习 ----------

  server.tool(
    'create_review_schedule',
    '为刚学完的知识点按遗忘曲线批量生成复习任务（默认学后第 1/3/7/21 天各复习一次）。每个主题会生成一个复习计划并自动创建对应待办，打卡与进度统计与学习计划一致。适合在用户学完某个知识点/课程章节后主动建议调用',
    {
      topics: z
        .array(
          z.union([
            z.string().min(1).describe('知识点名称'),
            z.object({
              name: z.string().min(1).describe('知识点名称，如「TS 协变与逆变」'),
              learned_date: dateSchema.optional().describe('学完日期 YYYY-MM-DD，缺省取 start_date'),
            }),
          ]),
        )
        .min(1)
        .describe('要安排复习的知识点列表（纯名称字符串或 {name, learned_date} 对象均可）'),
      start_date: dateSchema.optional().describe('基准日期（未单独指定 learned_date 的主题用它），缺省今天'),
      intervals: z
        .array(z.number().int().positive())
        .optional()
        .describe('复习间隔（天），默认 [1, 3, 7, 21]'),
      duration_min: z.number().int().positive().nullable().optional().describe('每次复习预计分钟数，默认 15'),
      create_todos: z.boolean().optional().describe('是否为每条复习生成待办，默认 true'),
    },
    async ({ topics, start_date, intervals, duration_min, create_todos }) =>
      wrap(() => {
        const plan = core.reviews.schedule({
          topics,
          start_date,
          intervals,
          duration_min,
          create_todos,
        });
        return {
          plan_id: plan.id,
          title: plan.title,
          topic_count: new Set(topics.map((t) => (typeof t === 'string' ? t : t.name))).size,
          review_dates: [...new Set(plan.items.map((i) => i.date))].sort(),
          item_count: plan.items.length,
          todos_created: plan.items.filter((i) => i.todo_id).length,
        };
      })(),
  );
}
