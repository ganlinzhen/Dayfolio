/** P0 冻结的 v1 类型合同；只描述目标接口，不表示应用已有这些实现。 */
export type Json = null | string | number | boolean | Json[] | { [key: string]: Json };
export type EntityRef = { objectType: 'todo' | 'plan_item' | 'calendar_event'; id: string | number };
export type SourceStatus = 'scheduled' | 'postponed' | 'cancelled' | 'finished';
export type Timed = { timeKind: 'timed'; startAt: string; endAt: string | null; startDate: null; endDateExclusive: null };
export type AllDay = { timeKind: 'all_day'; startAt: null; endAt: null; startDate: string; endDateExclusive: string };
export type PendingTime = { timeKind: 'tbd'; startAt: null; endAt: null; startDate: null; endDateExclusive: null };
export type EventInput = (Timed | AllDay | PendingTime) & {
  externalId: string; title: string; status: SourceStatus; sourceUrl: string;
  sourceTimezone?: string | null; payload: { [key: string]: Json };
};
export type EventRecord = EventInput & { id: string; providerId: string; revision: number; updatedAt: string; subscription: Subscription | null };
export interface Subscription {
  id: string; eventId: string; todoId: number | null;
  status: 'active' | 'unsubscribed'; syncMode: 'follow' | 'manual';
  appliedEventRevision: number; pendingEventRevision: number | null;
}
export interface TodoSummary { id: number; title: string; status: 'open' | 'done'; revision: number }
export interface Page<T> { revision: number; items: T[]; nextCursor: string | null; truncated: boolean }
export interface ErrorInfo { code: string; message: string; retryable: boolean; details?: Json }
export type Response<T> = { ok: true; requestId: string; data: T } | { ok: false; requestId: string; error: ErrorInfo };
export interface RuntimeDescription {
  api: { major: 1; minor: number }; extensionId: string; releaseDigest: string;
  grantedCapabilities: { name: string; providerId: string }[];
  limits: { packageBytes: number; eventBatchCount: number; eventBatchBytes: number; pageSize: number; maxRangeDays: number; requestBytes: number };
}
export interface SubscribeResult { effect: 'created' | 'reused' | 'reactivated'; subscription: Subscription; todo: TodoSummary; collectionVisible: boolean }
export interface SyncRun { id: string; providerId: string; status: 'queued' | 'fetching' | 'validating' | 'committing' | 'succeeded' | 'failed' | 'cancelled'; error: ErrorInfo | null }
export interface RuntimeMethodMap {
  'runtime.describe': { input: Record<string, never>; output: RuntimeDescription };
  'events.list': { input: { providerId: string; fromDate?: string; toDateExclusive?: string; status?: SourceStatus; cursor?: string; limit?: number }; output: Page<EventRecord> };
  'events.import': { input: { providerId: string; batchId: string; expectedProviderRevision: number; events: EventInput[] }; output: { batchId: string; revision: number; created: number; updated: number; unchanged: number } };
  'providers.refresh': { input: { providerId: string }; output: { effect: 'queued' | 'reused'; run: SyncRun } };
  'providers.getStatus': { input: { providerId: string }; output: { revision: number; lastSuccessAt: string | null; activeRun: SyncRun | null; lastError: ErrorInfo | null } };
  'subscriptions.subscribe': { input: { eventId: string }; output: SubscribeResult };
  'subscriptions.unsubscribe': { input: { eventId: string; todoPolicy: 'keep' | 'delete_open'; expectedTodoRevision?: number }; output: { subscription: Subscription; todo: TodoSummary | null } };
  'subscriptions.resumeFollowing': { input: { eventId: string; expectedEventRevision: number; expectedTodoRevision: number }; output: { subscription: Subscription; todo: TodoSummary; protectedCompleted: boolean } };
  'subscriptions.get': { input: { eventId: string }; output: { subscription: Subscription | null; todo: TodoSummary | null } };
  'navigation.openTodo': { input: { eventId: string }; output: { opened: boolean; target: EntityRef } };
}
export type Request<M extends keyof RuntimeMethodMap = keyof RuntimeMethodMap> = {
  apiMajor: 1; requestId: string; method: M; params: RuntimeMethodMap[M]['input'];
};
export interface RuntimeSDK {
  ready: Promise<void>;
  call<M extends keyof RuntimeMethodMap>(method: M, input: RuntimeMethodMap[M]['input']): Promise<RuntimeMethodMap[M]['output']>;
  onChanged(listener: (event: { revision: number; providerIds: string[]; reason: string }) => void): () => void;
}
export type CalendarItem = (Timed | AllDay) & {
  id: string; collectionId: string; title: string;
  kind: 'todo' | 'plan_item' | 'calendar_event' | 'external_subscription';
  status: 'open' | 'done' | 'pending' | 'skipped' | 'scheduled'; sourceStatus: SourceStatus | null;
  target: EntityRef; allowedActions: ('open' | 'complete' | 'reopen' | 'edit' | 'delete' | 'unsubscribe')[];
};
export interface CalendarQuery {
  fromDate: string; toDateExclusive: string; displayTimezone: string;
  collectionIds?: string[]; cursor?: string; limit?: number;
}
export interface CalendarResult extends Page<CalendarItem> {
  collections: { id: string; title: string; visible: boolean; archived: boolean }[];
  countsByDay: Record<string, number>;
}
export interface ExtensionInstallInput { stagingDirectory: string; expectedExtensionRevision: number | null; expectedPackageDigest: string; authorizationRef: string }
export interface ExtensionInstallResult { extensionId: string; version: string; digest: string; effect: 'installed' | 'updated' | 'unchanged' | 'repaired'; revision: number }
