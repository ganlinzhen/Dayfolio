import type { ToolRegistrar, McpContext } from '../shared/context';
import { z } from 'zod';
import { collectToolFilesFromPaths, listToolFiles, pickEntryFile, sanitizeToolPath } from '../../../../packages/core/src/index';
import { wrap } from '../shared/response';
import { registerToolFollowingTools } from './tool-following';

export function registerTools(server: ToolRegistrar, { core, toolFilesRoot }: McpContext): void {
  registerToolFollowingTools(server,core);
  // ---------- 工具箱 ----------
  const draftSchema = z.object({
    sourceKey: z.string().min(1).max(240).describe('本工具内稳定且唯一的来源键，改期时不变'),
    title: z.string().min(1).max(300),
    notes: z.string().max(10000).optional(),
    priority: z.enum(['high', 'medium', 'low']).optional(),
    tags: z.array(z.string().min(1).max(80)).max(20).optional(),
    startAt: z.string().nullable().optional().describe('带 Z 或时区偏移的开始时刻；未知时省略'),
    endAt: z.string().nullable().optional().describe('已知的结束时刻；不得猜测时长'),
    dueDate: z.string().nullable().optional().describe('仅日期事项使用 YYYY-MM-DD；不与 startAt 混用'),
    sourceUrl: z.string().max(2048).optional(),
  }).strict();
  const batchSchema = {
    toolId: z.number().int().positive(), items: z.array(draftSchema).min(1).max(100),
    category: z.object({ key: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/), title: z.string().min(1).max(80), color: z.enum(['blue','green','violet','amber','rose','slate']).optional() }).strict().optional().describe('待办分类声明，键在工具内稳定唯一；缺省按工具名归类，确认创建新待办时才创建或复用'),
  };
  server.tool('preview_tool_todos', '预览某个 HTML 工具要添加的待办，核对标题、排期、重复状态及待办分类；只读，不创建待办或分类。先用 list_tools 确定 toolId。', batchSchema,
    async input => wrap(() => core.toolTodos.preview(input))());
  server.tool('add_tool_todos', '用户要求把 HTML 工具中的比赛或其他事项加入待办时调用。每批最多 100 条；按 toolId 与 sourceKey 去重，保留已有修改与完成状态，删除后不自动复活。实际创建新待办时在同一事务创建或复用分类，缺省按工具名归类；仅保存本次快照，不持续关注来源。', batchSchema,
    async input => wrap(() => core.toolTodos.create(input))());
  server.tool('get_tool_todo_status', '查看某个 HTML 工具指定来源键的待办关联状态；只返回 ID 与状态，不返回个人备注或其他工具数据。', {
    toolId: z.number().int().positive(), sourceKeys: z.array(z.string().min(1).max(240)).min(1).max(100),
  }, async input => wrap(() => core.toolTodos.getStatus(input))());

  /** category_name → id：分类不存在时自动创建（agent 一句话完成「放进某分类」）；传 null 表示未分类 */
  function resolveCategoryId(name?: string | null): number | null {
    if (name == null || !name.trim()) return null;
    const trimmed = name.trim();
    const found = core.tools.listCategories().find((c) => c.name === trimmed);
    return found ? found.id : core.tools.addCategory({ name: trimmed }).id;
  }

  /** file_paths / files 双通道归一为 base64 文件集合（二选一） */
  function gatherToolFiles(filePaths?: string[], files?: Array<{ name: string; content_base64: string }>): Array<{ name: string; contentBase64: string }> {
    if (filePaths?.length && files?.length) throw new Error('file_paths 与 files 只能二选一');
    if (filePaths?.length) return collectToolFilesFromPaths(filePaths);
    if (files?.length) return files.map((f) => ({ name: f.name, contentBase64: f.content_base64 }));
    return [];
  }

  server.tool(
    'list_tools',
    '查看工具箱：全部小工具（标题/图标/分类/入口文件/文件清单）与分类列表。用户想了解 App 里装了哪些工具、或 add/update/delete_tool 需要拿 id 时调用',
    {},
    wrap(() => {
      const cats = core.tools.listCategories();
      const catName = new Map(cats.map((c) => [c.id, c.name]));
      const tools = core.tools.listTools().map((t) => ({
        id: t.id,
        title: t.title,
        icon: t.icon,
        category_id: t.category_id,
        category_name: t.category_id != null ? catName.get(t.category_id) ?? null : null,
        entry_file: t.entry_file,
        files: listToolFiles(toolFilesRoot, t.id),
      }));
      return { count: tools.length, categories: cats, tools };
    }),
  );

  server.tool(
    'add_tool',
    '把一个 HTML 小工具装入 App 工具箱——用户说「把这个 html/文件加到工具箱」「帮我做个小工具放进去」时调用。文件来源二选一：file_paths（本地文件或目录路径，目录递归收集，适合已有文件）或 files（base64 内容，适合你现场生成的 HTML，无需落盘）。entry_file 缺省取 index.html；category_name 不存在会自动创建分类',
    {
      title: z.string().min(1).describe('工具名，如「色板转换器」'),
      icon: z.string().optional().describe('图标名，默认 tool'),
      category_name: z.string().nullable().optional().describe('分类名，不存在自动创建；缺省未分类，传 null 强制未分类'),
      file_paths: z.array(z.string().min(1)).optional().describe('本地文件/目录路径列表（工具 HTML 及 css/js/图片等配套资源）'),
      files: z
        .array(z.object({ name: z.string().min(1), content_base64: z.string().min(1) }))
        .optional()
        .describe('文件内容列表，name 可含子目录（如 assets/app.js）'),
      entry_file: z.string().optional().describe('HTML 入口相对路径，缺省 index.html 或唯一 html 文件'),
    },
    async ({ title, icon, category_name, file_paths, files, entry_file }) =>
      wrap(() => {
        const list = gatherToolFiles(file_paths, files);
        if (list.length === 0) throw new Error('未提供任何文件：需要 file_paths 或 files 之一');
        const names = list.map((f) => sanitizeToolPath(f.name));
        const entry = entry_file ? sanitizeToolPath(entry_file) : pickEntryFile(names);
        if (!names.includes(entry)) throw new Error(`entry_file "${entry}" 不在文件列表中`);
        const tool = core.tools.addTool({ title, icon, category_id: resolveCategoryId(category_name), entry_file: entry, files:list });
        return { tool, files: listToolFiles(toolFilesRoot, tool.id) };
      })(),
  );

  server.tool(
    'update_tool',
    '修改工具箱里的工具：改名/图标/分类/入口文件，或整体替换文件（file_paths / files 二选一，语义同 add_tool；不传文件则不动现有文件）',
    {
      id: z.number().int().positive(),
      title: z.string().min(1).optional(),
      icon: z.string().optional(),
      category_name: z.string().nullable().optional().describe('分类名（不存在自动创建）；传 null 移到未分类'),
      entry_file: z.string().optional(),
      file_paths: z.array(z.string().min(1)).optional(),
      files: z.array(z.object({ name: z.string().min(1), content_base64: z.string().min(1) })).optional(),
    },
    async ({ id, title, icon, category_name, entry_file, file_paths, files }) =>
      wrap(() => {
        const patch: Record<string, unknown> = {};
        if (title !== undefined) patch.title = title;
        if (icon !== undefined) patch.icon = icon;
        if (category_name !== undefined) patch.category_id = resolveCategoryId(category_name);
        if (entry_file !== undefined) patch.entry_file = sanitizeToolPath(entry_file);
        const list = gatherToolFiles(file_paths, files);
        if (list.length > 0) {
          const names = list.map((f) => sanitizeToolPath(f.name));
          const entry = entry_file ? sanitizeToolPath(entry_file) : pickEntryFile(names);
          if (!names.includes(entry)) throw new Error(`entry_file "${entry}" 不在文件列表中`);
          patch.entry_file = entry;
        }
        if(list.length>0)patch.files=list;
        const tool = core.tools.updateTool(id, patch as never);
        return { tool, files: listToolFiles(toolFilesRoot, id) };
      })(),
  );

  server.tool(
    'delete_tool',
    '从工具箱删除一个工具及全部文件，停止持续关注但保留个人待办。不可恢复，请先与用户确认',
    { id: z.number().int().positive() },
    async ({ id }) =>
      wrap(() => {
        core.tools.deleteTool(id);

        return { deleted: id };
      })(),
  );

  server.tool(
    'list_tool_categories',
    '查看工具箱全部分类（含每个分类下的工具数与工具名）',
    {},
    wrap(() => {
      const tools = core.tools.listTools();
      const categories = core.tools.listCategories().map((c) => ({
        ...c,
        tool_count: tools.filter((t) => t.category_id === c.id).length,
        tool_titles: tools.filter((t) => t.category_id === c.id).map((t) => t.title),
      }));
      return { count: categories.length, uncategorized: tools.filter((t) => t.category_id == null).length, categories };
    }),
  );

  server.tool(
    'add_tool_category',
    '新建一个工具箱分类',
    { name: z.string().min(1).describe('分类名（最长 24 字）') },
    async ({ name }) => wrap(() => core.tools.addCategory({ name }))(),
  );

  server.tool(
    'rename_tool_category',
    '重命名工具箱分类（其下工具不变）',
    {
      id: z.number().int().positive(),
      name: z.string().min(1),
    },
    async ({ id, name }) =>
      wrap(() => {
        core.tools.renameCategory(id, name);
        return true;
      })(),
  );

  server.tool(
    'delete_tool_category',
    '删除工具箱分类（其下工具自动变为未分类，工具本身保留）',
    { id: z.number().int().positive() },
    async ({ id }) =>
      wrap(() => {
        core.tools.deleteCategory(id);
        return true;
      })(),
  );
}
