import type { ToolRegistrar, McpContext } from '../shared/context';
import { z } from 'zod';
import { type CheckinRefType, type TodoStatus } from '../../../../packages/core/src/index';
import { prioritySchema, dateSchemas } from '../shared/schemas';
import { wrap } from '../shared/response';

export function registerTools(server: ToolRegistrar, { core }: McpContext): void {
  const { dateSchema, nullableDateSchema } = dateSchemas(core);
  server.tool(
    'list_todos',
    '查询待办事项列表。可按状态(open/done/all，默认 open)、优先级(high/medium/low)、是否过期、关键词、标签筛选；结果按"未完成优先、优先级高优先、截止日期近优先"排序',
    {
      status: z.enum(['open', 'done', 'all']).optional().describe("默认 'open'"),
      priority: z.enum(['high', 'medium', 'low']).optional(),
      overdue: z.boolean().optional().describe('只看已过期未完成'),
      search: z.string().optional().describe('按标题/备注模糊搜索'),
      tag: z.string().optional().describe('按标签过滤'),
      limit: z.number().int().positive().max(500).optional().describe('默认 500'),
    },
    async ({ status, priority, overdue, search, tag, limit }) =>
      wrap(() => {
        const todos = core.todos.list({ status, priority, overdue, search, tag, limit });
        return { count: todos.length, todos };
      })(),
  );


  server.tool(
  'add_todo',
  '新增一条待办事项。要加进「今日待办」就把 due_date 设为 today（或「今天」）；priority 支持 high/medium/low（也接受 P0/P1/P2、高/中/低等别名）；due_date 支持 today/明天 等别名或 YYYY-MM-DD；浮动时间允许只填开始时间，跨午夜使用 end_date；固定时刻使用 time_mode=instant 和带偏移的 scheduled_start_at/end_at，不能混入本地字段；tags 为字符串数组',
  {
    title: z.string().min(1).describe('待办标题'),
    notes: z.string().optional().describe('备注详情'),
    priority: prioritySchema,
    due_date: dateSchema.optional().describe('安排日期 YYYY-MM-DD'),
    start_time: z.string().nullable().optional().describe('开始时间 HH:MM，允许结束未知'),
    end_time: z.string().nullable().optional().describe('结束时间 HH:MM，跨日须填 end_date'),
    end_date: nullableDateSchema.optional(),
    time_mode: z.enum(['floating','instant']).optional(),
    scheduled_start_at: z.string().nullable().optional(),
    scheduled_end_at: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
  },
  async ({ title, notes, priority, due_date, start_time, end_time, end_date, time_mode, scheduled_start_at, scheduled_end_at, tags }) =>
    wrap(() =>
      core.todos.add({ title, notes, priority, due_date: time_mode==='instant'?due_date:due_date ?? null, start_time, end_time, end_date, time_mode, scheduled_start_at, scheduled_end_at, tags, source: 'mcp' }),
    )(),
);



  server.tool(
  'update_todo',
  '修改待办事项（只传需要改的字段）。due_date 传 null 同时清除日期和时段；允许仅开始时间或带 end_date 的跨日时段；固定时刻使用 UTC 字段；有效修改标题或排期会转手动跟随，expected_revision 防止覆盖并发修改；status 传 done 等同完成并自动打卡',
  {
    id: z.number().int().positive(),
    expected_revision: z.number().int().positive().optional(),
    title: z.string().min(1).optional(),
    notes: z.string().nullable().optional(),
    priority: prioritySchema.optional(),
    due_date: nullableDateSchema.optional(),
    start_time: z.string().nullable().optional(),
    end_time: z.string().nullable().optional(),
    end_date: nullableDateSchema.optional(),
    time_mode: z.enum(['floating','instant']).optional(),
    scheduled_start_at: z.string().nullable().optional(),
    scheduled_end_at: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
    status: z.enum(['open', 'done']).optional(),
  },
  async ({ id, expected_revision, title, notes, priority, due_date, start_time, end_time, end_date, time_mode, scheduled_start_at, scheduled_end_at, tags, status }) =>
    wrap(() => core.todos.update(id, { expected_revision, title, notes, priority, due_date, start_time, end_time, end_date, time_mode, scheduled_start_at, scheduled_end_at, tags, status: status as TodoStatus }))(),
);



  server.tool(
    'complete_todo',
    '完成一条待办事项（自动记录打卡，计入连续天数）',
    { id: z.number().int().positive() },
    async ({ id }) => wrap(() => core.todos.complete(id))(),
  );


  server.tool(
    'delete_todo',
    '删除一条待办事项（不可恢复，请先与用户确认）',
    { id: z.number().int().positive() },
    async ({ id }) =>
      wrap(() => {
        core.todos.remove(id);
        return { deleted: id };
      })(),
  );


  server.tool(
    'checkin',
    '打卡。ref_type=day 为每日打卡（ref_id 留空）；也可对待办(todo)或计划条目(plan_item)打卡。同一天同一目标重复打卡幂等',
    {
      ref_type: z.enum(['day', 'todo', 'plan_item']).describe("每日打卡用 'day'"),
      ref_id: z.number().int().positive().optional().describe('ref_type 为 todo/plan_item 时必填'),
      date: dateSchema.optional().describe('补打卡日期，缺省今天'),
      note: z.string().optional().describe('打卡备注'),
    },
    async ({ ref_type, ref_id, date, note }) =>
      wrap(() => {
        const record = core.checkins.checkin({
          ref_type: ref_type as CheckinRefType,
          ref_id,
          date,
          note,
        });
        return { checkin: record, streak: core.checkins.streak() };
      })(),
  );

  server.tool(
    'get_checkin_stats',
    '打卡统计：连续天数、近 7/30 天活跃天数、总打卡数、最近打卡记录',
    {},
    async () =>
      wrap(() => {
        const stats = core.checkins.stats();
        const recent = core.checkins.listDetailed({ limit: 20 });
        return { ...stats, recent_checkins: recent };
      })(),
  );
}
