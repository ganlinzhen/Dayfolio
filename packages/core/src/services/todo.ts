// 待办业务的唯一写入口；订阅与 App/MCP 共用事务、时间和用户接管检测。
import { inTx, readSnapshot, mapTodo, TODO_SOURCE_SELECT, type DbAdapter } from '../db';
import type { NewTodoInput, Todo, TodoFilters, UpdateTodoInput, Priority } from '../types';
import { nowIso } from '../utils/date';
import { resolveSchedule, displayTimezone, dateInZone, timestampInZone, runtimeError } from '../utils/schedule';

const PRIORITIES: Priority[] = ['high', 'medium', 'low'];
const managedKeys = ['title', 'due_date', 'end_date', 'start_time', 'end_time', 'time_mode', 'scheduled_start_at', 'scheduled_end_at'] as const;
export interface TodoServiceDeps {
  onCompleted?: (todoId: number, completedDate: string, recordCheckin: boolean) => void;
  onReopened?: (todoId: number) => void;
  onManagedEdited?: (todoId: number) => void;
  onBeforeRemoved?: (todoId: number) => void;
  isManagedWrite?: () => boolean;
}
export function createTodoService(db: DbAdapter, deps: TodoServiceDeps = {}) {
  const get = (id: number): Todo => readSnapshot(db, () => {
    const row = db.prepare(TODO_SOURCE_SELECT + ' WHERE t.id=?').get(id);
    if (!row) throw new Error(`待办 ${id} 不存在`);
    return mapTodo(row, displayTimezone(db));
  });
  const collection = (id: string | null) => {
    if (id && !db.prepare('SELECT 1 FROM calendar_collections WHERE id=? AND archived=0').get(id)) runtimeError('CONTRACT_INVALID', '日历分类不存在或已归档');
  };
  const add = (input: NewTodoInput): Todo => inTx(db, () => {
    const title = input.title?.trim(); if (!title) throw new Error('待办标题不能为空');
    const priority = input.priority ?? 'medium'; if (!PRIORITIES.includes(priority)) throw new Error(`无效优先级 "${priority}"`);
    const schedule = resolveSchedule(input, displayTimezone(db)); collection(input.collection_id ?? null);
    const now = nowIso();
    const values = { title, notes: input.notes ?? '', priority, status: 'open', ...schedule, collection_id: input.collection_id ?? null, tags: JSON.stringify(input.tags ?? []), source: input.source ?? 'app', created_at: now, updated_at: now };
    const keys = Object.keys(values);
    const result = db.prepare(`INSERT INTO todos (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(values));
    return get(Number(result.lastInsertRowid));
  });
  const list = (filters: TodoFilters = {}): Todo[] => readSnapshot(db, () => {
    const where = ['1=1']; const params: unknown[] = [];
    if (filters.status && filters.status !== 'all') { where.push('status=?'); params.push(filters.status); }
    if (filters.priority) { where.push('priority=?'); params.push(filters.priority); }
    if (filters.search) { where.push('(title LIKE ? OR notes LIKE ?)'); params.push(`%${filters.search}%`, `%${filters.search}%`); }
    if (filters.tag) { where.push('tags LIKE ?'); params.push(`%"${filters.tag}"%`); }
    const zone = displayTimezone(db);
    // 先按权威时间判断再分页，避免 SQL 与行映射使用不同的时区/截止规则。
    const count = filters.limit && Number.isFinite(filters.limit) && filters.limit > 0 ? Math.floor(filters.limit) : 500;
    const rows = db.prepare(`${TODO_SOURCE_SELECT} WHERE ${where.join(' AND ')} ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END,CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,(due_date IS NULL),due_date,start_time,id${filters.overdue ? '' : ' LIMIT ?'}`).all(...params, ...(filters.overdue ? [] : [count])).map(row => mapTodo(row, zone));
    return rows.filter(row => !filters.overdue || row.is_overdue).slice(0, count);
  });
  const apply = (id: number, patch: UpdateTodoInput, recordCheckin = true): Todo => inTx(db, () => {
    const current = get(id);
    if (patch.expected_revision !== undefined && (!Number.isSafeInteger(patch.expected_revision) || patch.expected_revision !== current.revision)) runtimeError('REVISION_CONFLICT', '待办已被修改，请重新读取');
    const schedule = resolveSchedule(patch, displayTimezone(db), current);
    const values: Record<string, unknown> = { ...schedule };
    if (patch.title !== undefined) { if (!patch.title.trim()) throw new Error('待办标题不能为空'); values.title = patch.title.trim(); }
    if (patch.notes !== undefined) values.notes = patch.notes ?? '';
    if (patch.priority !== undefined) { if (!PRIORITIES.includes(patch.priority)) throw new Error('无效优先级'); values.priority = patch.priority; }
    if (patch.tags !== undefined) values.tags = JSON.stringify(patch.tags);
    if (patch.collection_id !== undefined) {
      collection(patch.collection_id);
      if (patch.collection_id !== current.collection_id && !deps.isManagedWrite?.() && db.prepare("SELECT 1 FROM event_subscriptions WHERE todo_id=? AND status='active'").get(id)) runtimeError('WRITE_REQUIRES_ACTION', '订阅分类请通过取消订阅调整');
      values.collection_id = patch.collection_id;
    }
    if (patch.status !== undefined && patch.status !== current.status) {
      if (!['open', 'done'].includes(patch.status)) runtimeError('CONTRACT_INVALID', '未知待办状态');
      values.status = patch.status; values.completed_at = patch.status === 'done' ? timestampInZone(new Date(), displayTimezone(db)) : null;
    }
    const changed = Object.entries(values).filter(([key, v]) => v !== (key === 'tags' ? JSON.stringify(current.tags) : current[key as keyof Todo]));
    if (!changed.length) return current;
    const edited = managedKeys.some(key => changed.some(([k]) => k === key));
    changed.push(['updated_at', nowIso()]);
    db.prepare(`UPDATE todos SET ${changed.map(([key]) => key + '=?').join(',')} WHERE id=?`).run(...changed.map(([, v]) => v), id);
    if (edited && !deps.isManagedWrite?.()) deps.onManagedEdited?.(id);
    if (patch.status === 'done' && current.status !== 'done') deps.onCompleted?.(id, dateInZone(new Date(), displayTimezone(db)), recordCheckin);
    if (patch.status === 'open' && current.status === 'done') deps.onReopened?.(id);
    return get(id);
  });
  const update = (id: number, patch: UpdateTodoInput): Todo => apply(id, patch);
  const complete = (id: number, recordCheckin = true): Todo => apply(id, { status: 'done' }, recordCheckin);
  const reopen = (id: number): Todo => apply(id, { status: 'open' });
  const remove = (id: number): void => inTx(db, () => {
    get(id); deps.onBeforeRemoved?.(id);
    db.prepare("DELETE FROM checkins WHERE ref_type='todo' AND ref_id=?").run(id);
    db.prepare('UPDATE plan_items SET todo_id=NULL WHERE todo_id=?').run(id);
    db.prepare('DELETE FROM todos WHERE id=?').run(id);
  });
  return { add, get, list, update, complete, reopen, remove };
}
export type TodoService = ReturnType<typeof createTodoService>;
