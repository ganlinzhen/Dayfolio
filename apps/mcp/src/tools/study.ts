import type { ToolRegistrar, McpContext } from '../shared/context';
import { z } from 'zod';
import { dateSchemas } from '../shared/schemas';
import { wrap } from '../shared/response';
import studyWorkflowSpec from '../../../../apps/help/docs/09-study-loop.md';

export function registerTools(server: ToolRegistrar, { core }: McpContext): void {
  const { dateSchema } = dateSchemas(core);
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
    '获取 Dayfolio 学习闭环的完整执行规范（目标澄清→先修诊断→草案（可先无日期保存）→排期预览与提交→每日学习会话→测评留证→复盘调整→知识卡片沉淀的 agent 操作规范与全部透明规则）。用户说「学习 X」「帮我安排学习」「这些专题先存着以后再学」时先读它，再按规范执行；内容与 App 帮助面板同源',
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
    '生成学习计划**草案**（预览载体）：输入目标、材料来源、每日时间预算与知识点分解，Dayfolio 按透明规则（依赖拓扑排序 + 每日预算装箱）排出逐日安排。此时不创建计划/待办/打卡——先把逐日安排与 assumptions（缺失信息假设）念给用户，用户同意后调 confirm_study_plan_draft 才生效。用户说「学习线性代数」等诉求在此工具完成计划编制',
    {
      title: z.string().min(1).describe('计划标题，如「线性代数入门」'),
      goal: z.string().optional().describe('学习目标（学完能做什么）'),
      material_source: z.string().optional().describe('材料来源（书名/课程/链接），会随会话与卡片记录'),
      daily_minutes: z.number().int().min(10).max(600).describe('每日时间预算（分钟）——先向用户澄清，不要拍脑袋'),
      start_date: dateSchema.describe('开始日期，支持 today/明天 等别名'),
      knowledge_points: z.array(knowledgePointSchema).min(1).describe('知识点分解清单（由你按目标与先修诊断给出，Dayfolio 不代拟）'),
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
    '记录一次**测评证据**：题目、评价标准、原答案、评分/反馈与依据。source 必须显式：self=用户自评（可被后续纠正，历史保留）；objective=客观测试（必须附真实判题依据 evidence 与判题结果，Dayfolio 不代判不伪造）；ai_suggestion=AI 建议性反馈（仅记录，不计入掌握证据）。同一 id 或同一会话同一题重复提交=更新（内容有实质变化才追加 corrections，保留旧答案/反馈/依据）。掌握度按计划隔离：传 plan_id 或 session_id（自动归属其计划）才会计入该计划的 get_mastery',
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
}
