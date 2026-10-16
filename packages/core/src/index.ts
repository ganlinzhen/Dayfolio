// Dayfolio 共享核心层入口：App（Electron 主进程）与 MCP Server 共同复用
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { initDb, inTx, type DbAdapter } from './db';
import { runMigrations,MIGRATIONS } from './migrations';
import { createRelationService, type RelationService } from './ontology/relations';
import { createCommandService, type CommandService } from './ontology/commands';
import { createActionService, type ActionService } from './ontology/action';
import { createQueryService, type QueryService } from './ontology/query';
import { OntologyError } from './ontology/policy';
import { createActionRunService, type ActionRunService } from './services/action-run';
import { createObjectRepo, type ObjectRepo } from './ontology/repo';
import { createOntologyService, type OntologyService } from './ontology/registry';
import { createCheckinService, type CheckinService } from './services/checkin';
import { createCalendarQueryService, type CalendarQueryService } from './services/calendar-query';
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
import { createExtensionService,type ExtensionService } from './services/extensions';
import { createRuntimeService, type RuntimeService } from './services/runtime';
import { createSubscriptionService,scopeSubscriptionService,type SubscriptionService } from './services/subscriptions';
import { createExternalEventService,type ExternalEventService } from './services/external-events';
import { createProviderRefreshService } from './services/provider-refresh';
import type { ProviderNetwork,ProviderWorker } from './provider-types';
import { COMMAND_INPUTS } from './ontology/command-inputs';
import { validateCommandInput } from './ontology/input-validation';
import { runtimeError,dateInZone,displayTimezone } from './utils/schedule';
export * from './runtime-types';
export * from './extension-types';
export * from './provider-types';
export { RuntimeError,runtimeErrorInfo } from './utils/schedule';

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
  /** 受信 App/MCP 的刷新执行器；不向工具 SDK 暴露。 */
  providerWorker:ProviderWorker;
  runtime: RuntimeService;
  extensions:ExtensionService;
  externalEvents: ExternalEventService;
  subscriptions: SubscriptionService;
  /** 仅受信宿主根据实际 frame 身份创建范围接口；不能把此工厂暴露给工具页面。 */
  forExtension:(extensionId:string)=>{externalEvents:ExternalEventService;subscriptions:ReturnType<typeof scopeSubscriptionService>};
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
  calendar: CalendarService & CalendarQueryService & Pick<RuntimeService,'listCollections'|'setVisibility'>;
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
export function createCore(db: DbAdapter, opts: { dbPath?: string;providerNetwork?:ProviderNetwork } = {}): TodoDeskCore {
  if(Number(db.prepare('PRAGMA user_version').get()?.user_version??0)>Math.max(...MIGRATIONS.map(m=>m.version)))runtimeError('SCHEMA_TOO_NEW','数据库版本高于当前程序，拒绝写入');
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='runtime_revision'").get()&&Number(db.prepare('SELECT contract_major FROM runtime_revision WHERE id=1').get()?.contract_major)>1)runtimeError('HOST_API_UNSUPPORTED','数据库运行时合同高于当前程序，拒绝写入');
  initDb(db);
  const ontology = createOntologyService(db);
  inTx(db,()=>{runMigrations(db);ontology.init();});
  const objectStore = createObjectRepo(db, ontology);
  const objects = { ...objectStore };
  const queries = createQueryService(db, ontology);
  let commands: CommandService;
  let publicTodos: TodoService;
  let publicPlans: PlanService;
  let managedDepth=0;
  const managedWrite=<T>(fn:()=>T):T=>{managedDepth++;try{return fn();}finally{managedDepth--;}};
  const checkins = createCheckinService(db);
  const todos = createTodoService(db, {
    isManagedWrite:()=>managedDepth>0,
    onManagedEdited:(id)=>{db.prepare("UPDATE event_subscriptions SET sync_mode='manual',updated_at=? WHERE todo_id=? AND status='active'").run(new Date().toISOString(),id);},
    onBeforeRemoved:(id)=>{db.prepare("UPDATE event_subscriptions SET status='unsubscribed',updated_at=? WHERE todo_id=? AND status='active'").run(new Date().toISOString(),id);},
    onCompleted: (todoId, date, recordCheckin) => {
      if (recordCheckin) { commands.guard('checkin'); checkins.checkin({ ref_type: 'todo', ref_id: todoId, date }); }
    },
    onReopened: (todoId) => {
      commands.guard('remove_checkin');
      checkins.remove('todo', todoId, dateInZone(new Date(),displayTimezone(db)));
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
  const runtime=createRuntimeService(db,{todos:()=>publicTodos,managedWrite});
  const subscriptionModule=createSubscriptionService(db,{todos:()=>publicTodos,managedWrite});
  const subscriptions=subscriptionModule.service;
  const eventService=createExternalEventService(db,subscriptionModule.syncEvent);
  const refreshModule=createProviderRefreshService(db,{
    network:opts.providerNetwork,guard:name=>commands.guard(name),
    importEvents:(extensionId,input)=>{
      commands.guard('import_external_events');validateCommandInput(COMMAND_INPUTS.import_external_events?.[0],input,'import_external_events');
      const scoped=createSubscriptionService(db,{todos:()=>publicTodos,managedWrite},{extensionId});
      return createExternalEventService(db,scoped.syncEvent,{extensionId},'providers.refresh').import(input);
    },
  });
  const externalEvents={...eventService,...refreshModule.forActor()};
  const extensionModule=createExtensionService(db,{dbPath:opts.dbPath??defaultDbPath(),events:()=>commands.wrap('externalEvents',externalEvents),guard:name=>commands.guard(name)});
  const extensions=extensionModule.service;extensionModule.recover();
  const services = { extensions,todos, plans, checkins, news, reviews, study, tools, courses, vaults, media, calendar, runtime,subscriptions,externalEvents };
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
  const guarded=<T,R>(name:string,fn:(input:T)=>R)=>(input:T):R=>{commands.guard(name);validateCommandInput(COMMAND_INPUTS[name]?.[0],input,name);return fn(input);};
  const forExtension=(extensionId:string)=>{
    if(typeof extensionId!=='string'||!extensionId.trim()||!db.prepare('SELECT 1 FROM extensions WHERE id=?').get(extensionId))throw Object.assign(new Error('PERMISSION_DENIED: 工具身份无效'),{code:'PERMISSION_DENIED'});
    const scopedSubs=createSubscriptionService(db,{todos:()=>publicTodos,managedWrite},{extensionId});
    const ev={...createExternalEventService(db,scopedSubs.syncEvent,{extensionId}),...refreshModule.forActor({extensionId})};const sub=scopedSubs.service;
    return {externalEvents:{...ev,refresh:guarded('refresh_event_provider',ev.refresh),import:guarded('import_external_events',ev.import),archive:guarded('archive_external_event',ev.archive),deleteUnused:guarded('delete_unused_external_event',ev.deleteUnused),updateProvider:guarded('update_event_provider',ev.updateProvider)},subscriptions:scopeSubscriptionService({...sub,subscribe:guarded('subscribe_event',sub.subscribe),unsubscribe:guarded('unsubscribe_event',sub.unsubscribe),resumeFollowing:guarded('resume_event_following',sub.resumeFollowing)})};
  };
  return { db, today, ontology, objects, queries, actions, actionRuns: actionRunStore.public, commands, relations,providerWorker:refreshModule.worker,extensions:commands.wrap('extensions',extensions),runtime:commands.wrap('runtime',runtime),externalEvents:commands.wrap('externalEvents',externalEvents),subscriptions:commands.wrap('subscriptions',subscriptions),forExtension,
    todos:publicTodos, plans:publicPlans, checkins:commands.wrap('checkins',checkins),
    news:commands.wrap('news',news), reviews:commands.wrap('reviews',reviews), study:commands.wrap('study',study),
    tools:commands.wrap('tools',tools), courses:commands.wrap('courses',courses), vaults:commands.wrap('vaults',vaults), media:commands.wrap('media',media),
    calendar:{...commands.wrap('calendar',calendar),...createCalendarQueryService(db,runtime),listCollections:runtime.listCollections,setVisibility:commands.wrap('runtime',runtime).setVisibility},
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
