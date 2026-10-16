// 事件订阅与待办是一个事务；来源同步与用户修改共享唯一待办业务入口。
import { randomUUID } from 'node:crypto';
import { inTx, readSnapshot, type DbAdapter } from '../db';
import type { Todo, NewTodoInput } from '../types';
import type { RuntimeActor, SubscriptionInput, UnsubscribeInput, ResumeFollowingInput, SubscriptionListInput } from '../runtime-types';
import type { TodoService } from './todo';
import { addDays } from '../utils/date';
import { runtimeError } from '../utils/schedule';
import { canonical, eventRow, providerFor, subscriptionRow, pageOffset, makePage, positiveRevision } from './event-model';

export function managedSnapshot(todo: Todo): string {
  return canonical(todo.time_mode === 'instant' ? { title: todo.title, time_mode: todo.time_mode, scheduled_start_at: todo.scheduled_start_at, scheduled_end_at: todo.scheduled_end_at } : { title: todo.title, time_mode: todo.time_mode, due_date: todo.due_date, end_date: todo.end_date, start_time: todo.start_time, end_time: todo.end_time });
}
export function createSubscriptionService(db: DbAdapter, deps: { todos: () => TodoService; managedWrite: <T>(fn: () => T) => T }, actor: RuntimeActor = {}) {
  const loadEvent = (id: string, write = false) => {
    const row = db.prepare('SELECT * FROM external_events WHERE id=?').get(id);
    if (!row) return runtimeError('EVENT_NOT_FOUND', '事件不存在');
    const provider = providerFor(db, String(row.provider_id), actor, write ? 'subscriptions.write' : 'events.read', write);
    return { event: eventRow(db, row), provider };
  };
  // 写命令只使用自身权限读取必要状态；公开查询仍单独要求 events.read。
  const getFor = (input: SubscriptionInput, write: boolean) => readSnapshot(db, () => {
    loadEvent(input.eventId, write); const row = db.prepare('SELECT * FROM event_subscriptions WHERE event_id=?').get(input.eventId);
    return { subscription: row ? subscriptionRow(db, row) : null, todo: row?.todo_id ? deps.todos().get(Number(row.todo_id)) : null };
  });
  const get = (input: SubscriptionInput) => getFor(input, false);
  const sourcePatch = (id: string): NewTodoInput => {
    const { event, provider } = loadEvent(id, true);
    if (event.status === 'cancelled' || event.timeKind === 'tbd') return { title: event.title, time_mode: 'floating', due_date: null, collection_id: String(provider.collection_id) };
    if (event.timeKind === 'timed') return { title: event.title, time_mode: 'instant', scheduled_start_at: event.startAt, scheduled_end_at: event.endAt, collection_id: String(provider.collection_id) };
    return { title: event.title, time_mode: 'floating', scheduled_start_at: null, scheduled_end_at: null, due_date: event.startDate, end_date: addDays(event.endDateExclusive, -1) === event.startDate ? null : addDays(event.endDateExclusive, -1), start_time: null, end_time: null, collection_id: String(provider.collection_id) };
  };
  const applySource = (id: string, todo: Todo) => {
    const { event } = loadEvent(id, true);
    const patch = sourcePatch(id); const next = deps.managedWrite(() => deps.todos().update(todo.id, patch));
    db.prepare('UPDATE event_subscriptions SET sync_mode=\'follow\',applied_event_revision=?,last_applied_json=?,updated_at=? WHERE event_id=?').run(event.revision, managedSnapshot(next), new Date().toISOString(), id);
    return next;
  };
  const syncEvent = (id: string): void => {
    const row = db.prepare("SELECT * FROM event_subscriptions WHERE event_id=? AND status='active'").get(id);
    if (!row?.todo_id || row.sync_mode !== 'follow') return;
    const todo = deps.todos().get(Number(row.todo_id)); if (todo.status === 'done') return;
    applySource(id, todo);
  };
  const subscribe = (input: SubscriptionInput) => inTx(db, () => {
    const { event, provider } = loadEvent(input.eventId, true); const old = db.prepare('SELECT * FROM event_subscriptions WHERE event_id=?').get(event.id);
    if (old?.status === 'active' && old.todo_id) return { ...getFor(input, true), effect: 'reused' as const, collectionVisible: visible(String(provider.collection_id)) };
    if (event.status === 'cancelled') return runtimeError('EVENT_CANCELLED', '已取消的事件不能新增订阅');
    const now = new Date().toISOString(); let todo: Todo;
    if (old?.todo_id) {
      todo = deps.todos().get(Number(old.todo_id));
      if (db.prepare('SELECT 1 FROM plan_items WHERE todo_id=?').get(todo.id)) runtimeError('REFERENCE_CONFLICT', '待办已关联学习条目');
      const mode = managedSnapshot(todo) === old.last_applied_json ? 'follow' : 'manual';
      db.prepare("UPDATE event_subscriptions SET status='active',sync_mode=?,updated_at=? WHERE event_id=?").run(mode, now, event.id);
      todo = deps.managedWrite(() => deps.todos().update(todo.id, { collection_id: String(provider.collection_id) }));
      if (mode === 'follow' && todo.status === 'open') todo = applySource(event.id, todo);
    } else {
      const patch = sourcePatch(event.id);
      todo = deps.managedWrite(() => deps.todos().add({ ...patch, title: event.title }));
      if (old) db.prepare("UPDATE event_subscriptions SET todo_id=?,status='active',sync_mode='follow',applied_event_revision=?,last_applied_json=?,updated_at=? WHERE event_id=?").run(todo.id, event.revision, managedSnapshot(todo), now, event.id);
      else db.prepare('INSERT INTO event_subscriptions VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(), event.id, todo.id, 'active', 'follow', event.revision, managedSnapshot(todo), now, now);
    }
    db.prepare('INSERT OR IGNORE INTO calendar_collection_preferences VALUES(?,?,?)').run(provider.collection_id, 1, now);
    return { ...getFor(input, true), effect: old ? 'reactivated' as const : 'created' as const, collectionVisible: visible(String(provider.collection_id)) };
  });
  function visible(id: string): boolean { const p = db.prepare('SELECT visible FROM calendar_collection_preferences WHERE collection_id=?').get(id); return p ? Boolean(p.visible) : id.startsWith('builtin.'); }
  const unsubscribe = (input: UnsubscribeInput) => inTx(db, () => {
    // 受信宿主仍可处理停用/卸载后的历史订阅；工具调用继续校验当前授权。
    loadEvent(input.eventId, Boolean(actor.extensionId));
    if (!['keep', 'delete_open'].includes(input.todoPolicy)) runtimeError('CONTRACT_INVALID', '取消订阅须明确待办处理方式');
    const current = getFor(input, Boolean(actor.extensionId)); if (!current.subscription || current.subscription.status === 'unsubscribed') return current;
    const todo = current.todo;
    if (input.expectedTodoRevision !== undefined) { positiveRevision(input.expectedTodoRevision); if (todo?.revision !== input.expectedTodoRevision) runtimeError('REVISION_CONFLICT', '待办已变更'); }
    if (input.todoPolicy === 'delete_open' && todo?.status === 'done') runtimeError('COMPLETED_TODO_PROTECTED', '不能随取消订阅删除已完成记录');
    db.prepare("UPDATE event_subscriptions SET status='unsubscribed',updated_at=? WHERE event_id=?").run(new Date().toISOString(), input.eventId);
    if (todo) { if (input.todoPolicy === 'delete_open') deps.todos().remove(todo.id); else deps.managedWrite(() => deps.todos().update(todo.id, { collection_id: 'builtin.todo' })); }
    return getFor(input, Boolean(actor.extensionId));
  });
  const resumeFollowing = (input: ResumeFollowingInput) => inTx(db, () => {
    const { event } = loadEvent(input.eventId, true); const current = getFor(input, true); positiveRevision(input.expectedEventRevision); positiveRevision(input.expectedTodoRevision);
    if (event.revision !== input.expectedEventRevision || current.todo?.revision !== input.expectedTodoRevision) runtimeError('REVISION_CONFLICT', '来源或待办已变化，请重新预览');
    if (current.subscription?.status !== 'active' || !current.todo) return runtimeError('SUBSCRIPTION_INACTIVE', '请先订阅该事件');
    if (current.todo.status === 'done') return { ...current, protectedCompleted: true };
    applySource(event.id, current.todo); return { ...getFor(input, true), protectedCompleted: false };
  });
  const list = (input: SubscriptionListInput) => readSnapshot(db, () => {
    providerFor(db, input.providerId, actor, 'events.read'); const limit = input.limit ?? 100; if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) runtimeError('CONTRACT_INVALID', '分页范围为 1—500');
    const page = pageOffset(db, actor, { providerId: input.providerId, kind: 'subscriptions' }, input.cursor);
    const rows = db.prepare('SELECT s.* FROM event_subscriptions s JOIN external_events e ON e.id=s.event_id WHERE e.provider_id=? ORDER BY s.id LIMIT ? OFFSET ?').all(input.providerId, limit + 1, page.offset);
    return makePage(rows.map(row => subscriptionRow(db, row)), page.offset, limit, page.revision, page.fingerprint);
  });
  return { service: { subscribe, get, list, unsubscribe, resumeFollowing }, syncEvent };
}
export type SubscriptionService = ReturnType<typeof createSubscriptionService>['service'];


/** 工具范围只返回冻结的待办摘要，个人备注、标签、完成时间不离开宿主。 */
export function scopeSubscriptionService(service: SubscriptionService) {
  const summarize = <T extends { todo: Todo | null }>(result: T): Omit<T, 'todo'> & { todo: Pick<Todo, 'id' | 'title' | 'status' | 'revision'> | null } => {
    const { todo, ...rest } = result; return { ...rest, todo: todo ? { id: todo.id, title: todo.title, status: todo.status, revision: todo.revision } : null };
  };
  return {
...service,
    get: (input: SubscriptionInput) => summarize(service.get(input)),
    subscribe: (input: SubscriptionInput) => summarize(service.subscribe(input)),
    unsubscribe: (input: UnsubscribeInput) => summarize(service.unsubscribe(input)),
    resumeFollowing: (input: ResumeFollowingInput) => summarize(service.resumeFollowing(input)),
  };
}
