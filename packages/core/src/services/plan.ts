// 学习计划服务：创建计划（可自动生成待办）、进度、条目打卡联动
import type { DbAdapter } from '../db';
import { inTx, mapPlan, mapPlanItem } from '../db';
import type {
  NewPlanInput,
  PlanDetail,
  PlanItem,
  PlanStatus,
  StudyPlanWithProgress,
} from '../types';
import { ensureValidDateStr, nowIso } from '../utils/date';
import type { TodoService } from './todo';

const ITEM_TYPES = ['learn', 'review', 'practice', 'rest'];

export interface PlanServiceDeps {
  todos: TodoService;
  /** 条目完成时回调（用于联动打卡） */
  onItemCompleted?: (itemId: number, date: string) => void;
  onItemReverted?: (itemId: number, date: string) => void;
}

export function createPlanService(db: DbAdapter, deps: PlanServiceDeps) {
  const create = (input: NewPlanInput): PlanDetail => {
    if (!input.title?.trim()) throw new Error('计划标题不能为空');
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new Error('计划必须包含至少一个条目（items 不能为空）');
    }
    const start = ensureValidDateStr(input.start_date);
    if (input.daily_minutes !== undefined && input.daily_minutes !== null) {
      if (!Number.isInteger(input.daily_minutes) || input.daily_minutes < 10 || input.daily_minutes > 600) {
        throw new Error(`每日预算 minutes 必须为 10~600 的整数，收到 "${input.daily_minutes}"`);
      }
    }
    const items = input.items.map((it, idx) => ({
      date: ensureValidDateStr(it.date),
      content: it.content?.trim() || `第 ${idx + 1} 项`,
      item_type: it.item_type && ITEM_TYPES.includes(it.item_type) ? it.item_type : 'learn',
      duration_min: it.duration_min ?? null,
      knowledge_key: it.knowledge_key?.trim() || null,
      sort_order: idx,
    }));
    // 缺省结束日期取条目最大日期；并校验所有条目落在计划区间内
    const end = ensureValidDateStr(input.end_date ?? items.reduce((m, it) => (it.date > m ? it.date : m), items[0].date));
    const outOfRange = items.find((it) => it.date < start || it.date > end);
    if (outOfRange) {
      throw new Error(
        `条目「${outOfRange.content}」的日期 ${outOfRange.date} 不在计划区间 ${start} ~ ${end} 内，请调整条目日期或计划区间`,
      );
    }
    const createTodos = input.create_todos !== false;
    const now = nowIso();

    return inTx(db, () => {
      const planRes = db
        .prepare(
          `INSERT INTO study_plans (title, goal, start_date, end_date, status, notes, daily_minutes, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
        )
        .run(input.title.trim(), input.goal ?? '', start, end, input.notes ?? '', input.daily_minutes ?? null, now, now);
      const planId = Number(planRes.lastInsertRowid);
      // 按日期 + 原始顺序排序写入
      const sorted = items.map((it, i) => ({ ...it, sort_order: i })).sort((a, b) =>
        a.date === b.date ? a.sort_order - b.sort_order : a.date < b.date ? -1 : 1,
      );
      for (const it of sorted) {
        const itemRes = db
          .prepare(
            `INSERT INTO plan_items (plan_id, date, content, item_type, duration_min, status, todo_id, knowledge_key, sort_order, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, ?)`,
          )
          .run(planId, it.date, it.content, it.item_type, it.duration_min, it.knowledge_key, it.sort_order, now, now);
        if (createTodos) {
          const todo = deps.todos.add({
            title: it.content,
            notes: `来自学习计划「${input.title.trim()}」`,
            priority: 'medium',
            due_date: it.date,
            tags: ['学习计划', `plan:${planId}`],
            source: 'plan',
          });
          db.prepare('UPDATE plan_items SET todo_id = ? WHERE id = ?').run(todo.id, Number(itemRes.lastInsertRowid));
        }
      }
      return get(planId);
    });
  };

  const progressOf = (planId: number): { total_items: number; done_items: number; progress: number } => {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
         FROM plan_items WHERE plan_id = ?`,
      )
      .get(planId)!;
    const total = Number(row.total ?? 0);
    const done = Number(row.done ?? 0);
    return { total_items: total, done_items: done, progress: total === 0 ? 0 : Math.round((done / total) * 100) / 100 };
  };

  const list = (status?: PlanStatus): StudyPlanWithProgress[] => {
    const where = status ? 'WHERE status = ?' : '';
    const params = status ? [status] : [];
    const plans = db
      .prepare(`SELECT * FROM study_plans ${where} ORDER BY created_at DESC, id DESC`)
      .all(...params)
      .map(mapPlan);
    return plans.map((p) => ({ ...p, ...progressOf(p.id) }));
  };

  const get = (id: number): PlanDetail => {
    const row = db.prepare('SELECT * FROM study_plans WHERE id = ?').get(id);
    if (!row) throw new Error(`学习计划 ${id} 不存在`);
    const plan = mapPlan(row);
    const items = db
      .prepare('SELECT * FROM plan_items WHERE plan_id = ? ORDER BY date ASC, sort_order ASC, id ASC')
      .all(id)
      .map(mapPlanItem) as PlanItem[];
    return { ...plan, ...progressOf(id), items };
  };

  const getItem = (itemId: number): PlanItem => {
    const row = db.prepare('SELECT * FROM plan_items WHERE id = ?').get(itemId);
    if (!row) throw new Error(`计划条目 ${itemId} 不存在`);
    return mapPlanItem(row) as PlanItem;
  };

  /** 更新计划条目状态（打卡核心入口）：done 触发打卡并联动待办，撤销则清理 */
  const updateItemStatus = (itemId: number, status: 'pending' | 'done' | 'skipped'): PlanItem => {
    const item = getItem(itemId);
    const prev = item.status;
    if (status === prev) return item;
    db.prepare('UPDATE plan_items SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), itemId);

    if (status === 'done' && prev !== 'done') {
      deps.onItemCompleted?.(itemId, item.date);
      // 联动关联待办（不重复记打卡：todo 侧 recordCheckin=false）
      if (item.todo_id) deps.todos.complete(item.todo_id, false);
    } else if (prev === 'done' && status !== 'done') {
      deps.onItemReverted?.(itemId, item.date);
      if (item.todo_id) deps.todos.reopen(item.todo_id);
    }
    return getItem(itemId);
  };

  const update = (id: number, patch: { title?: string; goal?: string; notes?: string; status?: PlanStatus }): StudyPlanWithProgress => {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.title !== undefined) {
      if (!patch.title.trim()) throw new Error('计划标题不能为空');
      sets.push('title = ?');
      params.push(patch.title.trim());
    }
    if (patch.goal !== undefined) {
      sets.push('goal = ?');
      params.push(patch.goal);
    }
    if (patch.notes !== undefined) {
      sets.push('notes = ?');
      params.push(patch.notes);
    }
    if (patch.status !== undefined) {
      if (!['active', 'done', 'archived'].includes(patch.status)) {
        throw new Error(`无效计划状态 "${patch.status}"`);
      }
      sets.push('status = ?');
      params.push(patch.status);
    }
    if (sets.length > 0) {
      sets.push('updated_at = ?');
      params.push(nowIso(), id);
      const r = db.prepare(`UPDATE study_plans SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      if (r.changes === 0) throw new Error(`学习计划 ${id} 不存在`);
    }
    return { ...(() => {
      const row = db.prepare('SELECT * FROM study_plans WHERE id = ?').get(id);
      if (!row) throw new Error(`学习计划 ${id} 不存在`);
      return mapPlan(row);
    })(), ...progressOf(id) };
  };

  /** 删除计划：条目与其打卡记录一并删除；由计划生成的待办保留（仅解除关联） */
  const remove = (id: number): void => {
    inTx(db, () => {
      db.prepare(
        "DELETE FROM checkins WHERE ref_type = 'plan_item' AND ref_id IN (SELECT id FROM plan_items WHERE plan_id = ?)",
      ).run(id);
      db.prepare('UPDATE plan_items SET todo_id = NULL WHERE plan_id = ?').run(id);
      db.prepare('DELETE FROM plan_items WHERE plan_id = ?').run(id);
      const r = db.prepare('DELETE FROM study_plans WHERE id = ?').run(id);
      if (r.changes === 0) throw new Error(`学习计划 ${id} 不存在`);
    });
  };

  /** 某天的计划条目（跨所有进行中的计划），供今日概览使用 */
  const itemsOnDate = (date: string): Array<PlanItem & { plan_title: string }> =>
    db
      .prepare(
        `SELECT pi.*, sp.title AS plan_title FROM plan_items pi
         JOIN study_plans sp ON sp.id = pi.plan_id
         WHERE pi.date = ? AND sp.status = 'active'
         ORDER BY pi.date ASC, pi.sort_order ASC, pi.id ASC`,
      )
      .all(date)
      .map((r) => ({ ...mapPlanItem(r), plan_title: String(r.plan_title) }));

  return { create, list, get, getItem, update, updateItemStatus, remove, itemsOnDate };
}

export type PlanService = ReturnType<typeof createPlanService>;
