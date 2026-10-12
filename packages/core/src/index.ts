// TodoDesk 共享核心层入口：App（Electron 主进程）与 MCP Server 共同复用
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { initDb, type DbAdapter } from './db';
import { runMigrations } from './migrations';
import { createActionService, type ActionService } from './ontology/action';
import { createObjectRepo, type ObjectRepo } from './ontology/repo';
import { createOntologyService, type OntologyService } from './ontology/registry';
import { createCheckinService, type CheckinService } from './services/checkin';
import { createNewsService, type NewsService } from './services/news';
import { createPlanService, type PlanService } from './services/plan';
import { createReviewService, type ReviewService } from './services/review';
import { createCourseService, type CourseService } from './services/course';
import { createStudyService, type StudyService } from './services/study';
import { createMediaService, type MediaService } from './services/media';
import { createTodayService } from './services/today';
import { createTodoService, type TodoService } from './services/todo';
import { createToolService, type ToolService } from './services/tool';
import { createVaultService, type VaultService } from './services/vault';
import { todayStr } from './utils/date';

export * from './types';
export { initDb, inTx } from './db';
export type { DbAdapter, SqlStatement } from './db';
export { openNodeSqliteDb } from './adapters/node-sqlite';
export { todayStr, addDays, ensureValidDateStr, nowIso, isoAfter, toDateStr, parseDateInput } from './utils/date';
export {
  collectToolFilesFromPaths,
  deleteToolFilesAt,
  listToolFiles,
  MAX_TOOL_FILES_BYTES,
  migrateToolFilesDir,
  pickEntryFile,
  sanitizeFileName,
  sanitizeToolPath,
  saveToolFilesTo,
  toolsRootForDb,
} from './utils/tool-files';
export type { TodoService } from './services/todo';
export type { PlanService } from './services/plan';
export type { CheckinService } from './services/checkin';
export type { NewsService } from './services/news';
export {
  createNewsService,
  beijingDateOf,
  normalizeNewsEventTitle,
  validateSourceUrl,
  NEWS_TASK_MAX_ITEMS,
  NEWS_SUBMIT_BATCH_MAX,
  NEWS_TASK_LEASE_MS,
  NEWS_TASK_MAX_OPEN,
  NEWS_TASK_WINDOW_DEFAULT_HOURS,
} from './services/news';
export { newsDedupKey } from './utils/news-dedup';
export type { ToolService } from './services/tool';
export { createToolService } from './services/tool';
export type { ReviewService, NewReviewScheduleInput, ReviewTopicInput } from './services/review';
export type { CourseService } from './services/course';
export { createCourseService, coursesRootForDb, sanitizeLessonHtml, validateCourseManifest, COURSES_DIR_NAME } from './services/course';
export type { StudyService } from './services/study';
export { createStudyService } from './services/study';
export type { MediaService } from './services/media';
export { createMediaService } from './services/media';
export type { VaultService } from './services/vault';
export {
  createVaultService,
  parseFrontmatter,
  extractWikiLinks,
  renderMarkdownHtml,
  isSafeVaultRelPath,
  assertDirOutsideVaults,
  defaultProtectedVaultDirs,
  protectedVaultRoots,
  realPathOfMaybeMissing,
  VAULT_MAX_FILE_BYTES,
  VAULT_DEFAULT_INCLUDE_DIRS,
} from './services/vault';
export {
  scheduleKnowledgePoints,
  normalizeKnowledgePoints,
  DEFAULT_KNOWLEDGE_POINT_MINUTES,
  DEFAULT_PLAN_DAILY_MINUTES,
  MASTERY_SELF_STRONG,
  MASTERY_SELF_WEAK,
  ADJUST_REVIEW_MINUTES,
} from './services/study';
export * from './ontology/types';
export { runMigrations } from './migrations';
export { createOntologyService } from './ontology/registry';
export { createObjectRepo } from './ontology/repo';
export { createActionService } from './ontology/action';
export type { OntologyService } from './ontology/registry';
export type { ObjectRepo } from './ontology/repo';
export type { ActionService } from './ontology/action';

export interface TodoDeskCore {
  db: DbAdapter;
  todos: TodoService;
  plans: PlanService;
  checkins: CheckinService;
  news: NewsService;
  reviews: ReviewService;
  /** 学习闭环 v1：草案/会话/测评/掌握度/调整建议/待审卡片 */
  study: StudyService;
  tools: ToolService;
  today: { getToday: (date?: string) => import('./types').TodayOverview };
  /** 教学课程：导入/阅读/答题/样课确认/生成请求队列 */
  courses: CourseService;
  /** 知识库 vault：只读注册/索引/搜索/阅读/概念关联（绝不写 vault 文件） */
  vaults: VaultService;
  /** 自媒体工作流：选题/内容/素材/日历/复盘（不登录不自动发布外部平台） */
  media: MediaService;
  /** 本体层：三类类型元数据的管理与校验（对象/链接/动作） */
  ontology: OntologyService;
  /** 通用对象仓储：类型驱动的 CRUD 与链接解析 */
  objects: ObjectRepo;
  /** 动作执行：内置动作（核心服务）+ 声明式 DSL */
  actions: ActionService;
}

/**
 * 组装核心服务。打卡联动规则：
 * - 完成 todo → 记 ref_type='todo' 打卡
 * - 计划条目置 done → 记 ref_type='plan_item' 打卡，并联动完成其关联待办（不重复打卡）
 * - 撤销完成 → 对应打卡记录一并删除
 */
export function createCore(db: DbAdapter, opts: { dbPath?: string } = {}): TodoDeskCore {
  initDb(db);
  runMigrations(db);
  const ontology = createOntologyService(db);
  ontology.init();
  const objects = createObjectRepo(db, ontology);
  const checkins = createCheckinService(db);
  const todos = createTodoService(db, {
    onCompleted: (todoId, date, recordCheckin) => {
      if (recordCheckin) checkins.checkin({ ref_type: 'todo', ref_id: todoId, date });
    },
    onReopened: (todoId) => {
      checkins.remove('todo', todoId, todayStr());
    },
  });
  const plans = createPlanService(db, {
    todos,
    onItemCompleted: (itemId, date) => {
      checkins.checkin({ ref_type: 'plan_item', ref_id: itemId, date, note: '计划条目完成' });
    },
    onItemReverted: (itemId, date) => {
      checkins.remove('plan_item', itemId, date);
    },
  });
  const today = createTodayService(db, plans, checkins);
  const news = createNewsService(db);
  const courses = createCourseService({ db, dbPath: opts.dbPath ?? defaultDbPath() });
  const reviews = createReviewService({ plans });
  const study = createStudyService(db, { plans, todos });
  const tools = createToolService(db);
  const vaults = createVaultService(db);
  const media = createMediaService(db);
  const actions = createActionService(db, ontology, objects, {
    add_todo: (p) => todos.add({ title: String(p.title), notes: p.notes ? String(p.notes) : undefined, priority: p.priority as never, due_date: p.due_date as never, tags: p.tags as never, source: 'mcp' }),
    complete_todo: (p) => todos.complete(Number(p.id)),
    reopen_todo: (p) => todos.reopen(Number(p.id)),
    delete_todo: (p) => todos.remove(Number(p.id)),
    checkin: (p) => checkins.checkin({ ref_type: p.ref_type as never, ref_id: Number(p.ref_id), date: p.date as never, note: p.note ? String(p.note) : undefined }),
  });
  return { db, todos, plans, checkins, news, reviews, study, tools, today, ontology, objects, actions, courses, vaults, media };
}

/** 默认数据库路径：环境变量 TODODESK_DB 优先（App 与 MCP 靠它指向同一份库） */
export function defaultDbPath(): string {
  const override = process.env.TODODESK_DB;
  if (override && override.trim()) return override.trim();
  const home = homedir();
  let dir: string;
  if (process.platform === 'darwin') {
    dir = join(home, 'Library', 'Application Support', 'tododesk');
  } else if (process.platform === 'win32') {
    dir = join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'tododesk');
  } else {
    dir = join(home, '.local', 'share', 'tododesk');
  }
  mkdirSync(dir, { recursive: true });
  return join(dir, 'tododesk.db');
}
