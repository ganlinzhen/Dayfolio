// 渲染进程访问 preload API 的类型声明与封装
/// <reference types="vite/client" />

export interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

interface TododeskApi {
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
    delete: (p: { id: number }) => Promise<ApiResult<boolean>>;
  };
  checkins: {
    checkin: (p: unknown) => Promise<ApiResult<unknown>>;
    list: (p?: unknown) => Promise<ApiResult<unknown[]>>;
    stats: () => Promise<ApiResult<unknown>>;
  };
  today: {
    get: (p?: { date?: string }) => Promise<ApiResult<unknown>>;
  };
  study: {
    listDrafts: (p?: { status?: 'draft' | 'confirmed' | 'cancelled' }) => Promise<ApiResult<unknown[]>>;
    getDraft: (p: { id: number }) => Promise<ApiResult<unknown>>;
    confirmDraft: (p: { id: number; confirmed_over_dates?: string[] }) => Promise<ApiResult<unknown>>;
    cancelDraft: (p: { id: number }) => Promise<ApiResult<unknown>>;
    previewSchedule: (p: { id: number; start_date: string; daily_minutes: number }) => Promise<ApiResult<unknown>>;
    scheduleDraft: (p: { id: number; start_date: string; daily_minutes: number; confirmed_over_dates?: string[] }) => Promise<ApiResult<unknown>>;
    listSessions: (p?: { plan_id?: number; plan_item_id?: number; knowledge_key?: string; limit?: number }) => Promise<ApiResult<unknown[]>>;
    listAssessments: (p?: { plan_id?: number; knowledge_key?: string; session_id?: string }) => Promise<ApiResult<unknown[]>>;
    getMastery: (p?: { plan_id?: number; knowledge_keys?: string[] }) => Promise<ApiResult<unknown>>;
    suggestAdjustments: (p: { plan_id: number }) => Promise<ApiResult<unknown[]>>;
    applyAdjustments: (p: { plan_id: number; suggestions: Array<{ id: string; to_date: string }> }) => Promise<ApiResult<unknown>>;
    previewCards: (p?: { plan_id?: number; knowledge_keys?: string[]; session_ids?: string[] }) => Promise<ApiResult<unknown[]>>;
    exportCards: (p: { export_dir: string; plan_id?: number; knowledge_keys?: string[]; session_ids?: string[] }) => Promise<ApiResult<unknown>>;
    listCardExports: () => Promise<ApiResult<unknown[]>>;
    pickExportDir: () => Promise<ApiResult<string | null>>;
  };
  courses: {
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
  news: {
    list: (p?: { days?: number; task_id?: number; search?: string; filter?: 'all' | 'unread' | 'starred'; since?: string; limit?: number; offset?: number }) => Promise<ApiResult<unknown[]>>;
    tasks: (p?: { status?: string; limit?: number }) => Promise<ApiResult<unknown[]>>;
    createTask: (p: { title: string; instructions?: string; max_items?: number; window_hours?: number }) => Promise<ApiResult<unknown>>;
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
    getOverview: () => Promise<ApiResult<unknown>>;
    listTypes: () => Promise<ApiResult<unknown>>;
    listObjects: (p: { apiName: string; search?: string; limit?: number; offset?: number }) => Promise<ApiResult<unknown>>;
    getObject: (p: { apiName: string; id: string | number }) => Promise<ApiResult<unknown>>;
    createObjectType: (p: unknown) => Promise<ApiResult<unknown>>;
    updateObjectType: (p: { apiName: string; patch: unknown }) => Promise<ApiResult<unknown>>;
    deleteObjectType: (p: { apiName: string }) => Promise<ApiResult<boolean>>;
    createLinkType: (p: unknown) => Promise<ApiResult<unknown>>;
    deleteLinkType: (p: { apiName: string }) => Promise<ApiResult<boolean>>;
    createActionType: (p: unknown) => Promise<ApiResult<unknown>>;
    updateActionType: (p: { apiName: string; patch: unknown }) => Promise<ApiResult<unknown>>;
    deleteActionType: (p: { apiName: string }) => Promise<ApiResult<boolean>>;
    invokeAction: (p: { apiName: string; params?: unknown }) => Promise<ApiResult<unknown>>;
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
  if (!res.ok) throw new Error(res.error ?? '未知错误');
  return res.data as T;
}

export const api = window.tododesk;
