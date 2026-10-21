// HTML 工具只提交待办草稿；稳定来源键与待办在同一事务中保存。
import Ajv from 'ajv';
import { inTx, readSnapshot, type DbAdapter } from '../db';
import type { NewTodoInput, Priority } from '../types';
import type { TodoService } from './todo';
import type { ToolService } from './tool';
import { displayTimezone, resolveSchedule, runtimeError } from '../utils/schedule';

export const TOOL_TODO_LIMIT = 100;
export interface ToolTodoDraft {
  /** 在同一个工具中唯一；内容更新和改期时保持不变。 */
  sourceKey: string;
  title: string;
  notes?: string;
  priority?: Priority;
  tags?: string[];
  startAt?: string | null;
  endAt?: string | null;
  dueDate?: string | null;
  sourceUrl?: string;
}
export interface ToolTodoCategoryInput {
  /** 分类身份按工具隔离；改名时仍使用原键。 */
  key: string;
  title: string;
  color?: string;
}
export interface ToolTodoBatch { toolId: number; items: ToolTodoDraft[]; category?: ToolTodoCategoryInput }
export interface ToolTodoCategory {
  id: string; key: string; title: string; color: string; exists: boolean; visible: boolean;
}
export interface ToolTodoStatusInput { toolId: number; sourceKeys: string[] }
export interface ToolTodoStatus {
  sourceKey: string;
  todoId: number | null;
  status: 'missing' | 'open' | 'done' | 'deleted';
}

const text = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
const nullableText = { anyOf: [text(64), { type: 'null' }] };
const ajv = new Ajv({ strict: false });
const validateCategory = ajv.compile({
  type: 'object', additionalProperties: false, required: ['key', 'title'],
  properties: {
    key: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$' },
    title: text(80), color: { enum: ['blue', 'green', 'violet', 'amber', 'rose', 'slate'] },
  },
});
const validateDraft = ajv.compile({
  type: 'object', additionalProperties: false, required: ['sourceKey', 'title'],
  properties: {
    sourceKey: text(240), title: text(300), notes: { type: 'string', maxLength: 10000 },
    priority: { enum: ['high', 'medium', 'low'] },
    tags: { type: 'array', maxItems: 20, items: text(80) },
    startAt: nullableText, endAt: nullableText, dueDate: nullableText,
    sourceUrl: { type: 'string', maxLength: 2048 },
  },
});
const checkKeys = (keys: string[]) => {
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > TOOL_TODO_LIMIT || keys.some(k => typeof k !== 'string' || !k.trim() || k.length > 240)) {
    runtimeError('CONTRACT_INVALID', `来源键须为 1—${TOOL_TODO_LIMIT} 个非空文本`);
  }
  if (new Set(keys).size !== keys.length) runtimeError('CONTRACT_INVALID', '同一批待办不能包含重复来源键');
};

export function createToolTodoService(db: DbAdapter, deps: { tools: ToolService; todos: () => TodoService }) {
  const toolFor = (id: number) => {
    if (!Number.isSafeInteger(id) || id <= 0) runtimeError('CONTRACT_INVALID', '工具 ID 无效');
    return deps.tools.getTool(id);
  };
  const statusFor = (toolId: number, sourceKey: string): ToolTodoStatus => {
    const row = db.prepare('SELECT l.todo_id,t.status FROM tool_todo_links l LEFT JOIN todos t ON t.id=l.todo_id WHERE l.tool_id=? AND l.source_key=?').get(toolId, sourceKey);
    return { sourceKey, todoId: row?.todo_id == null ? null : Number(row.todo_id), status: !row ? 'missing' : row.todo_id == null ? 'deleted' : row.status === 'done' ? 'done' : 'open' };
  };
  const getStatus = (input: ToolTodoStatusInput): ToolTodoStatus[] => readSnapshot(db, () => {
    toolFor(input?.toolId); checkKeys(input.sourceKeys);
    return input.sourceKeys.map(key => statusFor(input.toolId, key));
  });
  const categoryFor = (toolId: number, toolTitle: string, input?: ToolTodoCategoryInput): ToolTodoCategory => {
    const category = input === undefined ? { key: 'default', title: toolTitle, color: 'blue' } : input;
    if (!validateCategory(category) || !category.title.trim()) runtimeError('CONTRACT_INVALID', '分类须包含稳定键、非空名称和有效颜色，不能指定宿主分类 ID');
    const id = `tool:${toolId}:${category.key}`;
    const existing = db.prepare('SELECT c.*,p.visible FROM calendar_collections c LEFT JOIN calendar_collection_preferences p ON p.collection_id=c.id WHERE c.id=?').get(id);
    if (existing?.archived) runtimeError('CONTRACT_INVALID', '待办分类已归档，请使用其他分类键');
    return { id, key: category.key, title: existing ? String(existing.title) : category.title.trim(), color: existing ? String(existing.color) : category.color ?? 'blue', exists: Boolean(existing), visible: existing ? Boolean(existing.visible) : true };
  };
  const ensureCategory = (category: ToolTodoCategory) => {
    if (!category.exists) {
      db.prepare('INSERT INTO calendar_collections(id,title,color,sort_order) VALUES(?,?,?,(SELECT COALESCE(MAX(sort_order),0)+1 FROM calendar_collections))').run(category.id, category.title, category.color);
      db.prepare('INSERT INTO calendar_collection_preferences(collection_id,visible,updated_at) VALUES(?,1,?)').run(category.id, new Date().toISOString());
    }
  };
  const normalize = (draft: ToolTodoDraft): ToolTodoDraft => {
    if (!validateDraft(draft) || !draft.title.trim() || !draft.sourceKey.trim()) runtimeError('CONTRACT_INVALID', '待办草稿字段无效，或包含未开放字段');
    if (draft.startAt && draft.dueDate) runtimeError('CONTRACT_INVALID', '固定时刻与日期不能混用');
    if (draft.endAt && !draft.startAt) runtimeError('CONTRACT_INVALID', '结束时刻需要开始时刻');
    if (draft.sourceUrl) {
      let url: URL;
      try { url = new URL(draft.sourceUrl); } catch { return runtimeError('CONTRACT_INVALID', '来源链接无效'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) runtimeError('CONTRACT_INVALID', '来源链接只接受无凭证的 HTTP(S) 地址');
    }
    const schedule = resolveSchedule(draft.startAt ? { time_mode: 'instant', scheduled_start_at: draft.startAt, scheduled_end_at: draft.endAt ?? null } : { due_date: draft.dueDate ?? null }, displayTimezone(db));
    return {
      sourceKey: draft.sourceKey, title: draft.title.trim(), notes: draft.notes ?? '', priority: draft.priority ?? 'medium', tags: draft.tags ?? [],
      startAt: schedule.scheduled_start_at, endAt: schedule.scheduled_end_at, dueDate: draft.startAt ? null : schedule.due_date,
      sourceUrl: draft.sourceUrl ?? '',
    };
  };
  const preview = (input: ToolTodoBatch) => readSnapshot(db, () => {
    const tool = toolFor(input?.toolId);
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > TOOL_TODO_LIMIT) runtimeError('CONTRACT_INVALID', `每批待办须为 1—${TOOL_TODO_LIMIT} 条`);
    const items = input.items.map(normalize);
    checkKeys(items.map(item => item.sourceKey));
    return { toolId: tool.id, toolTitle: tool.title, timezone: displayTimezone(db), category: categoryFor(tool.id, tool.title, input.category), items: items.map(item => ({ ...item, ...statusFor(tool.id, item.sourceKey) })) };
  });
  const create = (input: ToolTodoBatch) => inTx(db, () => {
    const batch = preview(input);
    let created = 0, reused = 0, deleted = 0;
    // 只有实际创建新待办时才落分类；整个事务失败会一并回滚分类与显示偏好。
    const needsCategory = batch.items.some(item => item.status === 'missing');
    if (needsCategory) ensureCategory(batch.category);
    const items = batch.items.map(item => {
      if (item.status !== 'missing') {
        if (item.status === 'deleted') deleted++; else reused++;
        return statusFor(batch.toolId, item.sourceKey);
      }
      const schedule: NewTodoInput = item.startAt
        ? { title: item.title, time_mode: 'instant', scheduled_start_at: item.startAt, scheduled_end_at: item.endAt }
        : { title: item.title, due_date: item.dueDate };
      const todo = deps.todos().add({ ...schedule, priority: item.priority, tags: item.tags,
        notes: [item.notes, `来自工具：${batch.toolTitle}`, item.sourceUrl].filter(Boolean).join('\n'), source: `tool:${batch.toolId}`, collection_id: batch.category.id,
      });
      db.prepare('INSERT INTO tool_todo_links(tool_id,source_key,todo_id,created_at) VALUES(?,?,?,?)').run(batch.toolId, item.sourceKey, todo.id, new Date().toISOString());
      created++;
      return statusFor(batch.toolId, item.sourceKey);
    });
    return { created, reused, deleted, items, category: needsCategory || batch.category.exists ? { ...batch.category, exists: true } : null };
  });
  return { preview, getStatus, create };
}
export type ToolTodoService = ReturnType<typeof createToolTodoService>;
