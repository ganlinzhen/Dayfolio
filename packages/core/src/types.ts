// Dayfolio 核心数据类型定义（App 与 MCP 共用）

/** 待办优先级：high 最高 */
export type Priority = 'high' | 'medium' | 'low';

export type TodoStatus = 'open' | 'done';

/** 学习计划条目类型 */
export type PlanItemType = 'learn' | 'review' | 'practice' | 'rest';

export type PlanItemStatus = 'pending' | 'done' | 'skipped';
export type PlanStatus = 'active' | 'done' | 'archived';

/** 打卡引用类型：todo=完成待办 plan_item=完成计划条目 day=每日打卡 */
export type CheckinRefType = 'todo' | 'plan_item' | 'day';

export interface Todo {
  id: number;
  title: string;
  notes: string;
  priority: Priority;
  status: TodoStatus;
  /** 截止日期，格式 YYYY-MM-DD，可为空 */
  due_date: string | null;
  /** 浮动时间或固定时刻镜像 HH:MM；允许仅开始；均为空表示仅日期 */
  start_time: string | null;
  end_time: string | null;
  end_date: string | null;
  time_mode: 'floating' | 'instant';
  scheduled_start_at: string | null;
  scheduled_end_at: string | null;
  collection_id: string | null;
  source_status: 'scheduled'|'postponed'|'cancelled'|'finished'|null;
  source_time_kind: 'timed'|'all_day'|'tbd'|null;
  revision: number;
  tags: string[];
  /** 来源：app（界面创建）| mcp（AI 创建）| plan（由学习计划生成） */
  source: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  /** 计算字段：是否已过期（仅未完成且有截止日期时为 true） */
  is_overdue: boolean;
}

export interface StudyPlan {
  id: number;
  title: string;
  goal: string;
  start_date: string;
  end_date: string;
  status: PlanStatus;
  notes: string;
  /** 每日时间预算（分钟）：学习闭环草案确认时写入；旧计划/手工创建为 null */
  daily_minutes: number | null;
  created_at: string;
  updated_at: string;
}

export interface PlanItem {
  id: number;
  plan_id: number;
  /** 安排日期 YYYY-MM-DD */
  date: string;
  content: string;
  item_type: PlanItemType;
  /** 预计时长（分钟），可空 */
  duration_min: number | null;
  status: PlanItemStatus;
  /** 由该条目生成的待办 id */
  todo_id: number | null;
  /** 关联知识点稳定标识（学习闭环草案确认时写入；普通计划条目为 null） */
  knowledge_key: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Checkin {
  id: number;
  ref_type: CheckinRefType;
  /** 每日打卡（ref_type=day）时固定为 0 */
  ref_id: number;
  date: string;
  note: string;
  created_at: string;
}

export interface NewTodoInput {
  title: string;
  notes?: string;
  priority?: Priority;
  due_date?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  end_date?: string | null;
  time_mode?: 'floating' | 'instant';
  scheduled_start_at?: string | null;
  scheduled_end_at?: string | null;
  collection_id?: string | null;
  tags?: string[];
  source?: string;
}

export interface UpdateTodoInput {
  title?: string;
  notes?: string | null;
  priority?: Priority;
  due_date?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  end_date?: string | null;
  time_mode?: 'floating' | 'instant';
  scheduled_start_at?: string | null;
  scheduled_end_at?: string | null;
  collection_id?: string | null;
  expected_revision?: number;
  tags?: string[];
  status?: TodoStatus;
}

export interface TodoFilters {
  /** 按业务归属分类筛选，与日历一致；基础待办包含无其他归属的旧记录。 */
  collection_id?: string;
  status?: TodoStatus | 'all';
  priority?: Priority;
  overdue?: boolean;
  search?: string;
  tag?: string;
  limit?: number;
}

export interface NewPlanItemInput {
  date: string;
  content: string;
  item_type?: PlanItemType;
  duration_min?: number | null;
  /** 关联知识点稳定标识（学习闭环用） */
  knowledge_key?: string | null;
}

export interface NewPlanInput {
  title: string;
  goal?: string;
  start_date: string;
  /** 缺省时取所有条目的最大日期 */
  end_date?: string;
  notes?: string;
  items: NewPlanItemInput[];
  /** 是否为每个条目生成待办，默认 true */
  create_todos?: boolean;
  /** 每日时间预算（分钟，学习闭环用） */
  daily_minutes?: number | null;
}

export interface PlanProgress {
  total_items: number;
  done_items: number;
  /** 0 ~ 1 */
  progress: number;
}

export interface StudyPlanWithProgress extends StudyPlan, PlanProgress {}

export interface PlanDetail extends StudyPlanWithProgress {
  items: PlanItem[];
}

/** 今日概览（App 首页与 MCP get_today 共用） */
export interface TodayOverview {
  date: string;
  overdue_todos: Todo[];
  due_today_todos: Todo[];
  completed_today_todos: Todo[];
  today_plan_items: Array<PlanItem & { plan_title: string }>;
  checkins: Checkin[];
  streak: number;
  summary: {
    todo_done_count: number;
    plan_item_done_count: number;
    manual_checkin_count: number;
  };
  /** 一句话人读摘要（AI 汇报 / App 首页副标题） */
  summary_text: string;
  /** 与今天相交的日程（含跨天与全天），按开始时间排序 */
  calendar_events: CalendarEvent[];
}

// ---------- 日历 ----------

/** 日程色板（渲染层与校验共用；默认 blue） */
export const CALENDAR_COLORS = ['blue', 'green', 'violet', 'amber', 'rose', 'slate'] as const;
export type CalendarColor = (typeof CALENDAR_COLORS)[number];

/** 日程（个人本地日历；start_time 为空即全天） */
export interface CalendarEvent {
  id: number;
  title: string;
  /** 开始日 YYYY-MM-DD */
  date: string;
  /** 结束日（含当天），null = 单日 */
  end_date: string | null;
  /** HH:MM，null = 全天（此时 end_time 亦须为 null） */
  start_time: string | null;
  end_time: string | null;
  note: string;
  color: CalendarColor;
  source: 'app' | 'mcp';
  created_at: string;
  updated_at: string;
}

export interface NewCalendarEventInput {
  title: string;
  date: string;
  end_date?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  note?: string;
  color?: CalendarColor;
  source?: 'app' | 'mcp';
}

export type CalendarEventPatch = Partial<NewCalendarEventInput>;

/** 月视图/区间聚合：日程 + 每日到期待办与学习条目（App 一次拉全） */
export interface CalendarAgendaDay {
  todos: Array<Pick<Todo, 'id' | 'title' | 'priority' | 'status' | 'start_time' | 'end_time'>>;
  plan_items: Array<{ id: number; content: string; item_type: PlanItemType; status: PlanItemStatus; plan_title: string }>;
  /** 当日是否有「每日打卡」（ref_type='day'） */
  checked_in: boolean;
}

export interface CalendarRangeAgenda {
  from: string;
  to: string;
  events: CalendarEvent[];
  days: Record<string, CalendarAgendaDay>;
}

// ---------- 工具箱 ----------

/** 工具箱分类 */
export interface ToolCategory {
  id: number;
  name: string;
  sort_order: number;
  created_at: string;
}

/** 工具箱里的单个工具（HTML 小工具） */
export interface ToolItem {
  id: number;
  title: string;
  /** 内置图标 key 或本地图片 data URL */
  icon: string;
  /** 图标背景，auto 沿用内置配色 */
  icon_background: string;
  /** 所属分类 id，null = 未分类 */
  category_id: number | null;
  /** 入口 html 文件名（相对 userData/tools/<id>/ 目录） */
  entry_file: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface NewToolCategoryInput {
  name: string;
}

export interface NewToolInput {
  files?: Array<{name:string;contentBase64:string}>;
  title: string;
  icon?: string;
  icon_background?: string;
  category_id?: number | null;
  entry_file: string;
}

export interface UpdateToolInput {
  files?: Array<{name:string;contentBase64:string}>;
  title?: string;
  icon?: string;
  icon_background?: string;
  category_id?: number | null;
  entry_file?: string;
}

// ---------- 每日新闻（agent-only：新闻任务 → 认领 → 提交；本地不抓取） ----------

export type NewsSource = 'x' | 'zhihu_daily' | 'hacker_news' | 'agent' | `rss/${string}`;

/** 专题简报中的一则新闻，逐条核实来源和发布时间。 */
export interface NewsBriefEntry {
  title: string;
  summary: string;
  source_url: string;
  source_name?: string;
  published_at: string;
}
export interface NewsBrief {
  overview: string;
  items: NewsBriefEntry[];
}
export interface NewsCollectionSettings {
  prompt: string;
  max_items: number;
  window_hours: number;
  revision: number;
  updated_at: string | null;
}

export interface NewsArticleMetadata {
  module_id?: string | null;
  event_id?: string | null;
  topic_keys?: string[];
  image_url?: string | null;
  image_source_url?: string | null;
  image_caption?: string | null;
  background?: string | null;
  impact?: string | null;
  uncertainty?: string | null;
}
/** AI 根据真实反馈或明确模块配置提出的具体细分主题，随已核实试读原子提交。 */
export interface NewsCandidateTopic {
  key: string; name: string; scope: string; reason: string;
  basis_news_ids: number[]; basis_module_id?: string;
}

export interface NewsItem extends NewsArticleMetadata {
  id: number;
  source: NewsSource;
  title: string;
  url: string;
  summary: string;
  /** 新闻所属日期 YYYY-MM-DD（北京时间，供「今天」判定与展示） */
  published_date: string;
  /** 精确发布时间（ISO；旧数据为 null） */
  published_at: string | null;
  fetched_at: string;
  /** 去重键（X 推文 ID / HN item ID / 规范 URL），入库时确定 */
  dedup_key: string;
  /** 已读状态（用户操作持久化） */
  is_read: boolean;
  /** 收藏状态（用户操作持久化） */
  is_starred: boolean;
  /** agent-only：产生本条的新闻任务（历史数据为 null） */
  task_id: number | null;
  /** agent 提交的来源站点名（如「TechCrunch」；历史数据为 null） */
  source_name: string | null;
  /** 内容形态：'url'=详情页直接内嵌来源网页（默认）；'html'=用本地 HTML 快照展示 */
  content_kind: 'url' | 'html' | 'brief';
  /** 专题简报整体作为一条新闻，子新闻不单独入库。 */
  brief: NewsBrief | null;
  /** 本地快照相对路径（相对 dirname(db)/news；仅 content_kind='html' 时非空） */
  html_rel: string | null;
}

// ---------- 新闻任务（agent 经 MCP 认领执行；App 只读展示） ----------

/** pending=待执行（无人认领/认领过期） claimed=执行中（持有有效租约） completed=已完成 cancelled=已取消 */
export type NewsTaskStatus = 'pending' | 'claimed' | 'completed' | 'cancelled';

export interface NewsTask {
  id: number;
  title: string;
  /** 规则/补充要求（agent 执行时阅读；App 展示） */
  instructions: string;
  /** 新入库条数硬上限（跨批次与重试累计，1~11） */
  max_items: number;
  /** 任务时间窗（小时）：只接受最近 N 小时内发布的新闻 */
  window_hours: number;
  status: NewsTaskStatus;
  created_by: string;
  claimed_by: string | null;
  /** 认领租约到期（本地时间格式；过期即可被重新认领） */
  claim_expires_at: string | null;
  /** 被认领次数（跨批次重试可见） */
  attempts: number;
  /** 该任务当前仍在新闻库的条数（删除后减少） */
  inserted_count: number;
  /** 历史累计收录条数（删除不返还预算） */
  accepted_count: number;
  /** 剩余可入库条数，按历史累计收录数计算 */
  remaining: number;
  completed_at: string | null;
  completed_note: string | null;
  /** 最近一次释放/失败原因（pending 时展示） */
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** agent 提交的一条新闻（提交前校验：标题/摘要/来源 URL/发布时间） */
export interface NewsSubmissionItem extends NewsArticleMetadata {
  candidate_topic?: NewsCandidateTopic;
  /** 多条已核实新闻组成的一份专题简报，列表只占一条。不能与 html 同传。 */
  brief?: NewsBrief;
  title: string;
  summary: string;
  /** 原始来源网页链接（http(s)，须为 agent 亲自核实过的公开页面） */
  source_url: string;
  source_name?: string;
  /** 来源页面上的真实发布时间（ISO，必填；不接受未来时间/超出任务时间窗） */
  published_at: string;
  /** 本地 HTML 快照（可选）：X/Twitter 等无法内嵌展示的来源，把核实到的原文整理成
   *  自包含 HTML；core 消毒后写入 dirname(db)/news，详情页改用快照展示 */
  html?: string;
}

/** 用户手动删除一条新闻的结果（不可恢复；重复请求幂等返回 deleted:false） */
export interface NewsDeleteResult {
  deleted: boolean;
  id: number;
  /** 随行删除的旧版话题链接数（news_topic_links，新闻独占） */
  topic_links_removed: number;
  /** 解除失效引用的自媒体选题/素材数（成果与来源快照保留，仅 source_news_id 置空） */
  media_refs_cleared: number;
  /** 保留的去重指纹条数（链接/事件各至多 1，均为哈希，不含明文） */
  fingerprints_kept: number;
  /** 随行删除的本地 HTML 快照文件数（仅 content_kind='html' 的条目会有） */
  html_removed: number;
}

/** claim_news_task 的返回（claim_token 是提交/完成/释放的凭证） */
export interface NewsClaimResult {
  task: NewsTask;
  claim_token: string;
  claim_expires_at: string;
  lease_minutes: number;
}

export interface NewsSubmitResult {
  task: NewsTask;
  inserted: number;
  items: NewsItem[];
}

// ---------- 学习闭环（v1） ----------

/** 学习计划草案里的知识点（由 agent 分解提供，Dayfolio 只做透明排程，不生成内容） */
export interface StudyKnowledgePoint {
  /** 稳定标识（小写 slug，如 matrix-multiply），卡片与会话用它关联 */
  key: string;
  name: string;
  /** 依赖的其他知识点 key（拓扑排序用） */
  depends_on: string[];
  /** 预计学习时长（分钟），缺省 60 */
  est_minutes: number;
  /** 可验证成果（学完如何证明掌握） */
  outcome: string;
}

export interface StudyDraftInput {
  title: string;
  goal?: string;
  /** 材料来源（书名/课程/链接），会随卡片导出 */
  material_source?: string;
  /** 每日时间预算（分钟），10~600 */
  daily_minutes: number;
  start_date: string;
  knowledge_points: Array<{
    key: string;
    name: string;
    depends_on?: string[];
    est_minutes?: number;
    outcome?: string;
  }>;
  notes?: string;
}

/** 无日期学习专题草案输入：日期/预算均不提供（排期延后到用户给出时） */
export interface StudyTopicDraftInput {
  title: string;
  goal?: string;
  material_source?: string;
  knowledge_points: Array<{
    key: string;
    name: string;
    depends_on?: string[];
    est_minutes?: number;
    outcome?: string;
  }>;
  /** 关联课程（可为样课尚未确认的课程；排期确认生成计划后绑定仍以课程包导入为准） */
  course_id?: number | null;
  notes?: string;
}

/** 无日期草案的内容更新（仅未排期且未确认时可改；字符串传 null = 清空） */
export interface StudyTopicDraftPatch {
  title?: string;
  goal?: string | null;
  material_source?: string | null;
  knowledge_points?: Array<{
    key: string;
    name: string;
    depends_on?: string[];
    est_minutes?: number;
    outcome?: string;
  }>;
  course_id?: number | null;
  notes?: string | null;
}

/** 草案逐日安排（由透明规则排程生成） */
export interface StudyDraftItem {
  date: string;
  content: string;
  item_type: 'learn' | 'review';
  duration_min: number;
  knowledge_key: string;
}

export type StudyDraftStatus = 'draft' | 'confirmed' | 'cancelled';

export interface StudyDraft {
  id: number;
  title: string;
  goal: string;
  material_source: string;
  /** 每日预算（分钟）；NULL = 未排期的无日期专题草案 */
  daily_minutes: number | null;
  /** NULL = 未排期（无日期草案：不排日程、不产待办、不占预算） */
  start_date: string | null;
  end_date: string | null;
  knowledge_points: StudyKnowledgePoint[];
  items: StudyDraftItem[];
  /** 透明规则记录的假设清单（缺省参数、未提供的信息），供用户核对 */
  assumptions: string[];
  status: StudyDraftStatus;
  /** 确认后生成的计划 id */
  plan_id: number | null;
  /** 关联课程（未确认样课的课程亦可关联；仅信息性记录，不改课程绑定） */
  course_id: number | null;
  /** 排期提交时的预算冲突硬校验时刻；NULL = 旧路径（draft() 创建即排期），确认不设冲突门 */
  conflict_checked_at: string | null;
  notes: string;
  created_at: string;
  updated_at: string;
  confirmed_at: string | null;
  cancelled_at: string | null;
}

/** 排期预览：单日与其他进行中计划的预算冲突 */
export interface DraftScheduleConflict {
  date: string;
  /** 其他进行中计划当日已排估算分钟数 */
  existing_minutes: number;
  /** 本草案当日将排的分钟数 */
  new_minutes: number;
  /** 本草案声明的每日预算 */
  daily_minutes: number;
  /** 既有占用 + 新安排超出每日预算 */
  over_budget: boolean;
}

/** 排期预览：知识点与其他进行中计划重复（重复学习预警） */
export interface DraftKnowledgeDuplicate {
  knowledge_key: string;
  plan_id: number;
  plan_title: string;
}

/** 排期预览（只读）：透明排程 + 冲突 + 依赖，供用户确认后再 scheduleDraft */
export interface DraftSchedulePreview {
  draft_id: number;
  start_date: string;
  end_date: string;
  daily_minutes: number;
  items: StudyDraftItem[];
  /** 知识点拓扑顺序（先修在前） */
  ordered_keys: string[];
  /** 依赖关系链（每项 key 及其直接前置） */
  dependency_chains: Array<{ key: string; name: string; depends_on: string[] }>;
  assumptions: string[];
  conflicts: DraftScheduleConflict[];
  /** 超预算日期集合（conflicts 中 over_budget 的日期，排期提交须把它原样带回 confirmed_over_dates） */
  over_budget_dates: string[];
  duplicate_knowledge_keys: DraftKnowledgeDuplicate[];
  warnings: string[];
}

/** 排期/确认边界的冲突确认快照（服务层硬校验：与当下重算结果必须精确一致） */
export interface DraftConflictConfirm {
  /** 预览时看到的超预算日期（ISO YYYY-MM-DD 数组，排序无关，集合精确匹配） */
  confirmed_over_dates?: string[];
}

/** 学习会话记录：一次真实学习（可多次尝试，稳定 ID，重复提交幂等） */
export interface StudySession {
  id: string;
  plan_id: number | null;
  plan_item_id: number | null;
  /** 幂等目标键：条目会话 pi:<条目id>，独立主题会话 kp:<知识点>@<日期> */
  scope_key: string;
  knowledge_key: string;
  topic: string;
  /** 第几次尝试（同一目标从 1 递增） */
  attempt: number;
  /** 会话归属日 YYYY-MM-DD */
  date: string;
  /** 0 表示未记录用时，正整数表示用户实际提供的分钟数。 */
  actual_minutes: number;
  /** 自己的解释 / 答案（费曼式输出） */
  explanation: string;
  /** 疑问（未解决的问题） */
  questions: string;
  material_source: string;
  created_at: string;
  updated_at: string;
}

export interface StudySessionInput {
  /** 稳定 ID：agent 重试请传同一个 id；缺省按 (目标, attempt) 复用或生成 */
  id?: string;
  plan_id?: number;
  plan_item_id?: number;
  knowledge_key: string;
  topic?: string;
  attempt?: number;
  date?: string;
  /** 可选实际用时；未提供时保留旧值，新记录以 0 表示未记录。 */
  actual_minutes?: number;
  explanation?: string;
  questions?: string;
  material_source?: string;
}

export type AssessmentSource = 'self' | 'objective' | 'ai_suggestion';

/** 测评记录：题目/标准/原答案/评分与依据，评分来源必须显式 */
export interface StudyAssessment {
  id: string;
  session_id: string | null;
  plan_id: number | null;
  plan_item_id: number | null;
  knowledge_key: string;
  topic: string;
  question: string;
  criteria: string;
  answer: string;
  source: AssessmentSource;
  /** 0~100；客观题由判题得出，自评由用户给出，未知为 null */
  score: number | null;
  /** 客观判题是否通过 */
  objective_passed: boolean | null;
  feedback: string;
  /** 依据（客观判题过程 / 自评理由），不可为空的证据说明 */
  evidence: string;
  /** 纠正历史：同一 id/同一题重提交且内容有实质变化时追加，保留旧值全貌（不丢答案/依据/反馈） */
  corrections: Array<{
    at: string;
    note: string;
    from_source: AssessmentSource;
    to_source: AssessmentSource;
    from_score: number | null;
    to_score: number | null;
    from_answer: string;
    to_answer: string;
    from_feedback: string;
    to_feedback: string;
    from_evidence: string;
    to_evidence: string;
    from_objective_passed: boolean | null;
    to_objective_passed: boolean | null;
  }>;
  date: string;
  created_at: string;
  updated_at: string;
}

export interface StudyAssessmentInput {
  id?: string;
  session_id?: string;
  plan_id?: number;
  plan_item_id?: number;
  knowledge_key: string;
  topic?: string;
  question: string;
  criteria?: string;
  answer: string;
  source: AssessmentSource;
  score?: number | null;
  objective_passed?: boolean | null;
  feedback?: string;
  evidence?: string;
  date?: string;
}

/** 掌握状态：只看测评证据，与任务完成率分开 */
export type MasteryStatus = 'unknown' | 'weak' | 'reviewing' | 'strong';

export interface MasteryEntry {
  knowledge_key: string;
  topic: string;
  mastery: MasteryStatus;
  /** 测评证据条数（0 = 无证据 → unknown） */
  evidence_count: number;
  /** 最新一次测评的来源与得分 */
  latest_source: AssessmentSource | null;
  latest_score: number | null;
  latest_objective_passed: boolean | null;
  last_assessed_at: string | null;
  session_count: number;
  /** 判定依据（中文，透明规则说明） */
  reason: string;
}

export interface MasteryReport {
  entries: MasteryEntry[];
  /** 关联计划的完成率（与掌握度分开呈现） */
  plan_progress: { total_items: number; done_items: number; progress: number } | null;
}

export type AdjustmentKind = 'reschedule' | 'add_review';

/** 未完成条目的调整建议（预览态，不写库；应用需显式确认） */
export interface AdjustmentSuggestion {
  /** 稳定建议 id（apply 时引用） */
  id: string;
  kind: AdjustmentKind;
  plan_id: number;
  item_id: number | null;
  knowledge_key: string | null;
  from_date: string | null;
  to_date: string;
  /** 建议内容（add_review 时为新复习条目标题） */
  content: string;
  duration_min: number;
  /** 透明依据：引用漏做/自评/错题证据 */
  reason: string;
}

export interface AdjustmentApplyResult {
  applied: Array<{ suggestion_id: string; kind: AdjustmentKind; effect: string }>;
  skipped: Array<{ suggestion_id: string; reason: string }>;
  plan_end_date: string;
  todos_synced: number;
}

/** 待审卡片预览（纯内存，不落盘） */
export interface StudyCard {
  /** 稳定卡片键：knowledge_key + session id 派生，导出去重依据 */
  card_key: string;
  file_name: string;
  markdown: string;
  session_id: string;
  knowledge_key: string;
  topic: string;
}

export interface CardExportOutcome {
  card_key: string;
  file_name: string;
  result: 'exported' | 'skipped_identical' | 'protected';
  detail: string;
}

export interface CardExportResult {
  export_dir: string;
  outcomes: CardExportOutcome[];
  exported: number;
  skipped: number;
  protected: number;
}

// ---------- 教学课程（v6） ----------

export type CourseStatus = 'imported' | 'sample_confirmed' | 'generating' | 'complete';
export type LessonStatus = 'pending' | 'generated' | 'read';
export type CourseRequestKind = 'full_generation';
export type CourseRequestStatus = 'pending' | 'claimed' | 'done' | 'failed';

/** 仓库课程附加的代码导读（纯文本元数据，绝不被执行） */
export interface LessonCodeRef {
  path: string;
  symbol: string;
  role: string;
  order: number;
}

export interface LessonQuizQuestion {
  id: string;
  question: string;
  options: string[];
  answer_index: number;
  explanation: string;
}

export interface CourseLesson {
  id: number;
  course_id: number;
  day: number;
  title: string;
  /** 讲义 HTML 相对课程目录的安全相对路径（导入时已防穿越+消毒） */
  html_rel: string;
  content_hash: string;
  /** 本课内容修订号：从 1 开始，仅实际内容更新时递增，由导入服务维护。 */
  revision: number;
  is_sample: boolean;
  status: LessonStatus;
  estimated_minutes: number;
  concepts: Array<{ name: string; explanation: string }>;
  code_refs: LessonCodeRef[];
  quiz: LessonQuizQuestion[];
  /** 用户作答记录（内容生成不算掌握，仅学习痕迹） */
  quiz_answers: Array<{ question_id: string; picked: number; at: string }>;
  created_at: string;
  updated_at: string;
}

/** 不占课程天数的独立总览正文 */
export interface CourseOverview {
  course_id: number;
  html_rel: string;
  content_hash: string;
  created_at: string;
  updated_at: string;
}

export interface Course {
  id: number;
  /** 稳定 slug（如 rust-crash-course），幂等导入键 */
  slug: string;
  title: string;
  goal: string;
  status: CourseStatus;
  /** 绑定的既有学习计划 id（导入时引用，绝不重复创建计划） */
  plan_id: number | null;
  /** 样课内容哈希——确认绑定此版本，样课变更使确认过期 */
  sample_content_hash: string | null;
  sample_confirmed_at: string | null;
  version: string;
  created_at: string;
  updated_at: string;
}

export interface CourseRequest {
  id: number;
  course_id: number;
  kind: CourseRequestKind;
  status: CourseRequestStatus;
  /** 请求创建时的样课哈希（批准绑定；样课变更后请求拒绝执行） */
  sample_content_hash: string;
  requested_by: string;
  claimed_by: string | null;
  error: string | null;
  created_at: string;
  claimed_at: string | null;
  completed_at: string | null;
}

/** 课程包导入清单（staging 目录根的 course.json） */
export interface CoursePackageManifest {
  /** v2 要求独立总览；缺省视为兼容旧课程包 */
  schema_version?: 1 | 2;
  slug: string;
  title: string;
  goal?: string;
  version: string;
  plan_id?: number | null;
  /** 独立总览讲义；旧课程包可缺省，新的课程包应单独生成 */
  overview?: { html: string };
  lessons: Array<{
    day: number;
    title: string;
    html: string;
    estimated_minutes?: number;
    is_sample?: boolean;
    concepts?: Array<{ name: string; explanation: string }>;
    code_refs?: Array<{ path: string; symbol: string; role: string; order?: number }>;
    quiz?: Array<{ question: string; options: string[]; answer_index: number; explanation: string }>;
  }>;
}

export interface CourseImportResult {
  course: Course;
  lessons: CourseLesson[];
  /** true = 重复导入（内容一致，幂等无新变更） */
  idempotent: boolean;
  /** 样课内容变化导致的确认过期提示 */
  confirmation_expired: boolean;
}

// ---------- 知识库（Obsidian vault 只读联动） ----------

/** vault 笔记分区：由所在目录推导（moc 导航 / 正式卡 / 待审草稿 / raw 原料） */
export type VaultNoteKind = 'moc' | 'card' | 'draft' | 'raw' | 'other';

/** 道法术器层级：由 resources/ 子目录推导，非资源卡为 null */
export type VaultNoteLevel = 'dao' | 'fa' | 'shu' | 'qi' | null;

export interface Vault {
  id: number;
  name: string;
  /** vault 根目录绝对路径（注册时已 realpath 规范化） */
  root_path: string;
  /** 参与索引的子目录（相对路径数组；默认 moc/resources/inbox-cards） */
  include_dirs: string[];
  /** 是否索引 raw/ 原料区（默认关） */
  include_raw: boolean;
  created_at: string;
  updated_at: string;
  /** 最近一次扫描时间（null=从未扫描） */
  last_scan_at: string | null;
  last_scan_stats: VaultScanStats | null;
}

export interface VaultScanStats {
  /** 本次扫描发现的 markdown 文件数 */
  discovered: number;
  /** 内容/元数据有变更新入索引的条数 */
  updated: number;
  /** 与索引一致未动的条数 */
  unchanged: number;
  /** 磁盘上消失被标记 missing 的条数（历史保留，不删记录） */
  missing: number;
  /** 因超限（体积/不可读）跳过的文件数 */
  skipped: number;
  /** 不存在的 include_dirs（提示用户配置过期） */
  invalid_dirs: string[];
  duration_ms: number;
}

export interface VaultNote {
  id: number;
  vault_id: number;
  /** 相对 vault 根的安全相对路径（正斜杠分隔） */
  rel_path: string;
  title: string;
  kind: VaultNoteKind;
  level: VaultNoteLevel;
  /** frontmatter 的 status 字段（active/draft 等；无 frontmatter 为 null） */
  status: string | null;
  /** 解析后的 frontmatter（仅标量与字符串数组；解析失败为空对象） */
  frontmatter: Record<string, unknown>;
  /** 文件内容 sha256（阅读时校验，检测索引过期） */
  file_hash: string;
  mtime_ms: number;
  size: number;
  /** 磁盘文件已消失（保留记录与关联历史，不静默删除） */
  missing: boolean;
  indexed_at: string;
}

export interface VaultNoteLink {
  /** 笔记内原始链接文本（[[目标|别名]] 的目标部分） */
  raw_target: string;
  /** 唯一命中时的解析结果；null=断链或多义 */
  resolved: { vault_id: number; rel_path: string; title: string } | null;
  /** 同名/同尾缀候选（resolved 为 null 且有候选时给出，供用户选择） */
  candidates: Array<{ vault_id: number; rel_path: string; title: string }>;
}

export interface VaultNoteDetail {
  note: VaultNote;
  /** 活体正文（读取时从磁盘原文件加载，非索引副本） */
  markdown: string;
  /** 安全渲染后的 HTML（App 侧 iframe sandbox 渲染；已转义全部原始 HTML） */
  html: string;
  /** 读取时文件哈希与索引不一致（提示重新扫描） */
  stale: boolean;
  links: VaultNoteLink[];
  /** 双向wikilink：哪些笔记链接到本笔记 */
  backlinks: Array<{ vault_id: number; rel_path: string; title: string }>;
  concept_links: VaultConceptLink[];
}

export interface VaultConceptLink {
  id: number;
  vault_id: number;
  note_id: number;
  /** Dayfolio 学习概念稳定标识（plan_items.knowledge_key 同一命名空间） */
  knowledge_key: string;
  created_at: string;
}

export interface VaultNoteFilters {
  vault_id?: number;
  kind?: VaultNoteKind | 'all';
  level?: 'dao' | 'fa' | 'shu' | 'qi' | 'all';
  status?: string;
  search?: string;
  /** true=只看磁盘缺失；false=只看在盘；undefined=全部 */
  missing?: boolean;
  limit?: number;
}

// ---------- 自媒体（选题→内容→素材→日历→复盘 工作流） ----------

export type MediaTopicStatus = 'idea' | 'selected' | 'dropped';
/** 选题/素材来源：news=新闻收藏 knowledge=知识卡片 manual=手工 */
export type MediaSource = 'news' | 'knowledge' | 'manual';

export interface MediaTopic {
  id: number;
  title: string;
  /** 角度/立意说明 */
  angle: string;
  status: MediaTopicStatus;
  source: MediaSource;
  source_news_id: number | null;
  /** 来源知识卡片（vault 路径引用，JSON 字符串 {vault_id, rel_path}） */
  source_note: string | null;
  /** 来源快照（创建时留存标题/URL，防原对象删除后无从追溯） */
  source_desc: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export type MediaContentStatus = 'drafting' | 'master_done';

export interface MediaContentVersion {
  id: number;
  content_id: number;
  /** 平台标识（xiaohongshu/weixin/douyin/bilibili/zhihu/weibo/x 等，自由小写串） */
  platform: string;
  body: string;
  /** draft→in_review→approved/rejected；rejected 可改回 draft 重提 */
  status: 'draft' | 'in_review' | 'approved' | 'rejected';
  review_note: string;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MediaContent {
  id: number;
  topic_id: number | null;
  title: string;
  /** 母稿（一稿多平台适配的唯一上游） */
  master_content: string;
  status: MediaContentStatus;
  /** 复盘笔记（发布后回填的经验总结） */
  retro_note: string;
  created_at: string;
  updated_at: string;
}

export type MediaMaterialKind = 'text' | 'image' | 'link' | 'note';

export interface MediaMaterial {
  id: number;
  title: string;
  kind: MediaMaterialKind;
  /** 素材正文/链接 URL/图片说明（文本；图片文件本身不入库，包导出时按说明列出） */
  content: string;
  source: MediaSource;
  source_news_id: number | null;
  source_note: string | null;
  source_desc: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export type MediaCalendarStatus = 'planned' | 'published' | 'cancelled';

export interface MediaCalendarEntry {
  id: number;
  content_version_id: number;
  content_id: number;
  content_title: string;
  platform: string;
  /** 计划发布日期 YYYY-MM-DD */
  planned_date: string;
  status: MediaCalendarStatus;
  published_at: string | null;
  /** 人工发布后回填的作品链接（不自动发布，仅记录） */
  publish_url: string | null;
  note: string;
  created_at: string;
  updated_at: string;
}

export interface MediaMetric {
  id: number;
  calendar_id: number;
  /** 数据日期 YYYY-MM-DD（同一排期同日重复录入为覆盖更新） */
  date: string;
  platform: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  favorites: number | null;
  /** 其他指标（键值对，如 完播率/涨粉） */
  custom: Record<string, number>;
  note: string;
  created_at: string;
  updated_at: string;
}

export interface MediaOverview {
  topics: { idea: number; selected: number; dropped: number };
  contents: { drafting: number; master_done: number };
  versions: { draft: number; in_review: number; approved: number; rejected: number };
  calendar: { planned: number; published: number; cancelled: number };
  /** 近 30 天已发布数 */
  published_last_30d: number;
  /** 待人工审核版本（in_review）明细 */
  pending_review: Array<{ id: number; content_id: number; content_title: string; platform: string; updated_at: string }>;
  /** 未来 7 天排期 */
  upcoming: Array<{ id: number; planned_date: string; content_title: string; platform: string }>;
  materials: number;
}

export interface MediaPlatformStats {
  platform: string;
  published: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  favorites: number;
}

export interface MediaPackageExport {
  content_id: number;
  title: string;
  /** 素材包写入的目录（用户指定，经 vault 重叠校验） */
  dir: string;
  files: string[];
  versions: number;
  materials: number;
}
