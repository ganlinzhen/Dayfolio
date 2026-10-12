// 工具箱服务：分类管理（新增/改名/排序/删除）+ 工具条目 CRUD
// 文件内容不进库：HTML 及配套资源由桌面端主进程存放在 userData/tools/<id>/ 下，
// 这里只记录入口文件名（entry_file），渲染层通过 tool-file:// 协议加载。
import type { DbAdapter } from '../db';
import { inTx, mapTool, mapToolCategory } from '../db';
import type { NewToolInput, ToolCategory, ToolItem, UpdateToolInput } from '../types';
import { nowIso } from '../utils/date';

export function createToolService(db: DbAdapter) {
  // ---------- 分类 ----------

  const listCategories = (): ToolCategory[] =>
    db
      .prepare('SELECT * FROM tool_categories ORDER BY sort_order, id')
      .all()
      .map(mapToolCategory);

  const addCategory = (input: { name: string }): ToolCategory => {
    const name = input.name.trim();
    if (!name) throw new Error('分类名不能为空');
    if (name.length > 24) throw new Error('分类名最长 24 个字符');
    const dup = db.prepare('SELECT id FROM tool_categories WHERE name = ?').get(name);
    if (dup) throw new Error('已存在同名分类');
    const now = nowIso();
    const max = db.prepare('SELECT MAX(sort_order) AS m FROM tool_categories').get();
    const order = Number(max?.m ?? 0) + 1;
    const r = db
      .prepare('INSERT INTO tool_categories (name, sort_order, created_at) VALUES (?, ?, ?)')
      .run(name, order, now);
    return { id: Number(r.lastInsertRowid), name, sort_order: order, created_at: now };
  };

  const renameCategory = (id: number, name: string): void => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('分类名不能为空');
    if (trimmed.length > 24) throw new Error('分类名最长 24 个字符');
    const dup = db.prepare('SELECT id FROM tool_categories WHERE name = ? AND id != ?').get(trimmed, id);
    if (dup) throw new Error('已存在同名分类');
    const r = db.prepare('UPDATE tool_categories SET name = ? WHERE id = ?').run(trimmed, id);
    if (r.changes === 0) throw new Error('分类不存在');
  };

  /** 删除分类：其下工具自动变为未分类（ON DELETE SET NULL） */
  const deleteCategory = (id: number): void => {
    db.prepare('DELETE FROM tool_categories WHERE id = ?').run(id);
  };

  /** 按传入 id 顺序重排分类（渲染层上移/下移后整表提交） */
  const reorderCategories = (ids: number[]): void => {
    inTx(db, () => {
      const stmt = db.prepare('UPDATE tool_categories SET sort_order = ? WHERE id = ?');
      ids.forEach((id, i) => stmt.run(i + 1, id));
    });
  };

  // ---------- 工具 ----------

  const listTools = (): ToolItem[] =>
    db
      .prepare('SELECT * FROM tools ORDER BY sort_order, id')
      .all()
      .map(mapTool);

  const getTool = (id: number): ToolItem => {
    const row = db.prepare('SELECT * FROM tools WHERE id = ?').get(id);
    if (!row) throw new Error('工具不存在');
    return mapTool(row);
  };

  /** 新增工具：先入库拿到 id，主进程再把上传的文件写到 tools/<id>/ 目录 */
  const addTool = (input: NewToolInput): ToolItem => {
    const title = input.title.trim();
    if (!title) throw new Error('工具名不能为空');
    if (title.length > 40) throw new Error('工具名最长 40 个字符');
    const entry = input.entry_file.trim();
    if (!entry) throw new Error('缺少 HTML 入口文件');
    if (input.category_id != null) {
      const cat = db.prepare('SELECT id FROM tool_categories WHERE id = ?').get(input.category_id);
      if (!cat) throw new Error('分类不存在');
    }
    const now = nowIso();
    const max = db.prepare('SELECT MAX(sort_order) AS m FROM tools').get();
    const order = Number(max?.m ?? 0) + 1;
    const r = db
      .prepare(
        'INSERT INTO tools (title, icon, category_id, entry_file, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(title, input.icon?.trim() || 'tool', input.category_id ?? null, entry, order, now, now);
    return getTool(Number(r.lastInsertRowid));
  };

  const updateTool = (id: number, patch: UpdateToolInput): ToolItem => {
    const cur = getTool(id);
    if (patch.category_id != null) {
      const cat = db.prepare('SELECT id FROM tool_categories WHERE id = ?').get(patch.category_id);
      if (!cat) throw new Error('分类不存在');
    }
    db.prepare('UPDATE tools SET title = ?, icon = ?, category_id = ?, entry_file = ?, updated_at = ? WHERE id = ?').run(
      (patch.title ?? cur.title).trim() || cur.title,
      patch.icon?.trim() || cur.icon,
      patch.category_id === undefined ? cur.category_id : patch.category_id,
      patch.entry_file?.trim() || cur.entry_file,
      nowIso(),
      id,
    );
    return getTool(id);
  };

  const deleteTool = (id: number): void => {
    db.prepare('DELETE FROM tools WHERE id = ?').run(id);
  };

  return {
    listCategories,
    addCategory,
    renameCategory,
    deleteCategory,
    reorderCategories,
    listTools,
    getTool,
    addTool,
    updateTool,
    deleteTool,
  };
}

export type ToolService = ReturnType<typeof createToolService>;
