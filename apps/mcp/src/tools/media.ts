import type { ToolRegistrar, McpContext } from '../shared/context';
import { z } from 'zod';
import { dateSchema } from '../shared/schemas';
import { wrap } from '../shared/response';

export function registerTools(server: ToolRegistrar, { core }: McpContext): void {
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
}
