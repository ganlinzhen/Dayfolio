// 与 P0 冻结合同一致的事件输入；命令输入由这些共享类型生成。
export type Json = null | string | number | boolean | Json[] | { [key: string]: Json };
export type SourceStatus = 'scheduled' | 'postponed' | 'cancelled' | 'finished';
export type EventTime =
  | { timeKind: 'timed'; startAt: string; endAt: string | null; startDate: null; endDateExclusive: null }
  | { timeKind: 'all_day'; startAt: null; endAt: null; startDate: string; endDateExclusive: string }
  | { timeKind: 'tbd'; startAt: null; endAt: null; startDate: null; endDateExclusive: null };
export type ExternalEventInput = EventTime & { externalId: string; title: string; status: SourceStatus; sourceUrl: string; sourceTimezone?: string | null; payload: { [key: string]: Json } };
export interface EventSubscription {
  id: string; eventId: string; todoId: number | null; status: 'active' | 'unsubscribed'; syncMode: 'follow' | 'manual';
  appliedEventRevision: number; pendingEventRevision: number | null;
}
export type ExternalEventRecord = ExternalEventInput & { id: string; providerId: string; revision: number; updatedAt: string; subscription: EventSubscription | null };
export interface EventImportInput { providerId: string; batchId: string; expectedProviderRevision: number; events: ExternalEventInput[] }
export interface EventImportResult { batchId: string; revision: number; created: number; updated: number; unchanged: number }
export interface EventListInput { providerId: string; fromDate?: string; toDateExclusive?: string; status?: SourceStatus; cursor?: string; limit?: number }
export interface SubscriptionInput { eventId: string }
export interface UnsubscribeInput extends SubscriptionInput { todoPolicy: 'keep' | 'delete_open'; expectedTodoRevision?: number }
export interface ResumeFollowingInput extends SubscriptionInput { expectedEventRevision: number; expectedTodoRevision: number }
export interface SubscriptionListInput { providerId: string; cursor?: string; limit?: number }
export interface RuntimeActor { extensionId?: string }


export type CalendarItem = Exclude<EventTime,{timeKind:'tbd'}> & {
  id:string; collectionId:string;title:string;
  kind:'todo'|'plan_item'|'calendar_event'|'external_subscription';
  status:'open'|'done'|'pending'|'skipped'|'scheduled';sourceStatus:SourceStatus|null;
  target:{objectType:'todo'|'plan_item'|'calendar_event';id:string|number};
  allowedActions:('open'|'complete'|'reopen'|'edit'|'delete'|'unsubscribe')[];
};
export interface CalendarQuery {fromDate:string;toDateExclusive:string;displayTimezone:string;collectionIds?:string[];cursor?:string;limit?:number}
export interface CalendarCollection {id:string;title:string;color:string;sortOrder:number;archived:boolean;ownerExtensionId:string|null;extensionStatus:'active'|'disabled'|'uninstalled'|null;visible:boolean;deleteBlockedReason:string|null}
export interface CalendarResult {revision:number;items:CalendarItem[];nextCursor:string|null;truncated:boolean;collections:CalendarCollection[];countsByDay:Record<string,number>;itemColors?:Record<string,string>}
