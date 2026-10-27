// 渲染进程访问 preload API 的类型声明与封装
/// <reference types="vite/client" />
import type { CalendarQuery,CalendarResult,CalendarCollection,TodoDeskCore,EventImportInput,EventListInput,SubscriptionInput,SubscriptionListInput,UnsubscribeInput,ResumeFollowingInput } from '../../../../../packages/core/src';
import type { AggregateResult, QueryResult, QueryRow, QueryService } from '../../../../../packages/core/src/ontology/query';
import type { ActionService } from '../../../../../packages/core/src/ontology/action';
import type { ActionRunService } from '../../../../../packages/core/src/services/action-run';
import type { AgentKitStatus } from '../../../../../packages/agent-kit/types';

export interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  code?: string;
  retryable?: boolean;
}

interface TododeskApi {
  toolFollowing:{[K in keyof TodoDeskCore['toolFollowing']]:(p:Parameters<TodoDeskCore['toolFollowing'][K]>[0])=>Promise<ApiResult<ReturnType<TodoDeskCore['toolFollowing'][K]>>>};
  toolTodos: {
    preview: (p: Parameters<TodoDeskCore['toolTodos']['preview']>[0]) => Promise<ApiResult<ReturnType<TodoDeskCore['toolTodos']['preview']>>>;
    create: (p: Parameters<TodoDeskCore['toolTodos']['create']>[0]) => Promise<ApiResult<ReturnType<TodoDeskCore['toolTodos']['create']>>>;
    getStatus: (p: Parameters<TodoDeskCore['toolTodos']['getStatus']>[0]) => Promise<ApiResult<ReturnType<TodoDeskCore['toolTodos']['getStatus']>>>;
  };
  extensions:{
    bindSession:(p:{extensionId:string;nonce:string})=>Promise<ApiResult<{sessionToken:string;releaseDigest:string}>>;
    releaseSession:(p:{sessionToken:string})=>Promise<ApiResult<boolean>>;
    sdkRequest:(p:{sessionToken:string;request:unknown})=>Promise<ApiResult<unknown>>;
    onOpenTodo:(listener:(target:{objectType:'todo';id:number})=>void)=>()=>void;
    describe:()=>Promise<ApiResult<unknown>>;
    pickDirectory:()=>Promise<ApiResult<string|null>>;
    previewInstall:(p:Parameters<TodoDeskCore['extensions']['previewInstall']>[0])=>Promise<ApiResult<ReturnType<TodoDeskCore['extensions']['previewInstall']>>>;
    authorizeInstall:(p:Parameters<TodoDeskCore['extensions']['authorizeInstall']>[0])=>Promise<ApiResult<ReturnType<TodoDeskCore['extensions']['authorizeInstall']>>>;
    install:(p:Parameters<TodoDeskCore['extensions']['install']>[0])=>Promise<ApiResult<ReturnType<TodoDeskCore['extensions']['install']>>>;
    list:()=>Promise<ApiResult<ReturnType<TodoDeskCore['extensions']['list']>>>;
    get:(p:{extensionId:string})=>Promise<ApiResult<ReturnType<TodoDeskCore['extensions']['get']>>>;
    getHelp:(p:{extensionId:string})=>Promise<ApiResult<ReturnType<TodoDeskCore['extensions']['getHelp']>>>;
    setEnabled:(p:Parameters<TodoDeskCore['extensions']['setEnabled']>[0])=>Promise<ApiResult<ReturnType<TodoDeskCore['extensions']['setEnabled']>>>;
    rollback:(p:Parameters<TodoDeskCore['extensions']['rollback']>[0])=>Promise<ApiResult<ReturnType<TodoDeskCore['extensions']['rollback']>>>;
    uninstall:(p:Parameters<TodoDeskCore['extensions']['uninstall']>[0])=>Promise<ApiResult<ReturnType<TodoDeskCore['extensions']['uninstall']>>>;
  };
  runtime:{revision:()=>Promise<ApiResult<number>>;timezone:()=>Promise<ApiResult<string>>;setTimezone:(p:{zone:string})=>Promise<ApiResult<string>>};
  events:{
    refresh:(p:Parameters<TodoDeskCore['externalEvents']['refresh']>[0])=>Promise<ApiResult<ReturnType<TodoDeskCore['externalEvents']['refresh']>>>;
    getRun:(p:Parameters<TodoDeskCore['externalEvents']['getRun']>[0])=>Promise<ApiResult<ReturnType<TodoDeskCore['externalEvents']['getRun']>>>;
    getStatus:(p:Parameters<TodoDeskCore['externalEvents']['getStatus']>[0])=>Promise<ApiResult<ReturnType<TodoDeskCore['externalEvents']['getStatus']>>>;
    listProviders:()=>Promise<ApiResult<ReturnType<TodoDeskCore['externalEvents']['listProviders']>>>;
    updateProvider:(p:Parameters<TodoDeskCore['externalEvents']['updateProvider']>[0])=>Promise<ApiResult<ReturnType<TodoDeskCore['externalEvents']['updateProvider']>>>;
    import:(p:EventImportInput)=>Promise<ApiResult<ReturnType<TodoDeskCore['externalEvents']['import']>>>;
    list:(p:EventListInput)=>Promise<ApiResult<ReturnType<TodoDeskCore['externalEvents']['list']>>>;
    get:(p:SubscriptionInput)=>Promise<ApiResult<ReturnType<TodoDeskCore['externalEvents']['get']>>>;
    archive:(p:SubscriptionInput)=>Promise<ApiResult<void>>;
    deleteUnused:(p:SubscriptionInput)=>Promise<ApiResult<void>>;
  };
  subscriptions:{
    subscribe:(p:SubscriptionInput)=>Promise<ApiResult<ReturnType<TodoDeskCore['subscriptions']['subscribe']>>>;
    get:(p:SubscriptionInput)=>Promise<ApiResult<ReturnType<TodoDeskCore['subscriptions']['get']>>>;
    list:(p:SubscriptionListInput)=>Promise<ApiResult<ReturnType<TodoDeskCore['subscriptions']['list']>>>;
    unsubscribe:(p:UnsubscribeInput)=>Promise<ApiResult<ReturnType<TodoDeskCore['subscriptions']['unsubscribe']>>>;
    resumeFollowing:(p:ResumeFollowingInput)=>Promise<ApiResult<ReturnType<TodoDeskCore['subscriptions']['resumeFollowing']>>>;
  };
  agent: {
    status: () => Promise<ApiResult<AgentKitStatus>>;
    export: () => Promise<ApiResult<{ version: string; target: string } | null>>;
  };
  todos: {
    list: (p?: unknown) => Promise<ApiResult<unknown[]>>;
    add: (p: unknown) => Promise<ApiResult<unknown>>;
    update: (p: unknown) => Promise<ApiResult<unknown>>;
    complete: (p: { id: number }) => Promise<ApiResult<unknown>>;
    reopen: (p: { id: number }) => Promise<ApiResult<unknown>>;
    delete: (p: { id: number }) => Promise<ApiResult<boolean>>;
  };
  plans: {
    create: (p: unknown) => Promise<ApiResult<unknown>>;
    list: (p?: unknown) => Promise<ApiResult<unknown[]>>;
    get: (p: { id: number }) => Promise<ApiResult<unknown>>;
    updateItemStatus: (p: { id: number; status: string }) => Promise<ApiResult<unknown>>;
    update: (p: unknown) => Promise<ApiResult<unknown>>;
    delete: (p: { id: number; delete_todos?: boolean }) => Promise<ApiResult<boolean>>;
  };
  checkins: {
    checkin: (p: unknown) => Promise<ApiResult<unknown>>;
    list: (p?: unknown) => Promise<ApiResult<unknown[]>>;
    stats: () => Promise<ApiResult<unknown>>;
  };
  today: {
    get: (p?: { date?: string }) => Promise<ApiResult<unknown>>;
  };
  calendar: {
    queryItems:(p:CalendarQuery)=>Promise<ApiResult<CalendarResult>>;
    listCollections:()=>Promise<ApiResult<CalendarCollection[]>>;
    setVisibility:(p:{collectionId:string;visible:boolean})=>Promise<ApiResult<void>>;
    updateCollection:(p:Parameters<TodoDeskCore['runtime']['updateCollection']>[0])=>Promise<ApiResult<CalendarCollection>>;
    deleteCollection:(p:Parameters<TodoDeskCore['runtime']['deleteCollection']>[0])=>Promise<ApiResult<ReturnType<TodoDeskCore['runtime']['deleteCollection']>>>;
    list: (p?: { from?: string; to?: string; search?: string; limit?: number }) => Promise<ApiResult<unknown[]>>;
    rangeAgenda: (p: { from: string; to: string }) => Promise<ApiResult<unknown>>;
    add: (p: { title: string; date: string; end_date?: string | null; start_time?: string | null; end_time?: string | null; note?: string; color?: string; source?: string }) => Promise<ApiResult<unknown>>;
    update: (p: { id: number } & Record<string, unknown>) => Promise<ApiResult<unknown>>;
    delete: (p: { id: number }) => Promise<ApiResult<boolean>>;
  };
  study: {
    getProgress: (p?: { plan_id?: number }) => Promise<ApiResult<ReturnType<TodoDeskCore['study']['getProgress']>>>;
    recordSession: (p: Parameters<TodoDeskCore['study']['recordSession']>[0]) => Promise<ApiResult<unknown>>;
    copyPrompt: (p: { text: string }) => Promise<ApiResult<boolean>>;
    listDrafts: (p?: { status?: 'draft' | 'confirmed' | 'cancelled' }) => Promise<ApiResult<unknown[]>>;
    getDraft: (p: { id: number }) => Promise<ApiResult<unknown>>;
    confirmDraft: (p: { id: number; confirmed_over_dates?: string[] }) => Promise<ApiResult<unknown>>;
    cancelDraft: (p: { id: number }) => Promise<ApiResult<unknown>>;
    previewSchedule: (p: { id: number; start_date: string; daily_minutes: number }) => Promise<ApiResult<unknown>>;
    scheduleDraft: (p: { id: number; start_date: string; daily_minutes: number; confirmed_over_dates?: string[] }) => Promise<ApiResult<unknown>>;
    listSessions: (p?: { plan_id?: number; plan_item_id?: number; knowledge_key?: string; limit?: number }) => Promise<ApiResult<unknown[]>>;
    listAssessments: (p?: { plan_id?: number; knowledge_key?: string; session_id?: string; limit?: number }) => Promise<ApiResult<unknown[]>>;
    getMastery: (p?: { plan_id?: number; knowledge_keys?: string[] }) => Promise<ApiResult<unknown>>;
    suggestAdjustments: (p: { plan_id: number }) => Promise<ApiResult<unknown[]>>;
    applyAdjustments: (p: { plan_id: number; suggestions: Array<{ id: string; to_date: string }> }) => Promise<ApiResult<unknown>>;
    previewCards: (p?: { plan_id?: number; knowledge_keys?: string[]; session_ids?: string[] }) => Promise<ApiResult<unknown[]>>;
    exportCards: (p: { export_dir: string; plan_id?: number; knowledge_keys?: string[]; session_ids?: string[] }) => Promise<ApiResult<unknown>>;
    listCardExports: () => Promise<ApiResult<unknown[]>>;
    pickExportDir: () => Promise<ApiResult<string | null>>;
  };
  courses: {
    remove: (p: { course_id: number; expected_slug: string }) => Promise<ApiResult<{ assets_removed: boolean; cleanup_warning?: string }>>;
    import: (p: { staging_dir: string }) => Promise<ApiResult<unknown>>;
    list: () => Promise<ApiResult<unknown[]>>;
    lessons: (p: { course_id: number }) => Promise<ApiResult<unknown[]>>;
    overviewHtml: (p: { course_id: number }) => Promise<ApiResult<{ overview: unknown; html: string } | null>>;
    lessonHtml: (p: { course_id: number; day: number }) => Promise<ApiResult<{ lesson: unknown; html: string }>>;
    markRead: (p: { course_id: number; day: number }) => Promise<ApiResult<unknown>>;
    submitQuiz: (p: { course_id: number; day: number; answers: Array<{ question_id: string; picked: number }> }) => Promise<ApiResult<unknown>>;
    confirmSample: (p: { course_id: number }) => Promise<ApiResult<unknown>>;
    createRequest: (p: { course_id: number }) => Promise<ApiResult<unknown>>;
    listRequests: (p?: { status?: string; course_id?: number }) => Promise<ApiResult<unknown[]>>;
  };
  agentSettings: {
    get: () => Promise<ApiResult<import('../../../../../packages/core/src').AgentSettings>>;
    update: (p: import('../../../../../packages/core/src').AgentSettingsInput) => Promise<ApiResult<import('../../../../../packages/core/src').AgentSettings>>;
    check: (p: import('../../main/agent-adapters').AgentConnection) => Promise<ApiResult<import('../../main/agent-adapters').AgentStatus>>;
    pickBinary: () => Promise<ApiResult<string | null>>;
  };
  news: {
    feedConfig: () => Promise<ApiResult<import('../../../../../packages/core/src/news-types').NewsFeedConfig>>;
    feedUpdateConfig: (p: { config: import('../../../../../packages/core/src/news-types').NewsFeedConfig; expected_revision: number }) => Promise<ApiResult<import('../../../../../packages/core/src/news-types').NewsFeedConfig>>;
    feedPreview: (p?: { module_id?: string; config?: import('../../../../../packages/core/src/news-types').NewsFeedConfig }) => Promise<ApiResult<import('../../../../../packages/core/src/news-types').NewsFeedPreview>>;
    feedStartUpdate: (p?: { trigger?: 'manual' | 'scheduled' }) => Promise<ApiResult<import('../../../../../packages/core/src/news-types').NewsFeedBatch>>;
    feedAdvance: (p?: { batch_id?: string }) => Promise<ApiResult<import('../../../../../packages/core/src/news-types').NewsFeedBatch | null>>;
    feedStopUpdate: (p: { batch_id: string }) => Promise<ApiResult<import('../../../../../packages/core/src/news-types').NewsFeedBatch>>;
    feedContinueUpdate: (p: { batch_id: string }) => Promise<ApiResult<import('../../../../../packages/core/src/news-types').NewsFeedBatch>>;
    feedBatches: (p?: { limit?: number }) => Promise<ApiResult<import('../../../../../packages/core/src/news-types').NewsFeedBatch[]>>;
    feedList: (p?: { module_id?: string; filter?: 'all' | 'unread' | 'starred' | 'hidden'; search?: string; history?: boolean; corrections_only?: boolean; hidden?: boolean; limit?: number; offset?: number }) => Promise<ApiResult<import('../../../../../packages/core/src/news-types').NewsFeedItem[]>>;
    feedFeedback: (p: import('../../../../../packages/core/src/news-types').NewsFeedbackInput & { reading_token?: string }) => Promise<ApiResult<unknown>>;
    feedReadingState: (p: { id: number }) => Promise<ApiResult<{ visible: boolean; token: string }>>;
    feedInterests: () => Promise<ApiResult<import('../../../../../packages/core/src/news-types').NewsInterestState>>;
    feedManageSource: (p: import('../../../../../packages/core/src/news-types').NewsSourceInput) => Promise<ApiResult<import('../../../../../packages/core/src/news-types').NewsInterestState>>;
    feedScheduleStatus: () => Promise<ApiResult<import('../../../../../packages/core/src/services/news-schedule').NewsScheduleStatus & { error: string | null }>>;
    feedManageTopic: (p: import('../../../../../packages/core/src/news-types').NewsTopicInput) => Promise<ApiResult<unknown>>;
    feedResetLearning: () => Promise<ApiResult<import('../../../../../packages/core/src/news-types').NewsInterestState>>;
    feedImportStarred: (p: { news_ids: number[] }) => Promise<ApiResult<unknown>>;
    feedUpdateEvent: (p: import('../../../../../packages/core/src/news-types').NewsEventInput) => Promise<ApiResult<import('../../../../../packages/core/src/news-types').NewsEventFollow>>;
    feedSubmitCorrection: (p: import('../../../../../packages/core/src/news-types').NewsCorrectionInput) => Promise<ApiResult<import('../../../../../packages/core/src/news-types').NewsCorrection>>;
    feedDismissCorrection: (p: { id: string }) => Promise<ApiResult<unknown>>;
    feedDismissEventReminder: (p: { id: string }) => Promise<ApiResult<unknown>>;
    agentStatus: () => Promise<ApiResult<import('../../main/news-agent-runner').NewsAgentStatus>>;
    agentRuns: (p?: { task_id?: number }) => Promise<ApiResult<import('../../../../../packages/core/src').NewsRun[]>>;
    runAgent: (p?: { task_id?: number }) => Promise<ApiResult<import('../../../../../packages/core/src').NewsRun>>;
    stopAgent: (p: { run_id: string }) => Promise<ApiResult<import('../../../../../packages/core/src').NewsRun>>;

    collectionSettings: () => Promise<ApiResult<import('../../../../../packages/core/src/types').NewsCollectionSettings>>;
    updateCollectionSettings: (p: { prompt: string; max_items: number; window_hours: number; expected_revision: number }) => Promise<ApiResult<import('../../../../../packages/core/src/types').NewsCollectionSettings>>;
    list: (p?: { days?: number; task_id?: number; search?: string; filter?: 'all' | 'unread' | 'starred'; since?: string; limit?: number; offset?: number }) => Promise<ApiResult<unknown[]>>;
    tasks: (p?: { status?: string; limit?: number }) => Promise<ApiResult<unknown[]>>;
    cancelTask: (p: { id: number }) => Promise<ApiResult<unknown>>;
    markRead: (p: { id: number; read?: boolean }) => Promise<ApiResult<unknown>>;
    markStarred: (p: { id: number; starred?: boolean }) => Promise<ApiResult<unknown>>;
    markAllRead: (p?: { task_id?: number }) => Promise<ApiResult<number>>;
    delete: (p: { id: number }) => Promise<ApiResult<{ deleted: boolean; id: number; topic_links_removed: number; media_refs_cleared: number; fingerprints_kept: number }>>;
    openUrl: (p: { url: string }) => Promise<ApiResult<boolean>>;
  };
  tools: {
    listCategories: () => Promise<ApiResult<unknown[]>>;
    addCategory: (p: { name: string }) => Promise<ApiResult<unknown>>;
    renameCategory: (p: { id: number; name: string }) => Promise<ApiResult<void>>;
    deleteCategory: (p: { id: number }) => Promise<ApiResult<boolean>>;
    reorderCategories: (p: { ids: number[] }) => Promise<ApiResult<unknown[]>>;
    list: () => Promise<ApiResult<unknown[]>>;
    listFiles: (p: { id: number }) => Promise<ApiResult<string[]>>;
    reorder: (p: { ids: number[] }) => Promise<ApiResult<unknown[]>>;
    add: (p: unknown) => Promise<ApiResult<unknown>>;
    update: (p: unknown) => Promise<ApiResult<unknown>>;
    delete: (p: { id: number }) => Promise<ApiResult<boolean>>;
  };
  vault: {
    pickRoot: () => Promise<ApiResult<string | null>>;
    register: (p: { root_path: string; name?: string; include_dirs?: string[]; include_raw?: boolean }) => Promise<ApiResult<unknown>>;
    list: () => Promise<ApiResult<unknown[]>>;
    update: (p: { id: number; name?: string; include_dirs?: string[]; include_raw?: boolean }) => Promise<ApiResult<unknown>>;
    remove: (p: { id: number }) => Promise<ApiResult<boolean>>;
    scan: (p: { id: number }) => Promise<ApiResult<unknown>>;
    notes: (p?: { vault_id?: number; kind?: string; level?: string; search?: string; missing?: boolean; limit?: number }) => Promise<ApiResult<unknown[]>>;
    getNote: (p: { vault_id: number; rel_path: string }) => Promise<ApiResult<unknown>>;
    linkConcept: (p: { vault_id: number; rel_path: string; knowledge_key: string }) => Promise<ApiResult<unknown>>;
    unlinkConcept: (p: { id: number }) => Promise<ApiResult<boolean>>;
    listConceptLinks: (p?: { knowledge_key?: string; note_id?: number }) => Promise<ApiResult<unknown[]>>;
    revealInFinder: (p: { vault_id: number; rel_path: string }) => Promise<ApiResult<boolean>>;
  };
  media: {
    addTopic: (p: unknown) => Promise<ApiResult<unknown>>;
    listTopics: (p?: { status?: string; search?: string }) => Promise<ApiResult<unknown[]>>;
    updateTopic: (p: { id: number } & Record<string, unknown>) => Promise<ApiResult<unknown>>;
    deleteTopic: (p: { id: number }) => Promise<ApiResult<boolean>>;
    addContent: (p: { topic_id?: number | null; title: string; master_content?: string }) => Promise<ApiResult<unknown>>;
    listContents: (p?: { topic_id?: number; status?: string; search?: string }) => Promise<ApiResult<unknown[]>>;
    getContent: (p: { id: number }) => Promise<ApiResult<unknown>>;
    updateContent: (p: { id: number } & Record<string, unknown>) => Promise<ApiResult<unknown>>;
    deleteContent: (p: { id: number }) => Promise<ApiResult<boolean>>;
    addVersion: (p: { content_id: number; platform: string; body?: string }) => Promise<ApiResult<unknown>>;
    updateVersion: (p: { id: number; body: string }) => Promise<ApiResult<unknown>>;
    reviewVersion: (p: { id: number; action: 'submit' | 'approve' | 'reject' | 'revoke'; note?: string }) => Promise<ApiResult<unknown>>;
    addMaterial: (p: unknown) => Promise<ApiResult<unknown>>;
    listMaterials: (p?: { search?: string; kind?: string }) => Promise<ApiResult<unknown[]>>;
    updateMaterial: (p: { id: number } & Record<string, unknown>) => Promise<ApiResult<unknown>>;
    deleteMaterial: (p: { id: number }) => Promise<ApiResult<boolean>>;
    attachMaterial: (p: { content_id: number; material_id: number }) => Promise<ApiResult<boolean>>;
    detachMaterial: (p: { content_id: number; material_id: number }) => Promise<ApiResult<boolean>>;
    schedule: (p: { content_version_id: number; planned_date: string; note?: string }) => Promise<ApiResult<unknown>>;
    listCalendar: (p?: { from?: string; to?: string; status?: string; content_id?: number }) => Promise<ApiResult<unknown[]>>;
    markPublished: (p: { id: number; publish_url?: string | null; note?: string }) => Promise<ApiResult<unknown>>;
    cancelSchedule: (p: { id: number }) => Promise<ApiResult<unknown>>;
    addMetric: (p: { calendar_id: number; date?: string; views?: number | null; likes?: number | null; comments?: number | null; custom?: Record<string, number>; note?: string }) => Promise<ApiResult<unknown>>;
    listMetrics: (p?: { calendar_id?: number; from?: string; to?: string }) => Promise<ApiResult<unknown[]>>;
    overview: () => Promise<ApiResult<unknown>>;
    stats: (p?: { from?: string; to?: string }) => Promise<ApiResult<unknown[]>>;
    pickExportDir: () => Promise<ApiResult<string | null>>;
    exportPackage: (p: { content_id: number; export_dir: string }) => Promise<ApiResult<unknown>>;
  };
  data: {
    queryObjects: (p: unknown) => Promise<ApiResult<QueryResult>>;
    aggregateObjects: (p: unknown) => Promise<ApiResult<AggregateResult>>;
    queryRelated: (p: unknown) => Promise<ApiResult<QueryResult>>;
    readObject: (p: unknown) => Promise<ApiResult<QueryRow | null>>;
    queryContract: (p: { apiName: string }) => Promise<ApiResult<ReturnType<QueryService['describe']>>>;
    previewAction: (p: { apiName: string; params?: Record<string, unknown> }) => Promise<ApiResult<ReturnType<ActionService['preview']>>>;
    listActionExecutions: (p?: Parameters<ActionRunService['list']>[0]) => Promise<ApiResult<ReturnType<ActionRunService['list']>>>;
    getOverview: () => Promise<ApiResult<unknown>>;
    listTypes: () => Promise<ApiResult<unknown>>;
    listObjects: (p: { apiName: string; search?: string; limit?: number; offset?: number }) => Promise<ApiResult<unknown>>;
    getObject: (p: { apiName: string; id: string | number }) => Promise<ApiResult<unknown>>;
    createLink: (p:{linkType:string;leftId:string|number;rightId:string|number;properties?:Record<string,unknown>})=>Promise<ApiResult<unknown>>;
    deleteLink: (p:{linkType:string;leftId:string|number;rightId:string|number})=>Promise<ApiResult<unknown>>;
    listLinks: (p: {apiName:string;id:string|number;linkType:string;side:'left'|'right';limit?:number;offset?:number}) => Promise<ApiResult<unknown>>;
    updateObject: (p: {apiName:string;id:string|number;values:Record<string,unknown>;options?:unknown}) => Promise<ApiResult<unknown>>;
    createObjectType: (p: unknown) => Promise<ApiResult<unknown>>;
    updateObjectType: (p: { apiName: string; patch: unknown }) => Promise<ApiResult<unknown>>;
    deleteObjectType: (p: { apiName: string }) => Promise<ApiResult<boolean>>;
    createLinkType: (p: unknown) => Promise<ApiResult<unknown>>;
    deleteLinkType: (p: { apiName: string }) => Promise<ApiResult<boolean>>;
    createActionType: (p: unknown) => Promise<ApiResult<unknown>>;
    updateActionType: (p: { apiName: string; patch: unknown }) => Promise<ApiResult<unknown>>;
    deleteActionType: (p: { apiName: string }) => Promise<ApiResult<boolean>>;
    invokeAction: (p: { apiName: string; params?: unknown; options?: unknown }) => Promise<ApiResult<unknown>>;
    backup: () => Promise<ApiResult<string>>;
    exportJson: () => Promise<ApiResult<string>>;
    healthCheck: () => Promise<ApiResult<unknown>>;
    vacuum: () => Promise<ApiResult<boolean>>;
    openDataDir: (p: { which: 'db' | 'tools' | 'backups' }) => Promise<ApiResult<string>>;
  };
}

declare global {
  interface Window {
    tododesk: TododeskApi;
  }
}

// 主进程返回 {ok, data, error}，这里拆开并把错误抛出
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function call<T>(fn: () => Promise<ApiResult<any>>): Promise<T> {
  const res = await fn();
  if (!res.ok) throw Object.assign(new Error(res.error ?? '未知错误'),{code:res.code});
  return res.data as T;
}

export const api = window.tododesk;
