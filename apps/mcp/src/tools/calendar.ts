import type { ToolRegistrar, McpContext } from '../shared/context';
import { z } from 'zod';
import { dateSchemas } from '../shared/schemas';
import { wrap } from '../shared/response';

export function registerTools(server: ToolRegistrar, { core }: McpContext): void {
  const { dateSchema, nullableDateSchema } = dateSchemas(core);
  // ---------- 日历（个人本地日程：读写对称，App 今日页同源展示） ----------

  const calendarColorSchema = z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return undefined; // 未传=不改（add 侧由服务层默认 blue）
      const t = v.trim().toLowerCase();
      const map: Record<string, string> = { blue: 'blue', 蓝: 'blue', green: 'green', 绿: 'green', violet: 'violet', 紫: 'violet', amber: 'amber', 黄: 'amber', rose: 'rose', 红: 'rose', slate: 'slate', 灰: 'slate' };
      if (!map[t]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `无法识别颜色 "${v}"，可用：blue/green/violet/amber/rose/slate（蓝/绿/紫/黄/红/灰）` });
        return z.NEVER;
      }
      return map[t] as 'blue' | 'green' | 'violet' | 'amber' | 'rose' | 'slate';
    });

  const calendarTimeSchema = z
    .string()
    .optional()
    .nullable()
    .transform((v, ctx) => {
      if (v === undefined) return undefined; // 未传=不改（add 侧 ?? null 落为全天）
      if (v === null || v === '') return null; // 显式传 null/空串=清除（变全天）
      const t = v.trim();
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `时间格式错误："${v}"，应为 HH:MM（如 09:30）；不填表示全天` });
        return z.NEVER;
      }
      return t;
    });

  server.tool(
    'list_calendar_events',
    '查询日程（个人本地日历，只读）。按日期区间返回与区间相交的日程（跨天日程含在区间内的每一天）；也可按关键词搜标题/备注。什么场景调用我：用户问某天/某段时间有什么安排、查看或核对日程',
    {
      from: dateSchema.optional().describe('区间开始日期，缺省不限'),
      to: dateSchema.optional().describe('区间结束日期，缺省不限；查整月给出两端'),
      search: z.string().optional().describe('按标题/备注模糊搜索'),
      limit: z.number().int().positive().max(500).optional().describe('默认 500'),
    },
    async ({ from, to, search, limit }) =>
      wrap(() => {
        const events = core.calendar.list({ from, to, search, limit });
        return { count: events.length, events };
      })(),
  );

  server.tool(
    'add_calendar_event',
    '新增日程。什么场景调用我：用户说「帮我记个日程/安排个会/周五下午有空档」时，把口头安排落成结构化日程；全天日程不填 start_time。App 今日页日历同源可见',
    {
      title: z.string().min(1, '标题不能为空').describe('日程标题'),
      date: dateSchema.describe('开始日期（支持 today/明天 等别名）'),
      end_date: nullableDateSchema.optional().describe('结束日期（含当天），缺省单日；跨天日程填这里'),
      start_time: calendarTimeSchema.describe('开始时间 HH:MM；不填=全天'),
      end_time: calendarTimeSchema.describe('结束时间 HH:MM；仅填了开始时间时有效'),
      note: z.string().optional().describe('备注'),
      color: calendarColorSchema.describe('色标：blue/green/violet/amber/rose/slate，缺省 blue'),
    },
    async ({ title, date, end_date, start_time, end_time, note, color }) =>
      wrap(() =>
        core.calendar.add({
          title, date,
          end_date: end_date ?? null,
          start_time: start_time ?? null,
          end_time: end_time ?? null,
          note, color: color ?? 'blue', source: 'mcp',
        }),
      )(),
  );

  server.tool(
    'update_calendar_event',
    '修改日程：改时间/日期、改标题、换颜色、补备注均可，只传要改的字段。日程不存在会报错',
    {
      id: z.number().int().positive(),
      title: z.string().optional(),
      date: dateSchema.optional(),
      end_date: nullableDateSchema.optional().describe('传 null 清除结束日期（变单日）'),
      start_time: calendarTimeSchema,
      end_time: calendarTimeSchema,
      note: z.string().optional(),
      color: calendarColorSchema,
    },
    async ({ id, ...patch }) =>
      wrap(() => {
        // zod 未传的可选字段值为 undefined，服务层按「不改」处理；显式 null 才是「清除」
        const fixed: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(patch)) if (v !== undefined) fixed[k] = v;
        return core.calendar.update(id, fixed as never);
      })(),
  );

  server.tool(
    'delete_calendar_event',
    '删除日程（不可恢复，请先与用户确认）。什么场景调用我：用户说「把那个会取消掉/删掉这条日程」',
    { id: z.number().int().positive() },
    async ({ id }) =>
      wrap(() => {
        core.calendar.remove(id);
        return { deleted: id };
      })(),
  );
}
