// 待办服务：增删改查、完成/重开、筛选排序
import type { DbAdapter } from '../db';
import { inTx, mapTodo } from '../db';
import type { NewTodoInput, Todo, TodoFilters, UpdateTodoInput, Priority } from '../types';
import { nowIso, todayStr } from '../utils/date';

const PRIORITIES: Priority[] = ['high', 'medium', 'low'];

export interface TodoServiceDeps {
  /** 完成待办时回调（用于联动打卡），recordCheckin=false 时跳过 */
  onCompleted?: (todoId: number, completedDate: string, recordCheckin: boolean) => void;
  onReopened?: (todoId: number) => void;
}

export function createTodoService(db: DbAdapter, deps: TodoServiceDeps = {}) {
  const add = (input: NewTodoInput): Todo => {
    if (!input.title || !input.title.trim()) throw new Error('待办标题不能为空');
    const priority = input.priority ?? 'medium';
    if (!PRIORITIES.includes(priority)) {
      throw new Error(`无效优先级 "${priority}"，应为 high / medium / low`);
    }
    const now = nowIso();
    const r = db
      .prepare(
        `INSERT INTO todos (title, notes, priority, status, due_date, tags, source, created_at, updated_at)
         VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
      )
      .run(
        input.title.trim(),
        input.notes ?? '',
        priority,
        input.due_date ?? null,
        JSON.stringify(input.tags ?? []),
        input.source ?? 'app',
        now,
        now,
      );
    return get(Number(r.lastInsertRowid));
  };

  const get = (id: number): Todo => {
    const row = db.prepare('SELECT * FROM todos WHERE id = ?').get(id);
    if (!row) throw new Error(`待办 ${id} 不存在`);
    return mapTodo(row);
  };

  const list = (filters: TodoFilters = {}): Todo[] => {
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    const status = filters.status ?? 'all';
    if (status !== 'all') {
      where.push('status = ?');
      params.push(status);
    }
    if (filters.priority) {
      where.push('priority = ?');
      params.push(filters.priority);
    }
    if (filters.overdue) {
      where.push("status = 'open' AND due_date IS NOT NULL AND due_date < ?");
      params.push(todayStr());
    }
    if (filters.search) {
      where.push('(title LIKE ? OR notes LIKE ?)');
      const q = `%${filters.search}%`;
      params.push(q, q);
    }
    if (filters.tag) {
      where.push('tags LIKE ?');
      params.push(`%"${filters.tag}"%`);
    }
    const limit = filters.limit && filters.limit > 0 ? filters.limit : 500;
    const sql = `
      SELECT * FROM todos WHERE ${where.join(' AND ')}
      ORDER BY
        CASE status WHEN 'open' THEN 0 ELSE 1 END,
        CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
        (due_date IS NULL), due_date ASC, id ASC
      LIMIT ${Math.floor(limit)}`;
    return db.prepare(sql).all(...params).map(mapTodo);
  };

  const setStatusDone = (id: number): void => {
    db.prepare("UPDATE todos SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?").run(
      nowIso(),
      nowIso(),
      id,
    );
  };

  const update = (id: number, patch: UpdateTodoInput): Todo => {
    const existing = get(id);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.title !== undefined) {
      if (!patch.title.trim()) throw new Error('待办标题不能为空');
      sets.push('title = ?');
      params.push(patch.title.trim());
    }
    if (patch.notes !== undefined) {
      sets.push('notes = ?');
      params.push(patch.notes ?? '');
    }
    if (patch.priority !== undefined) {
      if (!PRIORITIES.includes(patch.priority)) {
        throw new Error(`无效优先级 "${patch.priority}"，应为 high / medium / low`);
      }
      sets.push('priority = ?');
      params.push(patch.priority);
    }
    if (patch.due_date !== undefined) {
      sets.push('due_date = ?');
      params.push(patch.due_date ?? null);
    }
    if (patch.tags !== undefined) {
      sets.push('tags = ?');
      params.push(JSON.stringify(patch.tags));
    }
    if (patch.status !== undefined && patch.status !== existing.status) {
      sets.push('status = ?');
      params.push(patch.status);
      if (patch.status === 'done') {
        sets.push('completed_at = ?');
        params.push(nowIso());
      } else {
        sets.push('completed_at = NULL');
      }
    }
    if (sets.length === 0) return existing;
    sets.push('updated_at = ?');
    params.push(nowIso());
    params.push(id);
    db.prepare(`UPDATE todos SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    // 完成状态变化联动打卡
    if (patch.status === 'done' && existing.status !== 'done') {
      deps.onCompleted?.(id, todayStr(), true);
    } else if (patch.status === 'open' && existing.status === 'done') {
      deps.onReopened?.(id);
    }
    return get(id);
  };

  /** 完成待办；recordCheckin=false 时只改状态不记打卡（供计划条目联动使用，避免重复打卡） */
  const complete = (id: number, recordCheckin = true): Todo => {
    const existing = get(id);
    if (existing.status === 'done') return existing;
    setStatusDone(id);
    deps.onCompleted?.(id, todayStr(), recordCheckin);
    return get(id);
  };

  const reopen = (id: number): Todo => update(id, { status: 'open' });

  const remove = (id: number): void => {
    inTx(db, () => {
      db.prepare("DELETE FROM checkins WHERE ref_type = 'todo' AND ref_id = ?").run(id);
      db.prepare('UPDATE plan_items SET todo_id = NULL WHERE todo_id = ?').run(id);
      const r = db.prepare('DELETE FROM todos WHERE id = ?').run(id);
      if (r.changes === 0) throw new Error(`待办 ${id} 不存在`);
    });
  };

  return { add, get, list, update, complete, reopen, remove };
}

export type TodoService = ReturnType<typeof createTodoService>;
