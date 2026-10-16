// Dayfolio 共享核心层入口：App（Electron 主进程）与 MCP Server 共同复用
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { initDb, inTx, type DbAdapter } from './db';
import { runMigrations } from './migrations';
import { createRelationService, type RelationService } from './ontology/relations';
import { createCommandService, type CommandService } from './ontology/commands';
import { createActionService, type ActionService } from './ontology/action';
import { createQueryService, type QueryService } from './ontology/query';
import { OntologyError } from './ontology/policy';
import { createActionRunService, type ActionRunService } from './services/action-run';
import { createObjectRepo, type ObjectRepo } from './ontology/repo';
import { createOntologyService, type OntologyService } from './ontology/registry';
import { createCheckinService, type CheckinService } from './services/checkin';
import { createCalendarService, type CalendarService } from './services/calendar';
import { createNewsService, type NewsService } from './services/news';
import { createPlanService, type PlanService } from './services/plan';
import { createReviewService, type ReviewService } from './services/review';
import { createCourseService, type CourseService } from './services/course';
import { createStudyService, type StudyService } from './services/study';
import { createMediaService, type MediaService } from './services/media';
import { createTodayService } from './services/today';
import { createTodoService, type TodoService } from './services/todo';
import { createToolAssetService } from './services/tool-assets';
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
export type { CalendarService } from './services/calendar';
export { CALENDAR_RANGE_MAX_DAYS } from './services/calendar';
export type { PlanService } from './services/plan';
export type { CheckinService } from './services/checkin';
export type { NewsService } from './services/news';
export {
  beijingDateOf,
  normalizeNewsEventTitle,
  validateSourceUrl,
  newsRootForDb,
  sanitizeNewsHtml,
  ensureStandaloneNewsHtml,
  NEWS_DIR_NAME,
  NEWS_HTML_MAX_CHARS,
  NEWS_TASK_MAX_ITEMS,
  NEWS_SUBMIT_BATCH_MAX,
  NEWS_TASK_LEASE_MS,
  NEWS_TASK_MAX_OPEN,
  NEWS_TASK_WINDOW_DEFAULT_HOURS,
} from './services/news';
export { newsDedupKey } from './utils/news-dedup';
export type { ToolService } from './services/tool';
export type { ReviewService, NewReviewScheduleInput, ReviewTopicInput } from './services/review';
export type { CourseService } from './services/course';
export { coursesRootForDb, sanitizeLessonHtml, validateCourseManifest, COURSES_DIR_NAME } from './services/course';
export type { StudyService } from './services/study';
export type { MediaService } from './services/media';
export type { VaultService } from './services/vault';
export {
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
  /** 个人本地日历：日程 CRUD + 区间聚合（今日页月视图） */
  calendar: CalendarService;
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
  /** 元数据驱动的版本化只读查询，App/MCP 共用运行时合同。 */
  queries: QueryService;
  /** 动作执行：内置动作（核心服务）+ 声明式 DSL */
  actions: ActionService;
  /** 动作结果和幂等执行记录，只读公开视图。 */
  actionRuns: ActionRunService;
  commands: CommandService;
  relations: RelationService;
}

/**
 * 组装核心服务。打卡联动规则：
 * - 完成 todo → 记 ref_type='todo' 打卡
 * - 计划条目置 done → 记 ref_type='plan_item' 打卡，并联动完成其关联待办（不重复打卡）
 * - 撤销完成 → 对应打卡记录一并删除
 */
export function createCore(db: DbAdapter, opts: { dbPath?: string } = {}): TodoDeskCore {
  initDb(db);
  const ontology = createOntologyService(db);
  inTx(db,()=>{runMigrations(db);ontology.init();});
  const objectStore = createObjectRepo(db, ontology);
  const objects = { ...objectStore };
  const queries = createQueryService(db, ontology);
  let commands: CommandService;
  let publicTodos: TodoService;
  let publicPlans: PlanService;
  const checkins = createCheckinService(db);
  const todos = createTodoService(db, {
    onCompleted: (todoId, date, recordCheckin) => {
      if (recordCheckin) { commands.guard('checkin'); checkins.checkin({ ref_type: 'todo', ref_id: todoId, date }); }
    },
    onReopened: (todoId) => {
      commands.guard('remove_checkin');
      checkins.remove('todo', todoId, todayStr());
    },
  });
  const plans = createPlanService(db, {
    todos: { ...todos, add:(p)=>publicTodos.add(p), complete:(id,record)=>publicTodos.complete(id,record), reopen:(id)=>publicTodos.reopen(id) },
    onItemCompleted: (itemId, date) => {
      commands.guard('checkin');
      checkins.checkin({ ref_type: 'plan_item', ref_id: itemId, date, note: '计划条目完成' });
    },
    onItemReverted: (itemId, date) => {
      commands.guard('remove_checkin');
      checkins.remove('plan_item', itemId, date);
    },
  });
  const today = createTodayService(db, plans, checkins);
  const news = createNewsService(db, { dbPath: opts.dbPath ?? defaultDbPath() });
  const courses = createCourseService({ db, dbPath: opts.dbPath ?? defaultDbPath() });
  const guardedPlans: PlanService={...plans, create:(p)=>publicPlans.create(p), updateItemStatus:(id,status)=>publicPlans.updateItemStatus(id,status), remove:(id,opts)=>publicPlans.remove(id,opts)};
  const reviews = createReviewService({ plans:guardedPlans });
  const study = createStudyService(db, { plans:guardedPlans, todos:{...todos,add:(p)=>publicTodos.add(p),update:(id,p)=>publicTodos.update(id,p),remove:(id)=>publicTodos.remove(id)} });
  const tools = createToolAssetService(db,createToolService(db),opts.dbPath ?? defaultDbPath());
  const vaults = createVaultService(db);
  const media = createMediaService(db);
  const calendar = createCalendarService(db, queries);
  const services = { todos, plans, checkins, news, reviews, study, tools, courses, vaults, media, calendar };
  commands = createCommandService(db, ontology, services);
  publicTodos=commands.wrap('todos',todos); publicPlans=commands.wrap('plans',plans);
  const relationStore = createRelationService(db,ontology,objectStore,{attach:(l,r)=>commands.wrap('media',media).attachMaterial(l,r),detach:(l,r)=>commands.wrap('media',media).detachMaterial(l,r)});
  const relations = { ...relationStore };
  const legacyResolve=objects.resolveLinks;
  objects.resolveLinks=(apiName,row)=>{
    const result: ReturnType<typeof legacyResolve>=[];
    const type=ontology.getObjectType(apiName);
    for(const link of ontology.listLinkTypes()) for(const side of ['left','right'] as const) {
      if((side==='left'?link.leftType:link.rightType)!==apiName)continue;
      if(link.leftType==='day') {result.push(...legacyResolve(apiName,row).filter(l=>l.linkApiName===link.apiName));continue;}
      result.push(...relations.list(apiName,row[type.primaryKey],link.apiName,side).items);
    }
    return result;
  };
  const actionRunStore = createActionRunService(db);
  const actions = createActionService(db, ontology, objectStore, commands, relationStore, actionRunStore);
  const objectAction = actions.writeObject;
  objects.insert = (name, values) => objectAction(name, 'create', undefined, values) as ReturnType<ObjectRepo['insert']>;
  objects.update = (name, id, values) => objectAction(name, 'update', id, values) as ReturnType<ObjectRepo['update']>;
  objects.remove = (name, id) => { objectAction(name, 'delete', id); };
  objects.updateBy = objects.deleteBy = () => { throw new OntologyError('WRITE_REQUIRES_ACTION', '批量对象变更请执行明确的自定义动作'); };
  relations.create = (name, leftId, rightId, properties) => {
    return actions.writeRelation(name, 'create', leftId, rightId, properties) as ReturnType<RelationService['create']>;
  };
  relations.remove = (name, leftId, rightId) => {
    return actions.writeRelation(name, 'delete', leftId, rightId) as ReturnType<RelationService['remove']>;
  };
  return { db, today, ontology, objects, queries, actions, actionRuns: actionRunStore.public, commands, relations,
    todos:publicTodos, plans:publicPlans, checkins:commands.wrap('checkins',checkins),
    news:commands.wrap('news',news), reviews:commands.wrap('reviews',reviews), study:commands.wrap('study',study),
    tools:commands.wrap('tools',tools), courses:commands.wrap('courses',courses), vaults:commands.wrap('vaults',vaults), media:commands.wrap('media',media),
    calendar:commands.wrap('calendar',calendar),
  };
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
