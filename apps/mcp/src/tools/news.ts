import type { ToolRegistrar, McpContext } from '../shared/context';
import { z } from 'zod';
import { wrap } from '../shared/response';

export const newsItemsSchema = z.array(z.object({
        title: z.string().min(1).max(300).describe('新闻标题'),
        summary: z.string().min(1).max(2000).describe('你核实后写的内容摘要（不接受空摘要）'),
        source_url: z.string().min(1).max(2048).describe('原始来源网页链接（http(s)，你亲自核实过的公开页面）'),
        source_name: z.string().max(120).optional().describe('来源站点名，如「TechCrunch」'),
        published_at: z.string().min(1).describe('来源页面的真实发布时间（ISO 格式）'),
        brief: z.object({
          overview: z.string().min(1).max(2000).describe('专题总体看点'),
          items: z.array(z.object({
            title: z.string().min(1).max(300), summary: z.string().min(1).max(2000),
            source_url: z.string().min(1).max(2048), source_name: z.string().max(120).optional(),
            published_at: z.string().min(1),
          })).min(1).max(20),
        }).optional().describe('专题简报：整份只算一条新闻，子条目均须核实来源与时间。外层 source_url 和 published_at 使用第一则新闻的值，不能同时传 html'),
        html: z.string().max(1000000).optional().describe('本地 HTML 快照（可选）：X/Twitter 等无法内嵌展示的来源用。写成自包含 HTML（作者/发布时间/正文/图片 https 外链/原帖链接），脚本与事件属性会被剥离，保存后用 read_news_html 核对'),
      })).min(1).max(10).describe('本批条目（1~10 条）');

export function registerTools(server: ToolRegistrar, { core }: McpContext): void {
  server.tool('get_news_collection_settings',
    '读取 App 当前保存的新闻采集提示词、收录上限和时间窗。什么场景调用我：每日采集开始前读取最新规则；不要把旧自动任务里的固定要求当作当前规则。读取不会创建任务或联网。', {},
    async () => wrap(() => core.news.getCollectionSettings())());
  server.tool('update_news_collection_settings',
    '保存新闻采集提示词，App 与 MCP 共用。什么场景调用我：用户明确要求调整以后的新闻内容、结构或采集范围时；先读取当前 revision，保存仅影响后续按提示词创建的请求，已有请求保留快照。', {
      prompt: z.string().min(1).max(12000), max_items: z.number().int().min(1).max(11),
      window_hours: z.number().int().min(1).max(720), expected_revision: z.number().int().min(0),
    }, async (input) => wrap(() => core.news.updateCollectionSettings(input))());

  server.tool('list_news_agent_runs', '查看新闻后台运行记录。什么场景调用我：用户询问采集进度、失败原因或停止状态；只读，不启动 Agent。', {
    task_id: z.number().int().positive().optional(),
  }, async ({ task_id }) => wrap(() => core.newsRuns.list(task_id))());
  server.tool('cancel_news_agent_run', '停止一条后台新闻运行。什么场景调用我：用户要求停止采集；已提交新闻保留，业务请求保留供重试。执行中需等待 App 停止子进程后释放认领。', {
    run_id: z.string().min(1),
  }, async ({ run_id }) => wrap(() => core.newsRuns.cancel(run_id))());

  // ---------- 每日新闻（agent-only：任务 → 认领 → 提交；本地不抓取任何 RSS/X） ----------

  server.tool(
    'list_news',
    '查看库内新闻（**只读，不联网**）：默认近 3 天，可按任务/来源/关键词过滤，或只看未读/收藏。每条含原始来源链接、摘要、发布时间；专题简报还含 brief.overview 与 brief.items 逐条摘要和链接、已读与收藏状态。App 面板同源展示。什么场景调用我：用户想看最近的新闻、查某条新闻的来源链接、找收藏的内容',
    {
      days: z.number().int().positive().max(90).optional().describe('最近 N 天（按北京日期），默认 3'),
      source: z.union([z.enum(['agent', 'x', 'zhihu_daily', 'hacker_news']), z.string().regex(/^rss\//)]).optional().describe("缺省看全部；'agent'=任务提交的新闻，其余为旧版抓取的历史"),
      task_id: z.number().int().positive().optional().describe('只看某个新闻任务提交的结果（create_news_task 返回的 id）'),
      search: z.string().optional().describe('在标题和摘要中搜索（库内，不联网）'),
      filter: z.enum(['all', 'unread', 'starred']).optional().describe('默认 all；unread=只看未读，starred=只看收藏'),
      since: z.string().optional().describe('ISO 时间戳：只看此时刻之后发布的（如近 24 小时窗口）'),
      limit: z.number().int().positive().max(500).optional().describe('默认 100；历史展示不受任务预算限制'),
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
    '创建一个待执行的新闻任务（新闻生产的唯一入口；App 不抓取，任务由 agent 执行）。什么场景调用我：用户说「帮我收集/看看某方面的最新新闻」。任务创建后处于待执行，由你或下一次会话用 claim_news_task 认领执行。规则：每任务累计最多 11 条新入库（跨批次不重置）；只接受任务时间窗内发布、带原始来源链接与摘要、你亲自核实过的新闻',
    {
      title: z.string().min(1).max(200).describe('任务主题，如「AI 领域最近 24 小时重要新闻」'),
      use_collection_prompt: z.boolean().optional().describe('true=读取 App 当前提示词，并将要求与配置存成任务快照；每日采集必须设 true，默认 false 用于临时任务'),
      instructions: z.string().max(2000).optional().describe('给执行 agent 的规则/补充要求（关注方向、语言、侧重等），会在认领时看到'),
      max_items: z.number().int().min(1).max(11).optional().describe('累计上限 1~11；使用采集提示词时默认读取保存配置，否则默认 10'),
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
    '向已认领的任务提交一批新闻（**唯一入库入口**，整批原子：任何一条不合法即全部拒绝）。硬校验：任务须由本 claim_token 持有且租约未过期；每条必须有 title/summary/source_url/published_at——source_url 必须是你**亲自打开核实过**的原始来源页面（http(s)，不接受本地/内网/javascript: 链接），published_at 用页面上真实发布时间（不接受未来时间或超出任务时间窗）；同链接或同事件（归一化标题一致）的重复提交直接拒绝；任务累计入库不得超过 max_items（重复提交无法绕过）。X/Twitter 等无法在 App 内嵌展示的来源，给该条加 html 字段：把核实到的原文（作者、发布时间、正文、图片、原帖链接）整理成自包含 HTML 快照提交，App 详情页会改用这份本地快照展示。请先用你自己的搜索/浏览工具找到并核实新闻，再提交',
    {
      task_id: z.number().int().positive(),
      claim_token: z.string().min(1).describe('claim_news_task 返回的认领令牌'),
      items: newsItemsSchema,
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
    'read_news_html',
    '读取一条新闻的本地 HTML 快照（与 submit_news_items 的 html 字段对应）。什么场景调用我：提交带快照的新闻后回读核对内容与格式；用户问「这条 X 快照里写了什么」。content_kind=url 的新闻没有快照（html 为 null，属正常）；快照文件缺失时 missing=true',
    {
      id: z.number().int().positive().describe('新闻 id（可从 list_news 获取，content_kind=html 的条目）'),
    },
    async ({ id }) => wrap(() => core.news.readHtml(id))(),
  );

  server.tool(
    'delete_news_item',
    '删除一条新闻（不可恢复）。什么场景调用我：用户明确要求删除某条新闻，且你已向用户确认「删除后不可恢复」。务必先向用户复述标题并得到确认再调用。行为：单事务删除正文与收藏/已读状态；随行清理仅新闻独占的话题链接；引用它的自媒体选题/素材保留成果与来源快照、仅解除失效引用；保留最小哈希去重指纹，之后同链接/同事件的提交会被拒绝；AI 采集任务的累计收录名额不因删除返还。幂等：重复删除同一 id 返回 deleted:false。绝不批量删除、绝不未经用户确认调用',
    { id: z.number().int().positive().describe('新闻 id（可从 list_news 获取）') },
    async ({ id }) => wrap(() => core.news.deleteItem(id))(),
  );
}
