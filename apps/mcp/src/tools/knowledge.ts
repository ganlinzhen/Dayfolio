import type { ToolRegistrar, McpContext } from '../shared/context';
import { z } from 'zod';
import { wrap } from '../shared/response';

export function registerTools(server: ToolRegistrar, { core }: McpContext): void {
  // ---------- 知识库 vault（只读联动） ----------

  server.tool(
    'register_vault',
    '注册一个 Obsidian 知识库目录做只读索引（用户知情后使用；只写 Dayfolio 自己的索引库，绝不写 vault 文件、不触发 Git）。默认索引 knowledge/moc、knowledge/resources、knowledge/inbox-cards，不含 raw',
    {
      root_path: z.string().min(1).describe('vault 根目录绝对路径'),
      name: z.string().optional().describe('显示名，缺省取目录名'),
      include_dirs: z.array(z.string()).optional().describe('参与索引的子目录（相对路径）'),
      include_raw: z.boolean().optional().describe('是否索引 raw/ 原料区，默认 false'),
    },
    async ({ root_path, name, include_dirs, include_raw }) =>
      wrap(() => core.vaults.register({ root_path, name, include_dirs, include_raw }))(),
  );

  server.tool(
    'list_vaults',
    '列出已注册的知识库 vault（含扫描时间与统计）。什么场景调用我：想知道用户有哪些库、上次扫描是否过期',
    {},
    async () => wrap(() => ({ vaults: core.vaults.list() }))(),
  );

  server.tool(
    'scan_vault',
    '扫描（或增量刷新）一个 vault 的只读索引：新增/变更入索引，磁盘消失的笔记标 missing 但保留历史。什么场景调用我：注册后首次索引；用户说改了卡片/重命名后刷新',
    { vault_id: z.number().int().positive() },
    async ({ vault_id }) => wrap(() => core.vaults.scan(vault_id))(),
  );

  server.tool(
    'list_vault_notes',
    '浏览/筛选已索引的知识卡片（按 kind: moc/card/draft/raw、level: dao/fa/shu/qi、状态、关键词搜索）。什么场景调用我：先看库里有什么再引用',
    {
      vault_id: z.number().int().positive().optional().describe('不传则查全部库'),
      kind: z.enum(['moc', 'card', 'draft', 'raw', 'all']).optional(),
      level: z.enum(['dao', 'fa', 'shu', 'qi', 'all']).optional(),
      status: z.string().optional().describe('frontmatter 的 status（active/draft 等）'),
      search: z.string().optional().describe('标题/路径/正文关键词'),
      limit: z.number().int().positive().max(1000).optional().describe('默认 200'),
    },
    async (p) => wrap(() => ({ notes: core.vaults.listNotes(p) }))(),
  );

  server.tool(
    'search_vault_notes',
    '全文搜索知识库卡片（list_vault_notes 的搜索捷径）。什么场景调用我：用户问「我记过关于 X 的卡片吗」',
    {
      query: z.string().min(1).describe('关键词'),
      vault_id: z.number().int().positive().optional(),
      limit: z.number().int().positive().max(1000).optional().describe('默认 50'),
    },
    async ({ query, vault_id, limit }) =>
      wrap(() => ({ results: core.vaults.listNotes({ search: query, vault_id, limit: limit ?? 50 }) }))(),
  );

  server.tool(
    'get_vault_note',
    '读取一张知识卡片的完整内容（正文实时从磁盘读取；含 frontmatter、wikilink 解析、反链、已关联概念）。什么场景调用我：引用卡片内容回答问题、核对边界与反例',
    {
      vault_id: z.number().int().positive(),
      rel_path: z.string().min(1).describe('相对 vault 根的路径（可从 list/search 结果获取）'),
    },
    async ({ vault_id, rel_path }) =>
      wrap(() => {
        const d = core.vaults.getNote(vault_id, rel_path);
        // MCP 侧不传渲染 HTML，只给正文与链接（App 才有 iframe 渲染）
        return {
          note: d.note,
          markdown: d.markdown.slice(0, 20000),
          truncated: d.markdown.length > 20000,
          stale: d.stale,
          links: d.links,
          backlinks: d.backlinks,
          concept_links: d.concept_links,
        };
      })(),
  );

  server.tool(
    'link_concept_note',
    '把 Dayfolio 学习概念（knowledge_key，与学习计划/课程同一命名空间）手动关联到一张知识卡片。只写 Dayfolio 库，不改 vault 文件。什么场景调用我：用户说「这个知识点对应我那张卡」',
    {
      vault_id: z.number().int().positive(),
      rel_path: z.string().min(1),
      knowledge_key: z.string().min(1).describe('概念稳定标识，如 ts/generics'),
    },
    async ({ vault_id, rel_path, knowledge_key }) =>
      wrap(() => core.vaults.linkConcept({ vault_id, rel_path, knowledge_key }))(),
  );

  server.tool(
    'unlink_concept_note',
    '解除一条概念 ↔ 卡片关联（只动 Dayfolio 库）',
    { link_id: z.number().int().positive() },
    async ({ link_id }) =>
      wrap(() => {
        core.vaults.unlinkConcept(link_id);
        return true;
      })(),
  );

  server.tool(
    'list_concept_links',
    '查询概念 ↔ 卡片关联：按 knowledge_key 查卡片，或按卡片查概念。什么场景调用我：复习/课程想找已关联的知识卡',
    {
      knowledge_key: z.string().optional(),
      vault_id: z.number().int().positive().optional(),
      rel_path: z.string().optional().describe('与 vault_id 一起使用：按卡片查概念'),
    },
    async ({ knowledge_key, vault_id, rel_path }) =>
      wrap(() => {
        if (vault_id !== undefined && rel_path !== undefined) {
          const notes = core.vaults.listNotes({ vault_id });
          const note = notes.find((n) => n.rel_path === rel_path);
          if (!note) throw new Error(`卡片不在索引中：${rel_path}`);
          return { links: core.vaults.listConceptLinks({ note_id: note.id }) };
        }
        return { links: core.vaults.listConceptLinks({ knowledge_key }) };
      })(),
  );
}
