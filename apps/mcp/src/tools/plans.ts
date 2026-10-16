import type { ToolRegistrar, McpContext } from '../shared/context';
import { z } from 'zod';
import { type PlanItemStatus, type PlanStatus } from '../../../../packages/core/src/index';
import { dateSchema, itemTypeSchema } from '../shared/schemas';
import { wrap } from '../shared/response';

export function registerTools(server: ToolRegistrar, { core }: McpContext): void {
  server.tool(
    'create_study_plan',
    '创建完整学习计划：给定课程/目标与逐日安排（items 每项含 date 与 content），系统会为每个条目自动生成一条待办（除非 create_todos=false）。条目 item_type 可选 learn(学习)/review(复习)/practice(练习)/rest(休息)，建议按"学习新内容+定期复习"编排。所有条目日期必须落在 start_date~end_date 区间内',
    {
      title: z.string().min(1).describe('计划标题，如「TypeScript 入门 14 天」'),
      goal: z.string().optional().describe('学习目标'),
      start_date: dateSchema,
      end_date: dateSchema.optional().describe('缺省取条目最大日期'),
      notes: z.string().optional(),
      items: z
        .array(
          z.object({
            date: dateSchema,
            content: z.string().min(1).describe('当天要学/复习的内容'),
            item_type: itemTypeSchema,
            duration_min: z.number().int().positive().nullable().optional().describe('预计时长（分钟）'),
          }),
        )
        .min(1)
        .describe('逐日安排列表'),
      create_todos: z.boolean().optional().describe('是否为每条安排生成待办，默认 true'),
    },
    async ({ title, goal, start_date, end_date, notes, items, create_todos }) =>
      wrap(() => {
        const plan = core.plans.create({ title, goal, start_date, end_date, notes, items, create_todos });
        return {
          plan_id: plan.id,
          title: plan.title,
          date_range: `${plan.start_date} ~ ${plan.end_date}`,
          item_count: plan.items.length,
          todos_created: plan.items.filter((i) => i.todo_id).length,
        };
      })(),
  );


  server.tool(
    'list_study_plans',
    '查询学习计划列表（含进度 done_items/total_items）',
    { status: z.enum(['active', 'done', 'archived']).optional() },
    async ({ status }) =>
      wrap(() => {
        const plans = core.plans.list(status as PlanStatus | undefined);
        return { count: plans.length, plans };
      })(),
  );


  server.tool(
    'get_study_plan',
    '查询单个学习计划详情（含逐日条目安排与各自状态）',
    { id: z.number().int().positive() },
    async ({ id }) => wrap(() => core.plans.get(id))(),
  );


  server.tool(
    'update_plan_item',
    '更新学习计划条目状态——打卡核心入口：status=done 即完成当日学习任务（自动记打卡并联动完成对应待办）；pending 为撤销；skipped 为跳过',
    {
      id: z.number().int().positive().describe('条目 id（可从 get_study_plan / get_today 获得）'),
      status: z.enum(['pending', 'done', 'skipped']),
    },
    async ({ id, status }) =>
      wrap(() => {
        const item = core.plans.updateItemStatus(id, status as PlanItemStatus);
        return { item, plan_progress: core.plans.get(item.plan_id).progress };
      })(),
  );


  server.tool(
    'update_study_plan',
    '更新学习计划状态（active/done/archived）或标题、目标、备注',
    {
      id: z.number().int().positive(),
      title: z.string().min(1).optional(),
      goal: z.string().optional(),
      notes: z.string().optional(),
      status: z.enum(['active', 'done', 'archived']).optional(),
    },
    async ({ id, title, goal, notes, status }) =>
      wrap(() => core.plans.update(id, { title, goal, notes, status: status as PlanStatus }))(),
  );


  server.tool(
    'delete_study_plan',
    '删除学习计划、条目及条目打卡；默认连删本计划独占的自动生成待办及其打卡，delete_todos=false 可保留待办。不可恢复，请先与用户确认；也可通过 invoke_action 调用同名内置动作',
    { id: z.number().int().positive(), delete_todos: z.boolean().optional().describe('默认 true，连删计划生成待办；false 保留待办') },
    async ({ id, delete_todos }) =>
      wrap(() => {
        core.plans.remove(id, { delete_todos });
        return { deleted: id };
      })(),
  );
}
