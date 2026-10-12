// TodoDesk MCP Server（stdio）
// 供 zcode 等 AI 客户端读写待办/学习计划/打卡/新闻/工具箱，并管理本体：
// 对象类型（ObjectType）、链接类型（LinkType）、动作类型（ActionType）的增删改，
// 任意类型的实例 CRUD（get/create/update/delete_object），以及动作执行（invoke_action）。
// 工具箱文件与桌面 App 共用同一目录（dirname(数据库)/tools），agent 添加的工具 App 内直接可见。
// 数据库与桌面 App 共享：默认 ~/Library/Application Support/tododesk/tododesk.db，
// 可用环境变量 TODODESK_DB 覆盖。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
// 学习闭环规范与帮助面板同源：help:sync 之外，构建时把同一份 md 以 text loader 内嵌
import studyWorkflowSpec from '../../../apps/help/docs/09-study-loop.md';
import {
  collectToolFilesFromPaths,
  createCore,
  defaultDbPath,
  deleteToolFilesAt,
  listToolFiles,
  openNodeSqliteDb,
  parseDateInput,
  pickEntryFile,
  sanitizeToolPath,
  saveToolFilesTo,
  toolsRootForDb,
  type CheckinRefType,
  type PlanItemType,
  type PlanItemStatus,
  type PlanStatus,
  type Priority,
  type TodoStatus,
} from '../../../packages/core/src/index';

const db = openNodeSqliteDb(defaultDbPath());
const core = createCore(db); // agent-only：不抓取 RSS、不读取任何 X 凭据；新闻仅经任务提交入库
const toolFilesRoot = toolsRootForDb(defaultDbPath());

// ---------- 通用 schema ----------

const PRIORITY_ALIASES: Record<string, Priority> = {
  high: 'high', p0: 'high', '高': 'high', 紧急: 'high', 重要: 'high', urgent: 'high', 1: 'high',
  medium: 'medium', p1: 'medium', 中: 'medium', 一般: 'medium', normal: 'medium', 2: 'medium',
  low: 'low', p2: 'low', 低: 'low', 不急: 'low', 3: 'low',
};

const prioritySchema = z
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

const dateSchema = z
  .string()
  .transform((v, ctx) => {
    try {
      return parseDateInput(v);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${msg}；也支持 today/tomorrow/yesterday（今天/明天/昨天/后天）等别名`,
      });
      return z.NEVER;
    }
  });

const nullableDateSchema = dateSchema.nullable();

const ITEM_TYPE_ALIASES: Record<string, PlanItemType> = {
  learn: 'learn', 学习: 'learn', 上课: 'learn', 新学: 'learn',
  review: 'review', 复习: 'review', 巩固: 'review',
  practice: 'practice', 练习: 'practice', 作业: 'practice', 实战: 'practice', practise: 'practice',
  rest: 'rest', 休息: 'rest', 缓冲: 'rest',
};

const itemTypeSchema = z
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

// ---------- 输出辅助 ----------

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

function fail(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: message }) }], isError: true as const };
}

function wrap<T>(fn: () => T | Promise<T>) {
  return async () => {
    try {
      return ok({ ok: true, data: await fn() });
    } catch (e) {
      return fail(e);
    }
  };
}

// ---------- 注册工具 ----------

const server = new McpServer({ name: 'tododesk', version: '1.3.0' });

// 学习闭环规范资源：agent 可通过 resources/read 直接读取（与 get_study_workflow 工具同源）
server.resource('study-workflow', 'tododesk://study/workflow', async (uri) => ({
  contents: [{ uri: uri.href, mimeType: 'text/markdown', text: studyWorkflowSpec }],
}));

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
  '新增一条待办事项。要加进「今日待办」就把 due_date 设为 today（或「今天」）；priority 支持 high/medium/low（也接受 P0/P1/P2、高/中/低等别名）；due_date 支持 today/明天 等别名或 YYYY-MM-DD；tags 为字符串数组',
  {
    title: z.string().min(1).describe('待办标题'),
    notes: z.string().optional().describe('备注详情'),
    priority: prioritySchema,
    due_date: dateSchema.optional().describe('截止日期 YYYY-MM-DD'),
    tags: z.array(z.string()).optional(),
  },
  async ({ title, notes, priority, due_date, tags }) =>
    wrap(() =>
      core.todos.add({ title, notes, priority, due_date: due_date ?? null, tags, source: 'mcp' }),
    )(),
);

server.tool(
  'update_todo',
  '修改待办事项（只传需要改的字段）。due_date 传 null 表示清除截止日期；status 传 done 等同完成并自动打卡',
  {
    id: z.number().int().positive(),
    title: z.string().min(1).optional(),
    notes: z.string().nullable().optional(),
    priority: prioritySchema,
    due_date: nullableDateSchema.optional(),
    tags: z.array(z.string()).optional(),
    status: z.enum(['open', 'done']).optional(),
  },
  async ({ id, title, notes, priority, due_date, tags, status }) =>
    wrap(() => core.todos.update(id, { title, notes, priority, due_date, tags, status: status as TodoStatus }))(),
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
  '删除学习计划及其条目与条目打卡记录（由计划生成的待办会保留但解除关联；不可恢复，请先与用户确认）',
  { id: z.number().int().positive() },
  async ({ id }) =>
    wrap(() => {
      core.plans.remove(id);
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
  'get_today',
  '今日概览：逾期待办、今日到期待办、今日学习计划安排、已完成事项与打卡状态、连续打卡天数——向用户汇报进度或规划今天该做什么时先调这个',
  { date: dateSchema.optional().describe('缺省今天') },
  async ({ date }) => wrap(() => core.today.getToday(date))(),
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

// ---------- 每日新闻（agent-only：任务 → 认领 → 提交；本地不抓取任何 RSS/X） ----------

server.tool(
  'list_news',
  '查看库内新闻（**只读，不联网**）：默认近 3 天，可按任务/来源/关键词过滤，或只看未读/收藏。每条含原始来源链接、摘要、发布时间、已读与收藏状态。App 面板同源展示。什么场景调用我：用户想看最近的新闻、查某条新闻的来源链接、找收藏的内容',
  {
    days: z.number().int().positive().max(90).optional().describe('最近 N 天（按北京日期），默认 3'),
    source: z.union([z.enum(['agent', 'x', 'zhihu_daily', 'hacker_news']), z.string().regex(/^rss\//)]).optional().describe("缺省看全部；'agent'=任务提交的新闻，其余为旧版抓取的历史"),
    task_id: z.number().int().positive().optional().describe('只看某个新闻任务提交的结果（create_news_task 返回的 id）'),
    search: z.string().optional().describe('在标题和摘要中搜索（库内，不联网）'),
    filter: z.enum(['all', 'unread', 'starred']).optional().describe('默认 all；unread=只看未读，starred=只看收藏'),
    since: z.string().optional().describe('ISO 时间戳：只看此时刻之后发布的（如近 24 小时窗口）'),
    limit: z.number().int().positive().max(500).optional().describe('默认 100；历史展示不受任务 10 条预算限制'),
    offset: z.number().int().min(0).optional().describe('分页偏移（配合 limit 使用，按发布时间倒序）'),
  },
  async ({ days, source, task_id, search, filter, since, limit, offset }) =>
    wrap(() => {
      const news = core.news.list({ days: days ?? 3, source: source as never | undefined, task_id, search, filter: filter ?? 'all', since, limit, offset });
      return {
        count: news.length,
        last_fetched_at: core.news.lastFetchedAt(),
        total_by_source: core.news.countBySource(),
        news,
      };
    })(),
);

server.tool(
  'create_news_task',
  '创建一个待执行的新闻任务（新闻生产的唯一入口；App 不抓取，任务由 agent 执行）。什么场景调用我：用户说「帮我收集/看看某方面的最新新闻」。任务创建后处于待执行，由你或下一次会话用 claim_news_task 认领执行。规则：每任务累计最多 10 条新入库（跨批次不重置）；只接受任务时间窗内发布、带原始来源链接与摘要、你亲自核实过的新闻',
  {
    title: z.string().min(1).max(200).describe('任务主题，如「AI 领域最近 24 小时重要新闻」'),
    instructions: z.string().max(2000).optional().describe('给执行 agent 的规则/补充要求（关注方向、语言、侧重等），会在认领时看到'),
    max_items: z.number().int().min(1).max(10).optional().describe('新入库条数上限（默认 10，不可超过 10；跨批次累计）'),
    window_hours: z.number().int().min(1).max(720).optional().describe('时间窗（小时，默认 24）：只接受最近 N 小时内发布的新闻'),
  },
  async (input) => wrap(() => core.news.createTask(input))(),
);

server.tool(
  'list_news_tasks',
  '查看新闻任务及状态/规则/预算进度（只读）。什么场景调用我：开始工作前看看有什么待执行任务、检查某任务已入库几条、用户问「新闻任务进行得怎么样」',
  {
    status: z.enum(['pending', 'claimed', 'completed', 'cancelled']).optional().describe('按状态过滤；缺省全部'),
    limit: z.number().int().positive().max(200).optional().describe('默认 50'),
  },
  async (input) => wrap(() => ({ tasks: core.news.listTasks(input ?? {}) }))(),
);

server.tool(
  'claim_news_task',
  '认领一个待执行的新闻任务并开始执行（缺省取最早的待执行任务；租约过期的任务可被重新认领接力）。返回的 claim_token 是本次执行的凭证，提交/完成/释放都要带它；租约 30 分钟，超时未提交即失效（任务回到待执行，已入库条数保留计入预算）。什么场景调用我：你准备去搜索并提交新闻时，第一步先认领',
  {
    task_id: z.number().int().positive().optional().describe('指定任务 id；缺省认领最早的待执行任务'),
    claimed_by: z.string().max(80).optional().describe('你的标识（如客户端名），展示在任务上'),
  },
  async (input) => wrap(() => core.news.claimTask(input.task_id, input.claimed_by))(),
);

server.tool(
  'submit_news_items',
  '向已认领的任务提交一批新闻（**唯一入库入口**，整批原子：任何一条不合法即全部拒绝）。硬校验：任务须由本 claim_token 持有且租约未过期；每条必须有 title/summary/source_url/published_at——source_url 必须是你**亲自打开核实过**的原始来源页面（http(s)，不接受本地/内网/javascript: 链接），published_at 用页面上真实发布时间（不接受未来时间或超出任务时间窗）；同链接或同事件（归一化标题一致）的重复提交直接拒绝；任务累计入库不得超过 max_items（重复提交无法绕过）。请先用你自己的搜索/浏览工具找到并核实新闻，再提交',
  {
    task_id: z.number().int().positive(),
    claim_token: z.string().min(1).describe('claim_news_task 返回的认领令牌'),
    items: z.array(z.object({
      title: z.string().min(1).max(300).describe('新闻标题'),
      summary: z.string().min(1).max(2000).describe('你核实后写的内容摘要（不接受空摘要）'),
      source_url: z.string().min(1).max(2048).describe('原始来源网页链接（http(s)，你亲自核实过的公开页面）'),
      source_name: z.string().max(120).optional().describe('来源站点名，如「TechCrunch」'),
      published_at: z.string().min(1).describe('来源页面的真实发布时间（ISO 格式）'),
    })).min(1).max(10).describe('本批条目（1~10 条）'),
  },
  async ({ task_id, claim_token, items }) => wrap(() => core.news.submitItems(task_id, claim_token, items as never))(),
);

server.tool(
  'complete_news_task',
  '把已认领的新闻任务标记为完成（须持有效 claim_token）。允许 0 条入库——诚实汇报「时间窗内没有找到合格新闻」也是完成。什么场景调用我：提交完毕或确认无合格新闻后收尾',
  {
    task_id: z.number().int().positive(),
    claim_token: z.string().min(1),
    note: z.string().max(500).optional().describe('完成说明（如收录情况、为何 0 条）'),
  },
  async ({ task_id, claim_token, note }) => wrap(() => core.news.completeTask(task_id, claim_token, note))(),
);

server.tool(
  'release_news_task',
  '释放当前认领、把任务退回待执行（须持 claim_token；已入库条数保留计入预算，下一批次可接力）。什么场景调用我：本会话无法完成（如临时离线、检索受限），明确放弃本次执行',
  {
    task_id: z.number().int().positive(),
    claim_token: z.string().min(1),
    reason: z.string().max(300).optional().describe('释放原因（展示在任务上，帮助下一批次）'),
  },
  async ({ task_id, claim_token, reason }) => wrap(() => core.news.releaseTask(task_id, claim_token, reason))(),
);

server.tool(
  'cancel_news_task',
  '取消一个待执行的新闻任务（仅当无人持有有效认领时；已入库的条目保留）。请先取得用户明确同意再调用',
  { task_id: z.number().int().positive() },
  async ({ task_id }) => wrap(() => core.news.cancelTask(task_id))(),
);

server.tool(
  'mark_news_read',
  '标记一条新闻已读/未读（幂等，持久化；App 与 AI 共享同一状态）',
  { id: z.number().int().positive(), read: z.boolean().optional().describe('缺省 true=已读') },
  async ({ id, read }) => wrap(() => core.news.markRead(id, read ?? true))(),
);

server.tool(
  'mark_news_starred',
  '收藏/取消收藏一条新闻（幂等，持久化）',
  { id: z.number().int().positive(), starred: z.boolean().optional().describe('缺省 true=收藏') },
  async ({ id, starred }) => wrap(() => core.news.markStarred(id, starred ?? true))(),
);

server.tool(
  'mark_all_news_read',
  '把新闻全部标记已读（可限定某个任务的结果），返回影响条数',
  { task_id: z.number().int().positive().optional() },
  async ({ task_id }) => wrap(() => core.news.markAllRead({ task_id }))(),
);

server.tool(
  'delete_news_item',
  '删除一条新闻（不可恢复）。什么场景调用我：用户明确要求删除某条新闻，且你已向用户确认「删除后不可恢复」。务必先向用户复述标题并得到确认再调用。行为：单事务删除正文与收藏/已读状态；随行清理仅新闻独占的话题链接；引用它的自媒体选题/素材保留成果与来源快照、仅解除失效引用；保留最小哈希去重指纹，之后同链接/同事件的提交会被拒绝；AI 采集任务的累计收录名额不因删除返还。幂等：重复删除同一 id 返回 deleted:false。绝不批量删除、绝不未经用户确认调用',
  { id: z.number().int().positive().describe('新闻 id（可从 list_news 获取）') },
  async ({ id }) => wrap(() => core.news.deleteItem(id))(),
);

// ---------- 教学课程（v6：导入/阅读/确认/生成请求队列，agent 可发现并处理待执行请求） ----------

server.tool(
  'import_course',
  '导入教学课程包（staging 目录根须含 course.json、独立总览 HTML 与 D1..Dn 讲义 HTML）。新包请声明 schema_version: 2 和 overview: {"html":"overview.html"}；v2 强制总览单独生成，D1 只写第一天教学内容，不要把总览塞进 D1。无 schema_version 的旧包仍可导入，缺总览时 App 显示待生成；补充总览时带 overview.html 重导样课包即可，不会改写已生成的其他天。安全：路径穿越与符号链接拒绝、HTML 消毒、包内相对 CSS 内联并移除外部资源；幂等（同内容且磁盘文件一致才无变更，缺文件自动修复）；样课变更会使既有确认过期。绑定既有 plan_id 只引用不创建计划（须已存在；已绑定课程不得改绑，省略表示沿用）。课程包必须恰好含一个 is_sample 样课标记（样课包仅样课一天；完整包保留标记）。完整包仅在用户已确认样课、生成请求已被认领且样课正文与确认版本逐字节一致时放行；已完成课程同内容重导可幂等修复',
  { staging_dir: z.string().min(1).describe('课程包 staging 目录绝对路径（包根含 course.json）') },
  async ({ staging_dir }) =>
    wrap(() => {
      const r = core.courses.importCourse(staging_dir);
      return {
        course_id: r.course.id, slug: r.course.slug, status: r.course.status, plan_id: r.course.plan_id,
        has_overview: core.courses.getOverview(r.course.id) != null,
        lessons: r.lessons.map((l) => ({ day: l.day, title: l.title, is_sample: l.is_sample, estimated_minutes: l.estimated_minutes })),
        idempotent: r.idempotent,
        confirmation_expired: r.confirmation_expired,
        hint: r.confirmation_expired ? '样课内容已变更：用户先前的确认已过期，需在 App 重新确认' : undefined,
      };
    })(),
);

server.tool(
  'list_courses',
  '查询已导入的课程（含大纲/状态/绑定计划/样课确认状态与待执行请求数）',
  {},
  wrap(() =>
    core.courses.listCourses().map((c) => ({
      ...c,
      has_overview: core.courses.getOverview(c.id) != null,
      pending_requests: core.courses.listRequests({ course_id: c.id, status: 'pending' }).length,
      lesson_days: core.courses.listLessons(c.id).map((l) => l.day),
    })),
  ),
);

server.tool(
  'get_course_overview',
  '读取独立课程总览的已消毒 HTML（不属于 D1..Dn，也不计入每日讲义进度）；旧课程尚未生成总览时返回 null',
  { course_id: z.number().int().positive() },
  async ({ course_id }) => wrap(() => {
    const overview = core.courses.getOverview(course_id);
    return overview ? { overview, html: core.courses.readOverviewHtml(overview) } : null;
  })(),
);

server.tool(
  'get_course_lessons',
  '查询课程全部讲义元数据（day/标题/样课/概念/代码导读/答题状态）',
  { course_id: z.number().int().positive() },
  async ({ course_id }) => wrap(() => core.courses.listLessons(course_id))(),
);

server.tool(
  'get_lesson_html',
  '读取某天讲义的已消毒 HTML 正文（App 同源；路径越界拒绝）',
  { course_id: z.number().int().positive(), day: z.number().int().positive() },
  async ({ course_id, day }) =>
    wrap(() => {
      const lesson = core.courses.getLesson(course_id, day);
      return { lesson, html: core.courses.readLessonHtml(lesson) };
    })(),
);

server.tool(
  'submit_lesson_quiz',
  '提交某天自测答案（学习痕迹，非掌握证据——内容生成与答题不算掌握，掌握仍走 record_study_assessment）',
  {
    course_id: z.number().int().positive(),
    day: z.number().int().positive(),
    answers: z.array(z.object({ question_id: z.string(), picked: z.number().int().nonnegative() })).min(1),
  },
  async ({ course_id, day, answers }) => wrap(() => core.courses.submitQuiz(course_id, day, answers))(),
);

// 注：样课确认（confirmSample）不暴露为 MCP 工具——确认是用户在 App 内的亲自动作，
// agent 不得代用户确认（core confirmSample 同时校验样课已读）。App 走自己的 IPC 通道调用。

server.tool(
  'create_course_request',
  '为已确认样课的课程创建完整版生成请求（排队待执行，非立即生成）。仅样课已确认且未过期时允许；幂等（已有 pending 不重复）。生成由外部 agent 认领处理（list_course_requests → claim → 生成 → import 完整包 → complete）',
  { course_id: z.number().int().positive(), requested_by: z.string().optional() },
  async ({ course_id, requested_by }) => wrap(() => core.courses.createGenerationRequest(course_id, requested_by ?? 'mcp'))(),
);

server.tool(
  'list_course_requests',
  '查询课程生成请求队列（默认全部；可按状态过滤）——agent 定期查 pending 即可发现待执行请求',
  { status: z.enum(['pending', 'claimed', 'done', 'failed']).optional(), course_id: z.number().int().positive().optional() },
  async (input) => wrap(() => core.courses.listRequests(input))(),
);

server.tool(
  'claim_course_request',
  'agent 认领一个 pending 生成请求（claimed；样课哈希与课程确认一致才放行，批准过期拒绝）。认领后生成完整课程包（在 TodoDesk 外），再 import_course 导入完整包，最后 complete_course_request',
  { request_id: z.number().int().positive(), claimed_by: z.string().min(1) },
  async ({ request_id, claimed_by }) => wrap(() => core.courses.claimRequest(request_id, claimed_by))(),
);

server.tool(
  'complete_course_request',
  '完成生成请求（须先 import 完整包；claimed→done；课程标记 complete）。校验：样课确认哈希与请求批准一致（过期拒绝）+ 天数为第 1..N 天连续完整（有缺口拒绝；绑定计划的课程须覆盖计划全部天数，绑定计划已删除亦拒绝——删计划/换绑短计划不能掩护短包）。幂等',
  { request_id: z.number().int().positive(), claimed_by: z.string().min(1) },
  async ({ request_id, claimed_by }) => wrap(() => core.courses.completeRequest(request_id, claimed_by))(),
);

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

// ---------- 学习闭环（v1：草案→会话→测评→调整→卡片，agent 第一操作者） ----------

const STUDY_TOOL_CHAIN = [
  'get_study_workflow / draft_study_plan / confirm_study_plan_draft / cancel_study_plan_draft',
  'draft_study_topic / update_study_topic_draft / preview_study_draft_schedule / schedule_study_draft（无日期专题草案：先存后排期）',
  'record_study_session / record_study_assessment / get_mastery',
  'suggest_plan_adjustments / apply_plan_adjustments',
  'preview_study_cards / export_study_cards',
];

server.tool(
  'get_study_workflow',
  '获取 TodoDesk 学习闭环的完整执行规范（目标澄清→先修诊断→草案（可先无日期保存）→排期预览与提交→每日学习会话→测评留证→复盘调整→知识卡片沉淀的 agent 操作规范与全部透明规则）。用户说「学习 X」「帮我安排学习」「这些专题先存着以后再学」时先读它，再按规范执行；内容与 App 帮助面板同源',
  {},
  wrap(() => ({ spec_version: '2026-10-v2', tool_chain: STUDY_TOOL_CHAIN, spec_markdown: studyWorkflowSpec })),
);

const knowledgePointSchema = z.object({
  key: z.string().min(1).describe('知识点稳定标识，小写 slug（如 matrix-multiply），卡片与会话靠它关联'),
  name: z.string().min(1).describe('知识点名称（如 矩阵乘法）'),
  depends_on: z.array(z.string()).optional().describe('依赖的其他知识点 key（拓扑排序用）'),
  est_minutes: z.number().int().positive().max(600).optional().describe('预计学习时长（分钟），缺省 60 并记入假设'),
  outcome: z.string().optional().describe('可验证成果：学完如何证明掌握（缺省会记入假设提醒补充）'),
});

server.tool(
  'draft_study_plan',
  '生成学习计划**草案**（预览载体）：输入目标、材料来源、每日时间预算与知识点分解，TodoDesk 按透明规则（依赖拓扑排序 + 每日预算装箱）排出逐日安排。此时不创建计划/待办/打卡——先把逐日安排与 assumptions（缺失信息假设）念给用户，用户同意后调 confirm_study_plan_draft 才生效。用户说「学习线性代数」等诉求在此工具完成计划编制',
  {
    title: z.string().min(1).describe('计划标题，如「线性代数入门」'),
    goal: z.string().optional().describe('学习目标（学完能做什么）'),
    material_source: z.string().optional().describe('材料来源（书名/课程/链接），会随会话与卡片记录'),
    daily_minutes: z.number().int().min(10).max(600).describe('每日时间预算（分钟）——先向用户澄清，不要拍脑袋'),
    start_date: dateSchema.describe('开始日期，支持 today/明天 等别名'),
    knowledge_points: z.array(knowledgePointSchema).min(1).describe('知识点分解清单（由你按目标与先修诊断给出，TodoDesk 不代拟）'),
    notes: z.string().optional(),
  },
  async (input) =>
    wrap(() => {
      const draft = core.study.draft(input);
      return {
        draft_id: draft.id,
        status: draft.status,
        date_range: `${draft.start_date} ~ ${draft.end_date}`,
        daily_schedule: draft.items,
        assumptions: draft.assumptions,
        hint: `草案已生成（未创建计划）。请把逐日安排与假设告知用户：确认 → confirm_study_plan_draft(draft_id=${draft.id})；取消 → cancel_study_plan_draft。重复确认幂等`,
      };
    })(),
);

server.tool(
  'list_study_drafts',
  '查询学习计划草案列表（默认全部；status: draft 待确认 / confirmed 已确认 / cancelled 已取消）。用户想看「待我确认的学习计划」时用 status=draft',
  { status: z.enum(['draft', 'confirmed', 'cancelled']).optional() },
  async ({ status }) => wrap(() => core.study.listDrafts(status))(),
);

server.tool(
  'get_study_draft',
  '查看单个学习计划草案详情（逐日安排、知识点、假设、状态）',
  { id: z.number().int().positive() },
  async ({ id }) => wrap(() => core.study.getDraft(id))(),
);

server.tool(
  'confirm_study_plan_draft',
  '确认草案为正式学习计划（生成逐日条目与对应待办，进入今日面板/待办列表）。幂等：对已确认草案重复调用返回原计划不重复创建。必须先把预览念给用户并取得同意。**确认边界冲突硬校验**（经 schedule_study_draft 排期的草案）：排期后既有计划变动可能引入新的超预算冲突——确认时服务端重算，若存在超预算日期必须把用户确认的集合作为 confirmed_over_dates 传回且与重算精确一致，否则拒绝（须重新预览排期）。旧路径草案（draft_study_plan 创建即排期）不设此冲突门',
  {
    draft_id: z.number().int().positive(),
    confirmed_over_dates: z.array(dateSchema).optional().describe('用户确认接受的超预算日期：与当下重算结果完全一致；无冲突则不传'),
  },
  async ({ draft_id, confirmed_over_dates }) =>
    wrap(() => {
      const { draft, plan } = core.study.confirmDraft(draft_id, { confirmed_over_dates });
      return {
        draft_status: draft.status,
        plan_id: plan.id,
        title: plan.title,
        date_range: `${plan.start_date} ~ ${plan.end_date}`,
        item_count: plan.items.length,
        todos_created: plan.items.filter((i) => i.todo_id).length,
        plan,
      };
    })(),
);

server.tool(
  'cancel_study_plan_draft',
  '取消学习计划草案（无任何副作用：不产生/不删除计划与待办，重复取消幂等）。已确认的草案不能取消，请改用计划的归档',
  { draft_id: z.number().int().positive() },
  async ({ draft_id }) => wrap(() => core.study.cancelDraft(draft_id))(),
);

// ---------- 无日期学习专题草案（日期待排期、未确认：不排日程、不产待办、不占预算） ----------

const topicKnowledgePointSchema = knowledgePointSchema;

server.tool(
  'draft_study_topic',
  '保存**无日期学习专题草案**：用户尚未给出起始日期与每日预算（如「这六份专题文稿先存着，什么时候学再定」）时用它。只保存主题大纲、知识点分解、材料来源与可选的样课课程关联（course_id，样课未确认也可关联）——**不排日程、不产待办、不占每日预算**。创建时即校验知识点（key 格式/依赖/环）。待用户给出日期与预算后走 preview_study_draft_schedule → schedule_study_draft → confirm_study_plan_draft。用户已给出日期与预算时直接用 draft_study_plan',
  {
    title: z.string().min(1).describe('专题标题，如「Rust 专题：所有权」'),
    goal: z.string().optional().describe('学习目标（学完能做什么）'),
    material_source: z.string().optional().describe('材料来源（文稿/书/课程/链接）'),
    knowledge_points: z.array(topicKnowledgePointSchema).min(1).describe('知识点分解清单（依赖拓扑在创建时即校验，但此时不排日期）'),
    course_id: z.number().int().positive().nullable().optional().describe('关联课程 id（可为样课尚未确认的课程；仅信息性关联，不改课程绑定，课程与计划的绑定仍以课程包导入为准）'),
    notes: z.string().optional(),
  },
  async (input) =>
    wrap(() => {
      const draft = core.study.draftDateless(input);
      return {
        draft_id: draft.id,
        status: draft.status,
        scheduled: false,
        knowledge_point_count: draft.knowledge_points.length,
        course_id: draft.course_id,
        assumptions: draft.assumptions,
        hint: `无日期专题草案已保存（未排期：不排日程、不产待办、不占预算）。待用户给出起始日期与每日预算后：preview_study_draft_schedule(draft_id=${draft.id}) 预览冲突与依赖 → 用户确认 → schedule_study_draft 排期 → confirm_study_plan_draft 生成计划`,
        draft,
      };
    })(),
);

server.tool(
  'update_study_topic_draft',
  '更新**未排期**专题草案的内容（标题/目标/材料/知识点/样课课程关联/备注；知识点整体替换并重新校验）。仅草案未排期且未确认时可改；已排期后内容锁定，调整请取消重建',
  {
    draft_id: z.number().int().positive(),
    title: z.string().min(1).optional(),
    goal: z.string().optional().nullable(),
    material_source: z.string().optional().nullable(),
    knowledge_points: z.array(topicKnowledgePointSchema).min(1).optional().describe('整体替换知识点清单'),
    course_id: z.number().int().positive().nullable().optional().describe('传 null 清除关联'),
    notes: z.string().optional().nullable(),
  },
  async ({ draft_id, ...patch }) =>
    wrap(() => {
      const draft = core.study.updateDraftMeta(draft_id, patch);
      return { draft_id: draft.id, status: draft.status, scheduled: draft.start_date != null, draft };
    })(),
);

server.tool(
  'preview_study_draft_schedule',
  '**排期预览（只读，不写库）**：用户给出起始日期与每日预算后，先把无日期草案（或已排期未确认草案）的排期结果念给用户——逐日安排、知识点依赖拓扑顺序、与其他**进行中计划**的每日预算冲突（既有占用+新排超预算的日子，汇总在返回的 over_budget_dates）与知识点重复预警、透明规则假设。用户逐条确认冲突后调 schedule_study_draft 并把 over_budget_dates 原样作为 confirmed_over_dates 传回。有依赖环或参数非法在此即报错',
  {
    draft_id: z.number().int().positive(),
    start_date: dateSchema.describe('起始日期，支持 today/明天 等别名'),
    daily_minutes: z.number().int().min(10).max(600).describe('每日时间预算（分钟）——用用户亲口给的数'),
  },
  async ({ draft_id, start_date, daily_minutes }) =>
    wrap(() => {
      const preview = core.study.previewDraftSchedule(draft_id, start_date, daily_minutes);
      return {
        ...preview,
        hint:
          preview.warnings.length > 0
            ? `预览完成但有 ${preview.warnings.length} 条预警，必须先向用户逐条说明并取得同意：${preview.warnings.join('；')}`
            : '预览完成：把逐日安排、依赖顺序与假设念给用户；用户确认 → schedule_study_draft（同参数提交，幂等）',
      };
    })(),
);

server.tool(
  'schedule_study_draft',
  '**排期提交（事务+幂等+冲突硬校验）**：把用户确认过的起始日期与每日预算写入草案并按透明规则生成逐日安排。**硬校验**：服务端按当下库状态重算超预算日期——若预览的 over_budget_dates 非空，必须把它原样作为 confirmed_over_dates 传回且与重算精确一致（预览后有新冲突/冲突已消失都会拒绝，须重新预览）；无冲突时不传。同参数重复提交幂等；已确认/已取消的草案拒绝。排期后仍是草案——生成正式计划还需 confirm_study_plan_draft（确认时同样硬校验冲突，须再带一次最新确认集）',
  {
    draft_id: z.number().int().positive(),
    start_date: dateSchema.describe('起始日期（与预览一致）'),
    daily_minutes: z.number().int().min(10).max(600).describe('每日时间预算（分钟，与预览一致）'),
    confirmed_over_dates: z.array(dateSchema).optional().describe('用户确认接受的超预算日期：与最新预览的 over_budget_dates 完全一致（排序无关）；无冲突则不传'),
  },
  async ({ draft_id, start_date, daily_minutes, confirmed_over_dates }) =>
    wrap(() => {
      const draft = core.study.scheduleDraft(draft_id, start_date, daily_minutes, { confirmed_over_dates });
      return {
        draft_id: draft.id,
        status: draft.status,
        date_range: `${draft.start_date} ~ ${draft.end_date}`,
        daily_minutes: draft.daily_minutes,
        item_count: draft.items.length,
        hint: `草案已排期（${draft.start_date} ~ ${draft.end_date}，每日 ${draft.daily_minutes}m，重复提交幂等）。把逐日安排念给用户，用户同意后 confirm_study_plan_draft(draft_id=${draft.id}, confirmed_over_dates=当前超预算日期集) 生成正式计划与待办`,
      };
    })(),
);


server.tool(
  'record_study_session',
  '记录一次**独立学习会话**（当日学习完成的凭证）：实际用时、用自己的话写的解释/答案、疑问、材料来源。同一目标多次学习用 attempt 区分（1,2,3…）。幂等：重试请带同一稳定 id；不传 id 时按（目标条目 或 知识点+日期, attempt）复用',
  {
    id: z.string().optional().describe('稳定会话 id（重试/更新同一会话时传同一个，如 sess-matrix-mult-a1）'),
    plan_id: z.number().int().positive().optional(),
    plan_item_id: z.number().int().positive().optional().describe('对应计划条目 id（从 get_study_plan/get_today 拿）'),
    knowledge_key: z.string().min(1).describe('知识点稳定标识，与草案 knowledge_points[].key 一致'),
    topic: z.string().optional().describe('主题名称，缺省用知识点名'),
    attempt: z.number().int().positive().optional().describe('第几次尝试；不传 = 该目标的下一次尝试'),
    date: dateSchema.optional().describe('会话日期，缺省今天'),
    actual_minutes: z.number().int().min(1).max(1440).describe('实际用时（分钟）'),
    explanation: z.string().optional().describe('自己的解释/答案（费曼式输出，越具体越好）'),
    questions: z.string().optional().describe('没解决的疑问'),
    material_source: z.string().optional().describe('本次用的材料（章节/链接）'),
  },
  async (input) =>
    wrap(() => {
      const session = core.study.recordSession(input);
      return { session_id: session.id, attempt: session.attempt, session };
    })(),
);

server.tool(
  'list_study_sessions',
  '查询学习会话记录（按计划/条目/知识点/日期范围过滤，含每次尝试）',
  {
    plan_id: z.number().int().positive().optional(),
    plan_item_id: z.number().int().positive().optional(),
    knowledge_key: z.string().optional(),
    since: dateSchema.optional(),
    until: dateSchema.optional(),
    limit: z.number().int().positive().max(1000).optional(),
  },
  async (input) => wrap(() => core.study.listSessions(input))(),
);

server.tool(
  'record_study_assessment',
  '记录一次**测评证据**：题目、评价标准、原答案、评分/反馈与依据。source 必须显式：self=用户自评（可被后续纠正，历史保留）；objective=客观测试（必须附真实判题依据 evidence 与判题结果，TodoDesk 不代判不伪造）；ai_suggestion=AI 建议性反馈（仅记录，不计入掌握证据）。同一 id 或同一会话同一题重复提交=更新（内容有实质变化才追加 corrections，保留旧答案/反馈/依据）。掌握度按计划隔离：传 plan_id 或 session_id（自动归属其计划）才会计入该计划的 get_mastery',
  {
    id: z.string().optional().describe('稳定测评 id（纠正/重试同一测评时传同一个）'),
    session_id: z.string().optional().describe('关联的学习会话 id'),
    plan_id: z.number().int().positive().optional(),
    plan_item_id: z.number().int().positive().optional(),
    knowledge_key: z.string().min(1),
    topic: z.string().optional(),
    question: z.string().min(1).describe('测评题目'),
    criteria: z.string().optional().describe('评价标准（怎样算答好）'),
    answer: z.string().min(1).describe('当时的原答案（保留原样，不修饰）'),
    source: z.enum(['self', 'objective', 'ai_suggestion']).describe('评价来源'),
    score: z.number().int().min(0).max(100).nullable().optional().describe('0~100 分；客观题填判题得分'),
    objective_passed: z.boolean().nullable().optional().describe('objective 必填：实际判题是否通过'),
    feedback: z.string().optional().describe('评语/反馈'),
    evidence: z.string().optional().describe('依据：objective 必填（判题过程与结果）；self 建议填自评理由'),
    date: dateSchema.optional(),
  },
  async (input) =>
    wrap(() => {
      const assessment = core.study.recordAssessment(input);
      return { assessment_id: assessment.id, corrections: assessment.corrections, assessment };
    })(),
);

server.tool(
  'list_study_assessments',
  '查询测评记录（按计划/知识点/会话/来源过滤）',
  {
    plan_id: z.number().int().positive().optional(),
    knowledge_key: z.string().optional(),
    session_id: z.string().optional(),
    source: z.enum(['self', 'objective', 'ai_suggestion']).optional(),
    limit: z.number().int().positive().max(1000).optional(),
  },
  async (input) => wrap(() => core.study.listAssessments(input))(),
);

server.tool(
  'get_mastery',
  '查看知识点**掌握情况**（与任务完成率分开呈现）：每个知识点的判定（unknown 未知/weak 薄弱/reviewing 巩固中/strong 良好）、证据条数、最新测评来源与得分、中文判定依据。无测评证据=unknown——打卡完成不等于掌握。可按计划（plan_id）或知识点清单查询',
  {
    plan_id: z.number().int().positive().optional().describe('按计划查（取计划全部知识点）'),
    knowledge_keys: z.array(z.string()).optional().describe('按知识点清单查'),
  },
  async ({ plan_id, knowledge_keys }) =>
    wrap(() => {
      const report = core.study.getMastery({ plan_id, knowledge_keys });
      return { ...report, note: '完成率(plan_progress)只代表打卡进度；掌握度(mastery)只看测评证据' };
    })(),
);

server.tool(
  'suggest_plan_adjustments',
  '为计划的**未完成**条目生成调整建议（纯预览，不写库）：漏做条目→改期到预算有空位的日期；**依赖联动**→后继条目早于其未完成前置（含改期后的生效日期）时一并顺延，绝不让后继排在前置之前（已完成/已跳过的前置视为已满足）；掌握薄弱(weak)的知识点→追加针对性复习条目。每条建议附透明依据（引用漏做事实、依赖关系或测评证据）。先展示给用户，同意后调 apply_plan_adjustments',
  { plan_id: z.number().int().positive() },
  async ({ plan_id }) =>
    wrap(() => {
      const suggestions = core.study.suggestAdjustments(plan_id);
      return { count: suggestions.length, suggestions, hint: '预览不写库；确认应用 → apply_plan_adjustments；不应用则无任何变更' };
    })(),
);

server.tool(
  'apply_plan_adjustments',
  '应用调整建议（写库）：入参必须携带**预览时看到的 to_date**（快照绑定）——建议已失效或建议日期因计划变化而不同都会拒绝该条并说明，绝不静默执行未确认的日期。**依赖组完整性**：只勾选前置改期而落下其后继的联动建议会被整组拒绝（提示需一起勾选），落库计划永不出现后继早于未完成前置。只动未完成条目：改期同步关联待办截止日并按需延长计划；补复习创建新条目与待办。必须先经 suggest 预览并取得用户确认',
  {
    plan_id: z.number().int().positive(),
    suggestions: z
      .array(
        z.object({
          id: z.string().min(1).describe('预览返回的建议 id'),
          to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('预览返回的 to_date（YYYY-MM-DD），与应用时重算结果不一致即拒绝'),
        }),
      )
      .min(1)
      .describe('要应用的建议快照列表（把预览确认的结果原样传入）'),
  },
  async ({ plan_id, suggestions }) => wrap(() => core.study.applyAdjustments(plan_id, suggestions))(),
);

const cardSelectorSchema = {
  plan_id: z.number().int().positive().optional().describe('按计划选择会话'),
  knowledge_keys: z.array(z.string()).optional().describe('按知识点选择会话'),
  session_ids: z.array(z.string()).optional().describe('按会话 id 精确选择'),
};

server.tool(
  'preview_study_cards',
  '预览待审知识卡片（Obsidian Markdown，纯内存不落盘）：由真实学习会话生成，含我的解释/疑问/测评证据/材料，frontmatter 带 status: draft 与 verified: false。先给用户预览，确认目录后 export_study_cards',
  { ...cardSelectorSchema },
  async (selector) =>
    wrap(() => {
      const cards = core.study.previewCards(selector);
      return { count: cards.length, cards, hint: '预览不写文件；导出需用户明确指定目录' };
    })(),
);

server.tool(
  'export_study_cards',
  '把待审卡片导出为 Obsidian Markdown 文件到用户**明确指定的独立目录**。红线（core 层硬拒绝，非提示）：目录不得位于任何知识库 vault 内——含已注册 vault、内置默认保护根（~/Desktop/knowledge-base，即使未注册）与 TODODESK_PROTECTED_DIRS 指定目录，符号链接别名同样拦截。防重规则：内容一致跳过；文件被人工编辑过绝不覆盖（protected 列出）；源会话更新且文件未被编辑过才重导。导出记录持久化，可查 list_card_exports',
  {
    ...cardSelectorSchema,
    export_dir: z.string().min(1).describe('导出目录的绝对路径（必须来自用户确认，测试用临时目录）'),
  },
  async ({ export_dir, ...selector }) => wrap(() => core.study.exportCards(selector, export_dir))(),
);

server.tool(
  'list_card_exports',
  '查询卡片导出历史（card_key、文件路径、内容哈希、时间），用于判断哪些会话已沉淀过',
  {},
  wrap(() => core.study.listCardExports()),
);

// ---------- 工具箱 ----------

/** category_name → id：分类不存在时自动创建（agent 一句话完成「放进某分类」）；传 null 表示未分类 */
function resolveCategoryId(name?: string | null): number | null {
  if (name == null || !name.trim()) return null;
  const trimmed = name.trim();
  const found = core.tools.listCategories().find((c) => c.name === trimmed);
  return found ? found.id : core.tools.addCategory({ name: trimmed }).id;
}

/** file_paths / files 双通道归一为 base64 文件集合（二选一） */
function gatherToolFiles(filePaths?: string[], files?: Array<{ name: string; content_base64: string }>): Array<{ name: string; contentBase64: string }> {
  if (filePaths?.length && files?.length) throw new Error('file_paths 与 files 只能二选一');
  if (filePaths?.length) return collectToolFilesFromPaths(filePaths);
  if (files?.length) return files.map((f) => ({ name: f.name, contentBase64: f.content_base64 }));
  return [];
}

server.tool(
  'list_tools',
  '查看工具箱：全部小工具（标题/图标/分类/入口文件/文件清单）与分类列表。用户想了解 App 里装了哪些工具、或 add/update/delete_tool 需要拿 id 时调用',
  {},
  wrap(() => {
    const cats = core.tools.listCategories();
    const catName = new Map(cats.map((c) => [c.id, c.name]));
    const tools = core.tools.listTools().map((t) => ({
      id: t.id,
      title: t.title,
      icon: t.icon,
      category_id: t.category_id,
      category_name: t.category_id != null ? catName.get(t.category_id) ?? null : null,
      entry_file: t.entry_file,
      files: listToolFiles(toolFilesRoot, t.id),
    }));
    return { count: tools.length, categories: cats, tools };
  }),
);

server.tool(
  'add_tool',
  '把一个 HTML 小工具装入 App 工具箱——用户说「把这个 html/文件加到工具箱」「帮我做个小工具放进去」时调用。文件来源二选一：file_paths（本地文件或目录路径，目录递归收集，适合已有文件）或 files（base64 内容，适合你现场生成的 HTML，无需落盘）。entry_file 缺省取 index.html；category_name 不存在会自动创建分类',
  {
    title: z.string().min(1).describe('工具名，如「色板转换器」'),
    icon: z.string().optional().describe('图标名，默认 tool'),
    category_name: z.string().nullable().optional().describe('分类名，不存在自动创建；缺省未分类，传 null 强制未分类'),
    file_paths: z.array(z.string().min(1)).optional().describe('本地文件/目录路径列表（工具 HTML 及 css/js/图片等配套资源）'),
    files: z
      .array(z.object({ name: z.string().min(1), content_base64: z.string().min(1) }))
      .optional()
      .describe('文件内容列表，name 可含子目录（如 assets/app.js）'),
    entry_file: z.string().optional().describe('HTML 入口相对路径，缺省 index.html 或唯一 html 文件'),
  },
  async ({ title, icon, category_name, file_paths, files, entry_file }) =>
    wrap(() => {
      const list = gatherToolFiles(file_paths, files);
      if (list.length === 0) throw new Error('未提供任何文件：需要 file_paths 或 files 之一');
      const names = list.map((f) => sanitizeToolPath(f.name));
      const entry = entry_file ? sanitizeToolPath(entry_file) : pickEntryFile(names);
      if (!names.includes(entry)) throw new Error(`entry_file "${entry}" 不在文件列表中`);
      const tool = core.tools.addTool({ title, icon, category_id: resolveCategoryId(category_name), entry_file: entry });
      try {
        saveToolFilesTo(toolFilesRoot, tool.id, list);
      } catch (e) {
        core.tools.deleteTool(tool.id); // 文件写失败回滚，不留半成品
        throw new Error(`工具文件写入失败，已回滚：${e instanceof Error ? e.message : String(e)}`);
      }
      return { tool, files: listToolFiles(toolFilesRoot, tool.id) };
    })(),
);

server.tool(
  'update_tool',
  '修改工具箱里的工具：改名/图标/分类/入口文件，或整体替换文件（file_paths / files 二选一，语义同 add_tool；不传文件则不动现有文件）',
  {
    id: z.number().int().positive(),
    title: z.string().min(1).optional(),
    icon: z.string().optional(),
    category_name: z.string().nullable().optional().describe('分类名（不存在自动创建）；传 null 移到未分类'),
    entry_file: z.string().optional(),
    file_paths: z.array(z.string().min(1)).optional(),
    files: z.array(z.object({ name: z.string().min(1), content_base64: z.string().min(1) })).optional(),
  },
  async ({ id, title, icon, category_name, entry_file, file_paths, files }) =>
    wrap(() => {
      const patch: Record<string, unknown> = {};
      if (title !== undefined) patch.title = title;
      if (icon !== undefined) patch.icon = icon;
      if (category_name !== undefined) patch.category_id = resolveCategoryId(category_name);
      if (entry_file !== undefined) patch.entry_file = sanitizeToolPath(entry_file);
      const list = gatherToolFiles(file_paths, files);
      if (list.length > 0) {
        const names = list.map((f) => sanitizeToolPath(f.name));
        const entry = entry_file ? sanitizeToolPath(entry_file) : pickEntryFile(names);
        if (!names.includes(entry)) throw new Error(`entry_file "${entry}" 不在文件列表中`);
        patch.entry_file = entry;
      }
      const tool = core.tools.updateTool(id, patch as never);
      if (list.length > 0) saveToolFilesTo(toolFilesRoot, id, list);
      return { tool, files: listToolFiles(toolFilesRoot, id) };
    })(),
);

server.tool(
  'delete_tool',
  '从工具箱删除一个工具（连同其全部文件，不可恢复，请先与用户确认）',
  { id: z.number().int().positive() },
  async ({ id }) =>
    wrap(() => {
      core.tools.deleteTool(id);
      deleteToolFilesAt(toolFilesRoot, id);
      return { deleted: id };
    })(),
);

server.tool(
  'list_tool_categories',
  '查看工具箱全部分类（含每个分类下的工具数与工具名）',
  {},
  wrap(() => {
    const tools = core.tools.listTools();
    const categories = core.tools.listCategories().map((c) => ({
      ...c,
      tool_count: tools.filter((t) => t.category_id === c.id).length,
      tool_titles: tools.filter((t) => t.category_id === c.id).map((t) => t.title),
    }));
    return { count: categories.length, uncategorized: tools.filter((t) => t.category_id == null).length, categories };
  }),
);

server.tool(
  'add_tool_category',
  '新建一个工具箱分类',
  { name: z.string().min(1).describe('分类名（最长 24 字）') },
  async ({ name }) => wrap(() => core.tools.addCategory({ name }))(),
);

server.tool(
  'rename_tool_category',
  '重命名工具箱分类（其下工具不变）',
  {
    id: z.number().int().positive(),
    name: z.string().min(1),
  },
  async ({ id, name }) =>
    wrap(() => {
      core.tools.renameCategory(id, name);
      return true;
    })(),
);

server.tool(
  'delete_tool_category',
  '删除工具箱分类（其下工具自动变为未分类，工具本身保留）',
  { id: z.number().int().positive() },
  async ({ id }) =>
    wrap(() => {
      core.tools.deleteCategory(id);
      return true;
    })(),
);

// ---------- 本体（对象/链接/动作类型） ----------

server.tool(
  'list_object_types',
  '列出 TodoDesk 本体的全部对象类型、链接类型与动作类型（含属性、主键、标题属性、链接基数等元数据）。想了解这个 App 有哪些数据结构、或 query_objects/invoke_action 该传什么参数时先调这个',
  {},
  wrap(() => {
    const objects = core.ontology.listObjectTypes().map((t) => ({
      apiName: t.apiName,
      title: t.title,
      isSystem: t.isSystem,
      isVirtual: t.isVirtual,
      primaryKey: t.primaryKey,
      titleProperty: t.titleProperty,
      count: t.isVirtual ? null : core.objects.count(t.apiName),
      properties: t.properties.map((p) => ({
        apiName: p.apiName,
        dataType: p.dataType,
        nullable: p.nullable,
        enumValues: p.enumValues,
        origin: p.origin,
      })),
    }));
    const links = core.ontology.listLinkTypes();
    const actions = core.ontology.listActionTypes().map((a) => ({
      apiName: a.apiName,
      title: a.title,
      isBuiltin: a.isBuiltin,
      status: a.status,
      parameters: a.parameters,
      operations: a.operations,
    }));
    return { objectTypes: objects, linkTypes: links, actionTypes: actions };
  }),
);

server.tool(
  'query_objects',
  '按对象类型查询实例数据（支持任意对象类型，含用户自定义类型）。search 对文本属性模糊匹配；filters 支持等于/范围过滤；返回按主键倒序',
  {
    object_type: z.string().min(1).describe("对象类型 apiName，如 todo/plan_item/news_item，先用 list_object_types 查看全部"),
    search: z.string().optional().describe('对文本属性模糊搜索'),
    filters: z
      .array(
        z.object({
          property: z.string().min(1).describe('属性 apiName'),
          op: z.enum(['eq', 'ne', 'like', 'in', 'gte', 'lte']).describe('比较方式'),
          value: z.union([z.string(), z.number(), z.boolean(), z.null()]).describe('比较值'),
        }),
      )
      .optional()
      .describe('过滤条件，多个条件之间为 AND'),
    limit: z.number().int().positive().max(500).optional().describe('默认 50，最大 500'),
    offset: z.number().int().nonnegative().optional().describe('分页偏移'),
  },
  async ({ object_type, search, filters, limit, offset }) =>
    wrap(() => core.objects.list(object_type, { search, where: filters, limit, offset }))(),
);

server.tool(
  'invoke_action',
  '执行一个动作（内置动作如 add_todo/complete_todo/checkin，或用户在数据面板创建的自定义动作）。参数结构先用 list_object_types 查看 actionTypes 里的 parameters 定义',
  {
    action: z.string().min(1).describe('动作 apiName，如 add_todo / complete_todo / checkin'),
    params: z.record(z.string(), z.unknown()).optional().describe('动作参数，与动作定义的 parameters 对应'),
  },
  async ({ action, params }) => wrap(() => core.actions.execute(action, params ?? {}))(),
);

// ---------- 本体：通用实例 CRUD（任意对象类型，含自定义类型） ----------

const propertyInputSchema = z.object({
  api_name: z.string().min(1).describe('属性名，小写 snake_case（如 rating）'),
  data_type: z.enum(['string', 'integer', 'float', 'boolean', 'date', 'json', 'enum']).describe('数据类型'),
  nullable: z.boolean().optional().describe('是否可空，默认 true'),
  enum_values: z.array(z.string()).optional().describe('枚举取值清单（data_type=enum 时必填）'),
  indexed: z.boolean().optional().describe('是否建索引，默认否'),
});

type PropertyDataTypes = 'string' | 'integer' | 'float' | 'boolean' | 'date' | 'json' | 'enum';

const toPropertyInput = (p: { api_name: string; data_type: PropertyDataTypes; nullable?: boolean; enum_values?: string[]; indexed?: boolean }) => ({
  apiName: p.api_name,
  dataType: p.data_type,
  nullable: p.nullable ?? true,
  enumValues: p.enum_values,
  indexed: p.indexed,
});

server.tool(
  'get_object',
  '读取单个对象的完整详情：全部属性值 + 出链/入链（它引用了谁、谁引用了它）。配合 query_objects 拿到 id 后深入查看',
  {
    object_type: z.string().min(1).describe('对象类型 apiName'),
    id: z.union([z.string(), z.number()]).describe('对象主键值'),
  },
  async ({ object_type, id }) => wrap(() => {
    const row = core.objects.get(object_type, id);
    if (!row) throw new Error(`对象不存在：${object_type}#${String(id)}`);
    return { row, links: core.objects.resolveLinks(object_type, row) };
  })(),
);

server.tool(
  'create_object',
  '在任意对象类型（含用户自定义类型）上创建一条实例。注意：对系统类型（todo 等）建议优先用专用工具（add_todo 等，业务联动更完整），本工具主要服务自定义类型',
  {
    object_type: z.string().min(1).describe('对象类型 apiName'),
    values: z.record(z.string(), z.unknown()).describe('属性值（apiName → 值），必填属性不能缺省；id/created_at/updated_at 自动生成'),
  },
  async ({ object_type, values }) => wrap(() => core.objects.insert(object_type, values))(),
);

server.tool(
  'update_object',
  '按主键更新任意类型的对象实例（只传要改的字段）',
  {
    object_type: z.string().min(1).describe('对象类型 apiName'),
    id: z.union([z.string(), z.number()]).describe('对象主键值'),
    values: z.record(z.string(), z.unknown()).describe('要更新的属性值'),
  },
  async ({ object_type, id, values }) => wrap(() => core.objects.update(object_type, id, values))(),
);

server.tool(
  'delete_object',
  '按主键删除任意类型的对象实例。注意对系统类型这是裸删除，不走业务联动（删 todo 不会自动清打卡），慎用',
  {
    object_type: z.string().min(1).describe('对象类型 apiName'),
    id: z.union([z.string(), z.number()]).describe('对象主键值'),
  },
  async ({ object_type, id }) =>
    wrap(() => {
      core.objects.remove(object_type, id);
      return true;
    })(),
);

// ---------- 本体：类型管理（对象/链接/动作类型） ----------

server.tool(
  'create_object_type',
  '创建自定义对象类型（自动建表 ont_obj_<api_name>，附带 id/created_at/updated_at）。属性类型：string/integer/float/boolean/date/json/enum。建好后即可用 create_object 写入、create_link_type 建关系',
  {
    api_name: z.string().min(1).describe('类型标识，小写 snake_case（如 book）'),
    title: z.string().min(1).describe('显示名（如 书）'),
    description: z.string().optional().describe('说明'),
    title_property: z.string().optional().describe('列表主显属性，默认第一个属性'),
    properties: z.array(propertyInputSchema).describe('属性清单（不含自动附带的 id/created_at/updated_at）'),
  },
  async ({ api_name, title, description, title_property, properties }) =>
    wrap(() =>
      core.ontology.createObjectType({
        apiName: api_name,
        title,
        description,
        titleProperty: title_property,
        properties: properties.map(toPropertyInput),
      }),
    )(),
);

server.tool(
  'update_object_type',
  '修改对象类型：改显示名/说明/标题属性、追加属性（自动加列）、删除后加的属性（连同该列数据）。内置属性受保护不可删；删除被链接或动作引用的属性会被拒绝',
  {
    api_name: z.string().min(1).describe('对象类型 apiName'),
    patch: z
      .object({
        title: z.string().optional(),
        description: z.string().optional(),
        title_property: z.string().optional().describe('标题属性 apiName'),
        add_properties: z.array(propertyInputSchema).optional().describe('要追加的属性（系统类型只允许可空属性）'),
        drop_property: z.string().optional().describe('要删除的属性 apiName（仅限后加属性）'),
      })
      .describe('要修改的字段，只传需要改的'),
  },
  async ({ api_name, patch }) =>
    wrap(() =>
      core.ontology.updateObjectType(api_name, {
        title: patch.title,
        description: patch.description,
        titleProperty: patch.title_property,
        addProperties: patch.add_properties?.map(toPropertyInput),
        dropProperty: patch.drop_property,
      }),
    )(),
);

server.tool(
  'delete_object_type',
  '删除自定义对象类型：连同物理表与全部数据，不可恢复。系统类型不可删。仍被链接或动作引用时会被拒绝（先删引用方）',
  {
    api_name: z.string().min(1).describe('对象类型 apiName'),
  },
  async ({ api_name }) =>
    wrap(() => {
      core.ontology.deleteObjectType(api_name);
      return true;
    })(),
);

server.tool(
  'create_link_type',
  '创建链接类型（对象间关系）。一对一/一对多：外键属性须已存在于右（多）侧类型上且与左侧主键同类型（可先用 update_object_type 加）；多对多：须先建一个中间表对象类型并带左右两个引用属性',
  {
    api_name: z.string().min(1).describe('链接标识，小写 snake_case（如 folder__note）'),
    title: z.string().optional().describe('显示名，缺省用 api_name'),
    left_type: z.string().min(1).describe('「一」侧类型 apiName'),
    right_type: z.string().min(1).describe('「多」侧类型 apiName（外键挂这侧）'),
    cardinality: z.enum(['one_to_one', 'one_to_many', 'many_to_many']).describe('基数'),
    fk_column: z.string().optional().describe('一对一/一对多必填：right 侧的外键属性 apiName'),
    link_table: z.string().optional().describe('多对多必填：中间表对象类型 apiName'),
    backing_left_property: z.string().optional().describe('多对多必填：中间表上指向 left 主键的属性'),
    backing_right_property: z.string().optional().describe('多对多必填：中间表上指向 right 主键的属性'),
  },
  async (input) =>
    wrap(() =>
      core.ontology.createLinkType({
        apiName: input.api_name,
        title: input.title ?? input.api_name,
        leftType: input.left_type,
        rightType: input.right_type,
        cardinality: input.cardinality,
        fkColumn: input.fk_column,
        linkTable: input.link_table,
        backingLeftProperty: input.backing_left_property,
        backingRightProperty: input.backing_right_property,
      }),
    )(),
);

server.tool(
  'delete_link_type',
  '删除自定义链接类型（纯元数据操作，不动实例数据）。仍被动作引用时会被拒绝',
  {
    api_name: z.string().min(1).describe('链接类型 apiName'),
  },
  async ({ api_name }) =>
    wrap(() => {
      core.ontology.deleteLinkType(api_name);
      return true;
    })(),
);

server.tool(
  'create_action_type',
  '创建自定义动作：参数 + 按顺序执行的写规则，执行时单事务（全部成功或全部回滚）。operations 形态与 list_object_types 返回的一致：{kind: "create_object"|"modify_object"|"delete_object"|"create_link"|"delete_link", objectType?, linkType?, propertyMappings?: {属性: {source:{parameter:"参数名"}}|{literal:值}|{fn:"now"|"uuid"}}, selector?: {property, value}, leftId?, rightId?}',
  {
    api_name: z.string().min(1).describe('动作标识，小写 snake_case（如 log_reading）'),
    title: z.string().min(1).describe('显示名'),
    description: z.string().optional().describe('说明'),
    parameters: z
      .array(
        z.object({
          name: z.string().min(1).describe('参数名，小写 snake_case'),
          data_type: z.enum(['string', 'integer', 'float', 'boolean', 'date', 'json']).describe('参数类型'),
          required: z.boolean().optional().describe('是否必填，默认否'),
          description: z.string().optional(),
        }),
      )
      .describe('参数清单'),
    operations: z
      .array(z.record(z.string(), z.unknown()))
      .min(1)
      .describe('写规则数组（见工具描述中的形态说明），引用的参数必须已声明'),
  },
  async ({ api_name, title, description, parameters, operations }) =>
    wrap(() =>
      core.ontology.createActionType({
        apiName: api_name,
        title,
        description,
        parameters: parameters.map((p) => ({ name: p.name, dataType: p.data_type, required: p.required ?? false, description: p.description })),
        operations: operations as never,
      }),
    )(),
);

server.tool(
  'update_action_type',
  '修改动作类型：改显示名/说明/启停状态。内置动作不可删除但可停用（停用后 invoke_action 拒绝执行）',
  {
    api_name: z.string().min(1).describe('动作 apiName'),
    patch: z
      .object({
        title: z.string().optional(),
        description: z.string().optional(),
        status: z.enum(['active', 'disabled']).optional().describe('启停状态'),
      })
      .describe('要修改的字段'),
  },
  async ({ api_name, patch }) => wrap(() => core.ontology.updateActionType(api_name, patch))(),
);

server.tool(
  'delete_action_type',
  '删除自定义动作类型（内置动作不可删，可停用）',
  {
    api_name: z.string().min(1).describe('动作 apiName'),
  },
  async ({ api_name }) =>
    wrap(() => {
      core.ontology.deleteActionType(api_name);
      return true;
    })(),
);

// ---------- 知识库 vault（只读联动） ----------

server.tool(
  'register_vault',
  '注册一个 Obsidian 知识库目录做只读索引（用户知情后使用；只写 TodoDesk 自己的索引库，绝不写 vault 文件、不触发 Git）。默认索引 knowledge/moc、knowledge/resources、knowledge/inbox-cards，不含 raw',
  {
    root_path: z.string().min(1).describe('vault 根目录绝对路径'),
    name: z.string().optional().describe('显示名，缺省取目录名'),
    include_dirs: z.array(z.string()).optional().describe('参与索引的子目录（相对路径）'),
    include_raw: z.boolean().optional().describe('是否索引 raw/ 原料区，默认 false'),
  },
  async ({ root_path, name, include_dirs, include_raw }) =>
    wrap(() => core.vaults.register({ root_path, name, include_dirs, include_raw }))(),
);

server.tool(
  'list_vaults',
  '列出已注册的知识库 vault（含扫描时间与统计）。什么场景调用我：想知道用户有哪些库、上次扫描是否过期',
  {},
  async () => wrap(() => ({ vaults: core.vaults.list() }))(),
);

server.tool(
  'scan_vault',
  '扫描（或增量刷新）一个 vault 的只读索引：新增/变更入索引，磁盘消失的笔记标 missing 但保留历史。什么场景调用我：注册后首次索引；用户说改了卡片/重命名后刷新',
  { vault_id: z.number().int().positive() },
  async ({ vault_id }) => wrap(() => core.vaults.scan(vault_id))(),
);

server.tool(
  'list_vault_notes',
  '浏览/筛选已索引的知识卡片（按 kind: moc/card/draft/raw、level: dao/fa/shu/qi、状态、关键词搜索）。什么场景调用我：先看库里有什么再引用',
  {
    vault_id: z.number().int().positive().optional().describe('不传则查全部库'),
    kind: z.enum(['moc', 'card', 'draft', 'raw', 'all']).optional(),
    level: z.enum(['dao', 'fa', 'shu', 'qi', 'all']).optional(),
    status: z.string().optional().describe('frontmatter 的 status（active/draft 等）'),
    search: z.string().optional().describe('标题/路径/正文关键词'),
    limit: z.number().int().positive().max(1000).optional().describe('默认 200'),
  },
  async (p) => wrap(() => ({ notes: core.vaults.listNotes(p) }))(),
);

server.tool(
  'search_vault_notes',
  '全文搜索知识库卡片（list_vault_notes 的搜索捷径）。什么场景调用我：用户问「我记过关于 X 的卡片吗」',
  {
    query: z.string().min(1).describe('关键词'),
    vault_id: z.number().int().positive().optional(),
    limit: z.number().int().positive().max(1000).optional().describe('默认 50'),
  },
  async ({ query, vault_id, limit }) =>
    wrap(() => ({ results: core.vaults.listNotes({ search: query, vault_id, limit: limit ?? 50 }) }))(),
);

server.tool(
  'get_vault_note',
  '读取一张知识卡片的完整内容（正文实时从磁盘读取；含 frontmatter、wikilink 解析、反链、已关联概念）。什么场景调用我：引用卡片内容回答问题、核对边界与反例',
  {
    vault_id: z.number().int().positive(),
    rel_path: z.string().min(1).describe('相对 vault 根的路径（可从 list/search 结果获取）'),
  },
  async ({ vault_id, rel_path }) =>
    wrap(() => {
      const d = core.vaults.getNote(vault_id, rel_path);
      // MCP 侧不传渲染 HTML，只给正文与链接（App 才有 iframe 渲染）
      return {
        note: d.note,
        markdown: d.markdown.slice(0, 20000),
        truncated: d.markdown.length > 20000,
        stale: d.stale,
        links: d.links,
        backlinks: d.backlinks,
        concept_links: d.concept_links,
      };
    })(),
);

server.tool(
  'link_concept_note',
  '把 TodoDesk 学习概念（knowledge_key，与学习计划/课程同一命名空间）手动关联到一张知识卡片。只写 TodoDesk 库，不改 vault 文件。什么场景调用我：用户说「这个知识点对应我那张卡」',
  {
    vault_id: z.number().int().positive(),
    rel_path: z.string().min(1),
    knowledge_key: z.string().min(1).describe('概念稳定标识，如 ts/generics'),
  },
  async ({ vault_id, rel_path, knowledge_key }) =>
    wrap(() => core.vaults.linkConcept({ vault_id, rel_path, knowledge_key }))(),
);

server.tool(
  'unlink_concept_note',
  '解除一条概念 ↔ 卡片关联（只动 TodoDesk 库）',
  { link_id: z.number().int().positive() },
  async ({ link_id }) =>
    wrap(() => {
      core.vaults.unlinkConcept(link_id);
      return true;
    })(),
);

server.tool(
  'list_concept_links',
  '查询概念 ↔ 卡片关联：按 knowledge_key 查卡片，或按卡片查概念。什么场景调用我：复习/课程想找已关联的知识卡',
  {
    knowledge_key: z.string().optional(),
    vault_id: z.number().int().positive().optional(),
    rel_path: z.string().optional().describe('与 vault_id 一起使用：按卡片查概念'),
  },
  async ({ knowledge_key, vault_id, rel_path }) =>
    wrap(() => {
      if (vault_id !== undefined && rel_path !== undefined) {
        const notes = core.vaults.listNotes({ vault_id });
        const note = notes.find((n) => n.rel_path === rel_path);
        if (!note) throw new Error(`卡片不在索引中：${rel_path}`);
        return { links: core.vaults.listConceptLinks({ note_id: note.id }) };
      }
      return { links: core.vaults.listConceptLinks({ knowledge_key }) };
    })(),
);

// ---------- 自媒体工作流 ----------

server.tool(
  'get_media_overview',
  '自媒体工作流概览：各阶段计数、待人工审核版本、未来排期。什么场景调用我：用户问「我的自媒体现在什么状态」',
  {},
  async () => wrap(() => core.media.getOverview())(),
);

server.tool(
  'add_media_topic',
  '新增自媒体选题（点子池）。来源可关联新闻（source=news + source_news_id，自动快照标题与链接）或知识卡片（source=knowledge + source_note={vault_id, rel_path}，卡片须已入索引）。什么场景调用我：用户说「这个题目可以做期内容」',
  {
    title: z.string().min(1).describe('选题标题'),
    angle: z.string().optional().describe('角度/立意'),
    source: z.enum(['news', 'knowledge', 'manual']).optional().describe('默认 manual'),
    source_news_id: z.number().int().positive().optional().describe('来源新闻 id（source=news 时必填，可从 list_news 获取）'),
    source_note: z.string().optional().describe('来源知识卡片 JSON：{"vault_id":1,"rel_path":"knowledge/resources/..."}'),
    source_desc: z.string().optional().describe('来源快照说明（缺省自动生成）'),
    tags: z.array(z.string()).optional(),
  },
  async (p) =>
    wrap(() => {
      let note: { vault_id: number; rel_path: string } | undefined;
      if (p.source === 'knowledge' && p.source_note) note = JSON.parse(p.source_note);
      return core.media.addTopic({ ...p, source_note: note });
    })(),
);

server.tool(
  'list_media_topics',
  '查询自媒体选题（可按状态 idea/selected/dropped、关键词过滤，含每题内容数）',
  {
    status: z.enum(['idea', 'selected', 'dropped', 'all']).optional(),
    search: z.string().optional(),
  },
  async (p) => wrap(() => ({ topics: core.media.listTopics(p) }))(),
);

server.tool(
  'update_media_topic',
  '更新选题（标题/角度/状态流转：idea→selected→dropped，可恢复）',
  {
    id: z.number().int().positive(),
    title: z.string().min(1).optional(),
    angle: z.string().nullable().optional(),
    status: z.enum(['idea', 'selected', 'dropped']).optional(),
    tags: z.array(z.string()).optional(),
  },
  async ({ id, ...patch }) => wrap(() => core.media.updateTopic(id, patch))(),
);

server.tool(
  'delete_media_topic',
  '删除选题（其下已有内容时拒绝，防误删；先处理内容）',
  { id: z.number().int().positive() },
  async ({ id }) =>
    wrap(() => {
      core.media.deleteTopic(id);
      return true;
    })(),
);

server.tool(
  'add_media_content',
  '创建自媒体内容（母稿）。一母稿多平台版本：先写母稿，再为各平台 add_media_version 适配。什么场景调用我：用户确定要做某选题',
  {
    title: z.string().min(1),
    topic_id: z.number().int().positive().nullable().optional().describe('关联选题（可空）'),
    master_content: z.string().optional().describe('母稿正文（Markdown 自由文本）'),
  },
  async (p) => wrap(() => core.media.addContent(p))(),
);

server.tool(
  'list_media_contents',
  '查询自媒体内容列表（含平台版本数与待审数，可按选题/状态/关键词过滤）',
  {
    topic_id: z.number().int().positive().optional(),
    status: z.enum(['drafting', 'master_done', 'all']).optional(),
    search: z.string().optional(),
  },
  async (p) => wrap(() => ({ contents: core.media.listContents(p) }))(),
);

server.tool(
  'get_media_content',
  '查询单条内容全貌：母稿 + 全部平台版本（含审核状态）+ 挂载素材 + 排期。什么场景调用我：为内容补平台版本前先看现状',
  { id: z.number().int().positive() },
  async ({ id }) => wrap(() => core.media.getContent(id))(),
);

server.tool(
  'update_media_content',
  '更新内容母稿/标题/定稿状态/复盘笔记（retro_note 是发布后的经验回填）',
  {
    id: z.number().int().positive(),
    title: z.string().min(1).optional(),
    master_content: z.string().optional(),
    status: z.enum(['drafting', 'master_done']).optional().describe('master_done=母稿定稿'),
    retro_note: z.string().optional(),
  },
  async ({ id, ...patch }) => wrap(() => core.media.updateContent(id, patch))(),
);

server.tool(
  'delete_media_content',
  '删除内容（级联删除其平台版本/排期/指标；不可恢复，请先与用户确认）',
  { id: z.number().int().positive() },
  async ({ id }) =>
    wrap(() => {
      core.media.deleteContent(id);
      return true;
    })(),
);

server.tool(
  'add_media_version',
  '为内容添加某平台版本（platform 如 xiaohongshu/weixin/douyin/bilibili/zhihu/weibo/x；同一内容每平台一个版本）。注意：版本须用户在 App 内人工审核通过才能排期——agent 只能写稿与提交审核',
  {
    content_id: z.number().int().positive(),
    platform: z.string().min(1).describe('平台标识（小写字母/数字/中划线）'),
    body: z.string().optional().describe('版本正文'),
  },
  async ({ content_id, platform, body }) => wrap(() => core.media.addVersion(content_id, { platform, body }))(),
);

server.tool(
  'update_media_version',
  '修改平台版本正文（仅 draft/rejected/in_review 可改；已通过审核的版本须先由用户在 App 撤回）',
  { id: z.number().int().positive(), body: z.string() },
  async ({ id, body }) => wrap(() => core.media.updateVersion(id, { body }))(),
);

server.tool(
  'submit_media_version',
  '把平台版本提交人工审核（draft/rejected → in_review）。审核通过与拒绝是用户在 App 内的亲自动作，MCP 不提供——agent 不得代审',
  { id: z.number().int().positive() },
  async ({ id }) => wrap(() => core.media.reviewVersion(id, 'submit'))(),
);

server.tool(
  'add_media_material',
  '新增素材（金句/数据/图片说明/参考链接）。来源可关联新闻或知识卡片（同选题规则），导出素材包时一并带上出处',
  {
    title: z.string().min(1),
    kind: z.enum(['text', 'image', 'link', 'note']).optional().describe('默认 text'),
    content: z.string().optional().describe('素材内容/链接/说明'),
    source: z.enum(['news', 'knowledge', 'manual']).optional(),
    source_news_id: z.number().int().positive().optional(),
    source_note: z.string().optional().describe('{"vault_id":1,"rel_path":"..."}'),
    tags: z.array(z.string()).optional(),
  },
  async (p) =>
    wrap(() => {
      let note: { vault_id: number; rel_path: string } | undefined;
      if (p.source === 'knowledge' && p.source_note) note = JSON.parse(p.source_note);
      return core.media.addMaterial({ ...p, source_note: note });
    })(),
);

server.tool(
  'list_media_materials',
  '查询素材库（按类型/关键词过滤）',
  { search: z.string().optional(), kind: z.enum(['text', 'image', 'link', 'note', 'all']).optional() },
  async (p) => wrap(() => ({ materials: core.media.listMaterials(p) }))(),
);

server.tool(
  'update_media_material',
  '更新素材（标题/类型/内容/标签）',
  {
    id: z.number().int().positive(),
    title: z.string().min(1).optional(),
    kind: z.enum(['text', 'image', 'link', 'note']).optional(),
    content: z.string().optional(),
    tags: z.array(z.string()).optional(),
  },
  async ({ id, ...patch }) => wrap(() => core.media.updateMaterial(id, patch))(),
);

server.tool(
  'delete_media_material',
  '删除素材（不影响已挂载它的内容历史导出）',
  { id: z.number().int().positive() },
  async ({ id }) =>
    wrap(() => {
      core.media.deleteMaterial(id);
      return true;
    })(),
);

server.tool(
  'attach_media_material',
  '把素材挂载到内容（素材包导出范围）。重复挂载幂等',
  {
    content_id: z.number().int().positive(),
    material_id: z.number().int().positive(),
  },
  async ({ content_id, material_id }) =>
    wrap(() => {
      core.media.attachMaterial(content_id, material_id);
      return true;
    })(),
);

server.tool(
  'detach_media_material',
  '从内容卸下素材',
  {
    content_id: z.number().int().positive(),
    material_id: z.number().int().positive(),
  },
  async ({ content_id, material_id }) =>
    wrap(() => {
      core.media.detachMaterial(content_id, material_id);
      return true;
    })(),
);

server.tool(
  'schedule_media_post',
  '为「已通过人工审核」的平台版本排期（仅本地计划，绝不自动发布）。同一版本重复排期=改期；已发布的不可改期',
  {
    content_version_id: z.number().int().positive(),
    planned_date: dateSchema.describe('计划日期 YYYY-MM-DD（支持 today/明天 等别名）'),
    note: z.string().optional(),
  },
  async ({ content_version_id, planned_date, note }) =>
    wrap(() => core.media.schedule({ content_version_id, planned_date, note }))(),
);

server.tool(
  'list_media_calendar',
  '查询发布日历（按日期区间/状态/内容过滤，含发布回填链接）',
  {
    from: dateSchema.optional().describe('YYYY-MM-DD 起始'),
    to: dateSchema.optional().describe('YYYY-MM-DD 结束'),
    status: z.enum(['planned', 'published', 'cancelled', 'all']).optional(),
    content_id: z.number().int().positive().optional(),
  },
  async (p) => wrap(() => ({ entries: core.media.listCalendar(p) }))(),
);

server.tool(
  'mark_media_published',
  '用户已在平台手动发布后回填状态与作品链接（仅记录，不执行任何发布动作）。什么场景调用我：用户明确告诉你「这条发了，链接是 …」',
  {
    id: z.number().int().positive().describe('日历条目 id'),
    publish_url: z.string().optional().describe('作品链接（http/https）'),
    note: z.string().optional(),
  },
  async ({ id, publish_url, note }) => wrap(() => core.media.markPublished(id, { publish_url, note }))(),
);

server.tool(
  'cancel_media_schedule',
  '取消一条 planned 排期（已发布条目不可取消）',
  { id: z.number().int().positive() },
  async ({ id }) => wrap(() => core.media.cancelSchedule(id))(),
);

server.tool(
  'add_media_metric',
  '手动录入发布指标（同排期同日重复录入=覆盖；custom 放完播率/涨粉等自定义数值）。什么场景调用我：用户报数据「阅读 1200 赞 88」',
  {
    calendar_id: z.number().int().positive().describe('日历条目 id'),
    date: dateSchema.optional().describe('数据日期，默认 today'),
    views: z.number().int().nonnegative().nullable().optional().describe('阅读/播放'),
    likes: z.number().int().nonnegative().nullable().optional(),
    comments: z.number().int().nonnegative().nullable().optional(),
    shares: z.number().int().nonnegative().nullable().optional(),
    favorites: z.number().int().nonnegative().nullable().optional(),
    custom: z.record(z.string(), z.number()).optional().describe('自定义指标键值'),
    note: z.string().optional(),
  },
  async (p) => wrap(() => core.media.addMetric(p))(),
);

server.tool(
  'list_media_metrics',
  '查询已录入的指标明细（按日历条目/日期区间过滤）',
  {
    calendar_id: z.number().int().positive().optional(),
    from: dateSchema.optional(),
    to: dateSchema.optional(),
  },
  async (p) => wrap(() => ({ metrics: core.media.listMetrics(p) }))(),
);

server.tool(
  'get_media_stats',
  '复盘汇总：按平台聚合发布数与指标（可限定日期区间）',
  {
    from: dateSchema.optional().describe('YYYY-MM-DD 起始'),
    to: dateSchema.optional().describe('YYYY-MM-DD 结束'),
  },
  async (p) => wrap(() => ({ stats: core.media.getStats(p) }))(),
);

server.tool(
  'export_media_package',
  '把内容导出为素材包（母稿/各平台版本/素材及出处/排期记录，写入用户指定的导出目录下的子目录）。红线（core 层硬拒绝，非提示）：目录不得位于任何知识库 vault 内——含已注册 vault、内置默认保护根（~/Desktop/knowledge-base，即使未注册）与 TODODESK_PROTECTED_DIRS 指定目录；符号链接别名同样拦截；目标子目录已存在时拒绝（防覆盖）。什么场景调用我：用户要带着素材去平台后台手动发布',
  {
    content_id: z.number().int().positive(),
    export_dir: z.string().min(1).describe('导出根目录（vault 外，用户明确指定）'),
  },
  async ({ content_id, export_dir }) => wrap(() => core.media.exportPackage(content_id, export_dir))(),
);

// ---------- 启动 ----------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[tododesk-mcp] 已启动，数据库：${defaultDbPath()}`);
}

main().catch((e) => {
  console.error('[tododesk-mcp] 启动失败：', e);
  process.exit(1);
});
