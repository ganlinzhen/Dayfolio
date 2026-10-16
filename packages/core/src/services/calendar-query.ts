// 日历是业务事实的只读投影；先确定唯一归属，再做分类过滤和分页。
import { readSnapshot, type DbAdapter } from '../db';
import type { CalendarItem, CalendarQuery, CalendarResult } from '../runtime-types';
import { addDays, ensureValidDateStr } from '../utils/date';
import { dateInZone, displayTimezone, ensureTimezone, runtimeError } from '../utils/schedule';
import { zonedInstant } from '../utils/zoned-time';
import { makePage, pageOffset } from './event-model';
import type { RuntimeService } from './runtime';

type Row = Record<string, unknown>;
type Time = Pick<CalendarItem, 'timeKind' | 'startAt' | 'endAt' | 'startDate' | 'endDateExclusive'>;

function timeOf(row: Row, zone: string, fallbackDate?: string): Time | null {
  if (row.time_mode === 'instant') return { timeKind: 'timed', startAt: String(row.scheduled_start_at), endAt: row.scheduled_end_at == null ? null : String(row.scheduled_end_at), startDate: null, endDateExclusive: null };
  const date = row.due_date == null ? fallbackDate : String(row.due_date);
  if (!date) return null;
  if (!row.start_time) return { timeKind: 'all_day', startAt: null, endAt: null, startDate: date, endDateExclusive: addDays(String(row.end_date ?? date), 1) };
  return { timeKind: 'timed', startAt: zonedInstant(date, String(row.start_time), zone), endAt: row.end_time == null ? null : zonedInstant(String(row.end_date ?? date), String(row.end_time), zone), startDate: null, endDateExclusive: null };
}

function localTimeOf(event: Row, zone: string): Time | null {
  // 旧本地日程允许“结束日期 + 仅开始钟点”；没有完整结束时刻时保留原日期条。
  // 开始钟点仍留在业务记录与编辑详情，不猜测最后一天的结束钟点。
  if (event.end_date && String(event.end_date) > String(event.date) && !event.end_time) {
    return { timeKind: 'all_day', startAt: null, endAt: null, startDate: String(event.date), endDateExclusive: addDays(String(event.end_date), 1) };
  }
  return timeOf({ ...event, due_date: event.date }, zone);
}

export function calendarItemDays(item: CalendarItem, zone: string): { first: string; last: string } {
  return item.timeKind === 'all_day'
    ? { first: item.startDate, last: addDays(item.endDateExclusive, -1) }
    : { first: dateInZone(item.startAt, zone), last: dateInZone(item.endAt ? new Date(Date.parse(item.endAt) - 1) : item.startAt, zone) };
}

export function createCalendarQueryService(db: DbAdapter, runtime: RuntimeService) {
  const queryItems = (input: CalendarQuery): CalendarResult => readSnapshot(db, () => {
    ensureValidDateStr(input.fromDate); ensureValidDateStr(input.toDateExclusive); ensureTimezone(input.displayTimezone);
    const rangeDays = (Date.parse(input.toDateExclusive) - Date.parse(input.fromDate)) / 86400000;
    if (rangeDays <= 0 || rangeDays > 100) return runtimeError('RANGE_TOO_LARGE', '日期区间须非空且不超过 100 天');
    const zone = displayTimezone(db);
    if (input.displayTimezone !== zone) return runtimeError('REVISION_CONFLICT', '显示时区已变化，请重新读取设置');
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) return runtimeError('CONTRACT_INVALID', '分页范围为 1—500');
    const collections = runtime.listCollections();
    const known = new Set(collections.map(c => c.id));
    if (input.collectionIds !== undefined && (!Array.isArray(input.collectionIds) || input.collectionIds.some(id => typeof id !== 'string' || !known.has(id)))) return runtimeError('CONTRACT_INVALID', '日历分类未知或不合法');
    const selected = [...new Set(input.collectionIds ?? collections.filter(c => c.visible).map(c => c.id))].sort();
    const page = pageOffset(db, {}, { kind: 'calendar', fromDate: input.fromDate, toDateExclusive: input.toDateExclusive, zone, collectionIds: selected }, input.cursor);
    const visible = new Set(selected);
    const todos = db.prepare('SELECT * FROM todos WHERE due_date < ? AND COALESCE(end_date,due_date) >= ? ORDER BY id').all(input.toDateExclusive, input.fromDate);
    const subscriptions = new Map<number, Row>(db.prepare("SELECT s.todo_id,s.event_id,e.status AS source_status,p.collection_id FROM event_subscriptions s JOIN external_events e ON e.id=s.event_id JOIN event_providers p ON p.id=e.provider_id WHERE s.status='active' AND s.todo_id IS NOT NULL").all().map(s => [Number(s.todo_id), s]));
    const plans = db.prepare(`SELECT p.* FROM plan_items p LEFT JOIN todos t ON t.id=p.todo_id
      WHERE (p.date>=? AND p.date<?) OR (t.due_date<? AND COALESCE(t.end_date,t.due_date)>=?) ORDER BY p.id`).all(input.fromDate, input.toDateExclusive, input.toDateExclusive, input.fromDate);
    const bindings = new Map<number, Row[]>();
    for (const plan of plans) if (plan.todo_id != null) bindings.set(Number(plan.todo_id), [...(bindings.get(Number(plan.todo_id)) ?? []), plan]);
    const disabled=new Set(db.prepare("SELECT api_name FROM ont_action_types WHERE status='disabled'").all().map(row=>String(row.api_name)));
    const items: CalendarItem[] = [];
    const consumedPlans = new Set<number>();
    const push = (base: Omit<CalendarItem, keyof Time>, time: Time | null) => {
      if (!time || !visible.has(base.collectionId)) return;
      // 联合类型的跨字段不变量由 timeOf 集中构造。
      const commandFor=(action:CalendarItem['allowedActions'][number])=>action==='open'?[]:action==='unsubscribe'?['unsubscribe_event','update_todo']:base.kind==='plan_item'?['update_plan_item',action==='complete'?'complete_todo':'reopen_todo']:base.kind==='calendar_event'?[action==='edit'?'update_calendar_event':'delete_calendar_event']:[action==='edit'?'update_todo':action==='delete'?'delete_todo':action==='complete'?'complete_todo':'reopen_todo'];
      const item = { ...base, allowedActions:base.allowedActions.filter(action=>commandFor(action).every(command=>!disabled.has(command))), ...time } as CalendarItem;
      const days = calendarItemDays(item, zone);
      if (days.first < input.toDateExclusive && days.last >= input.fromDate) items.push(item);
    };
    for (const todo of todos) {
      const id = Number(todo.id), sub = subscriptions.get(id), linked = bindings.get(id) ?? [];
      if (linked.length > 1 || (sub && linked.length)) return runtimeError('REFERENCE_CONFLICT', `待办 ${id} 存在冲突关联，请先检查订阅和学习条目`);
      const plan = linked[0];
      if (plan) consumedPlans.add(Number(plan.id));
      const kind = sub ? 'external_subscription' : plan ? 'plan_item' : 'todo';
      const done = todo.status === 'done';
      const collectionId = String(sub?.collection_id ?? (plan ? 'builtin.study' : todo.collection_id ?? 'builtin.todo'));
      push({ id: plan ? `plan_item:${plan.id}` : `todo:${id}`, collectionId, title: String(todo.title), kind,
        status: plan ? plan.status as 'pending' | 'done' | 'skipped' : done ? 'done' : 'open', sourceStatus: sub ? sub.source_status as CalendarItem['sourceStatus'] : null,
        target: { objectType: plan ? 'plan_item' : 'todo', id: plan ? Number(plan.id) : id },
        allowedActions: plan ? ['open', done ? 'reopen' : 'complete'] : ['open', done ? 'reopen' : 'complete', 'edit', 'delete', ...(sub ? ['unsubscribe' as const] : [])],
      }, timeOf(todo, zone));
    }
    for (const plan of plans) {
      if (consumedPlans.has(Number(plan.id))) continue;
      if (plan.todo_id != null) {
        const linked = db.prepare('SELECT * FROM todos WHERE id=?').get(plan.todo_id);
        if (linked?.due_date) continue; // 关联待办被安排到区间外，不能从计划日期重复出现。
        if (subscriptions.has(Number(plan.todo_id))) return runtimeError('REFERENCE_CONFLICT', `学习条目 ${plan.id} 的待办同时关联订阅`);
      }
      push({ id: `plan_item:${plan.id}`, collectionId: 'builtin.study', title: String(plan.content), kind: 'plan_item', status: plan.status as CalendarItem['status'], sourceStatus: null,
        target: { objectType: 'plan_item', id: Number(plan.id) }, allowedActions: ['open', plan.status === 'done' ? 'reopen' : 'complete'],
      }, timeOf({}, zone, String(plan.date)));
    }
    const locals = db.prepare('SELECT * FROM calendar_events WHERE date<? AND COALESCE(end_date,date)>=? ORDER BY id').all(input.toDateExclusive, input.fromDate);
    for (const event of locals) push({ id: `calendar_event:${event.id}`, collectionId: String(event.collection_id ?? 'builtin.local'), title: String(event.title), kind: 'calendar_event', status: 'scheduled', sourceStatus: null,
      target: { objectType: 'calendar_event', id: Number(event.id) }, allowedActions: ['open', 'edit', 'delete'],
    }, localTimeOf(event, zone));
    items.sort((a, b) => (a.startDate ?? a.startAt!).localeCompare(b.startDate ?? b.startAt!) || a.id.localeCompare(b.id));
    const countsByDay: Record<string, number> = {};
    for (let day = input.fromDate; day < input.toDateExclusive; day = addDays(day, 1)) countsByDay[day] = 0;
    for (const item of items) {
      const { first, last } = calendarItemDays(item, zone);
      for (let day = first < input.fromDate ? input.fromDate : first; day <= last && day < input.toDateExclusive; day = addDays(day, 1)) countsByDay[day]++;
    }
    const paged=makePage(items.slice(page.offset,page.offset+limit+1),page.offset,limit,page.revision,page.fingerprint);
    const localColors=new Map(locals.map(row=>[`calendar_event:${row.id}`,String(row.color)]));
    const itemColors=Object.fromEntries(paged.items.filter(item=>localColors.has(item.id)).map(item=>[item.id,localColors.get(item.id)!]));
    return {...paged,collections,countsByDay,itemColors};
  });
  return { queryItems };
}
export type CalendarQueryService = ReturnType<typeof createCalendarQueryService>;
