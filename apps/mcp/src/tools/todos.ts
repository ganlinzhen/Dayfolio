import type { ToolRegistrar, McpContext } from '../shared/context';
import { z } from 'zod';
import { type CheckinRefType, type TodoStatus } from '../../../../packages/core/src/index';
import { prioritySchema, dateSchema, nullableDateSchema } from '../shared/schemas';
import { wrap } from '../shared/response';

export function registerTools(server: ToolRegistrar, { core }: McpContext): void {
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
    '新增一条待办事项。要加进「今日待办」就把 due_date 设为 today（或「今天」）；priority 支持 high/medium/low（也接受 P0/P1/P2、高/中/低等别名）；due_date 支持 today/明天 等别名或 YYYY-MM-DD；start_time/end_time 为同一天的 HH:MM 起止时间，必须成对提供且结束晚于开始；不传时仅日期；tags 为字符串数组',
    {
      title: z.string().min(1).describe('待办标题'),
      notes: z.string().optional().describe('备注详情'),
      priority: prioritySchema,
      due_date: dateSchema.optional().describe('安排日期 YYYY-MM-DD'),
      start_time: z.string().nullable().optional().describe('开始时间 HH:MM，须同时填 end_time'),
      end_time: z.string().nullable().optional().describe('结束时间 HH:MM，须晚于 start_time'),
      tags: z.array(z.string()).optional(),
    },
    async ({ title, notes, priority, due_date, start_time, end_time, tags }) =>
      wrap(() =>
        core.todos.add({ title, notes, priority, due_date: due_date ?? null, start_time, end_time, tags, source: 'mcp' }),
      )(),
  );


  server.tool(
    'update_todo',
    '修改待办事项（只传需要改的字段）。due_date 传 null 同时清除日期和时段；start_time/end_time 成对设为 null 切换为仅日期，或传 HH:MM 设置时段；status 传 done 等同完成并自动打卡',
    {
      id: z.number().int().positive(),
      title: z.string().min(1).optional(),
      notes: z.string().nullable().optional(),
      priority: prioritySchema,
      due_date: nullableDateSchema.optional(),
      start_time: z.string().nullable().optional(),
      end_time: z.string().nullable().optional(),
      tags: z.array(z.string()).optional(),
      status: z.enum(['open', 'done']).optional(),
    },
    async ({ id, title, notes, priority, due_date, start_time, end_time, tags, status }) =>
      wrap(() => core.todos.update(id, { title, notes, priority, due_date, start_time, end_time, tags, status: status as TodoStatus }))(),
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
}
