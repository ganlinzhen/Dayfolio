// MCP Server 端到端测试：通过 stdio 真实拉起子进程，走完整 MCP 协议
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { addDays, todayStr } from '../../../packages/core/src/utils/date';
const SERVER = new URL('../dist/mcp-server.cjs', import.meta.url).pathname;

let client: Client;
let transport: StdioClientTransport;
let dbDir: string;

function arg(result: unknown): any {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  const text = r.content?.[0]?.text;
  if (!text) throw new Error('MCP 返回无内容');
  return JSON.parse(text);
}

/** 模拟用户在 App 内「阅读并确认样课」：MCP 不暴露确认工具（agent 不得代用户确认），
 *  e2e 直接写临时库标记，语义与 App IPC confirmSample 一致（样课置已读 + 绑定当前内容哈希） */
const confirmSampleAsApp = (courseId: number) => {
  const id = Number(courseId);
  const db = new DatabaseSync(join(dbDir, 'e2e.db'));
  try {
    db.exec(`UPDATE course_lessons SET status = 'read' WHERE course_id = ${id} AND is_sample = 1`);
    db.exec(`UPDATE courses SET status = 'sample_confirmed',
      sample_content_hash = (SELECT content_hash FROM course_lessons WHERE course_id = ${id} AND is_sample = 1),
      sample_confirmed_at = '2026-10-10T00:00:00.000Z',
      updated_at = '2026-10-10T00:00:00.000Z' WHERE id = ${id}`);
  } finally {
    db.close();
  }
};

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'tododesk-mcp-e2e-'));
  // MCP 子进程显式临时三件套（隔离红线：不携带真实家目录；库与 userData 都显式指向同一临时根 dbDir）
  const childHome = join(dbDir, 'home');
  const childUserData = join(dbDir, 'user-data');
  mkdirSync(childHome, { recursive: true });
  mkdirSync(childUserData, { recursive: true });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: childHome,
      TODODESK_DB: join(dbDir, 'e2e.db'),
      TODODESK_USER_DATA: childUserData,
      // 未注册 vault 的硬拒绝回归：该目录从未 register_vault，导出仍必须被拒
      TODODESK_PROTECTED_DIRS: join(dbDir, 'protected-vault'),
    },
  });
  client = new Client({ name: 'e2e-test-client', version: '1.0.0' });
  await client.connect(transport);
}, 30000);

afterAll(async () => {
  await client.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe('MCP 端到端主流程', () => {
  it('服务版本来自根版本，能力目录与实际公开工具一致', async () => {
    const { version } = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
    expect(client.getServerVersion()).toMatchObject({ name: 'tododesk', version });
    const catalog = JSON.parse(readFileSync(new URL('../dist/agent-catalog.json', import.meta.url), 'utf8'));
    const actual = (await client.listTools()).tools.map(t => ({ name: t.name, desc: t.description })).sort((a, b) => a.name.localeCompare(b.name));
    const published = catalog.tools.map((t: { name: string; desc: string }) => ({ name: t.name, desc: t.desc })).sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
    expect(actual).toEqual(published);
    expect(catalog.version).toBe(version);
    expect(catalog.skills.map((s: { id: string }) => s.id)).toEqual(['tododesk', 'tododesk-teach', 'tododesk-sports']);
  });

  it('阅读组合、幂等重放、修订冲突与只读执行记录通过真实 MCP 链路', async () => {
    const call = async (name: string, args: Record<string, unknown>) => arg(await client.callTool({ name, arguments: args }));
    await call('create_object_type', { api_name: 'e2e_reading', title: '阅读组合夹具', properties: [{ api_name: 'title', data_type: 'string', nullable: false }, { api_name: 'status', data_type: 'enum', enum_values: ['done', 'pending'], nullable: false }] });
    await call('update_object_type', { api_name: 'todo', patch: { add_properties: [{ api_name: 'e2e_reading_ref', data_type: 'string' }] } });
    await call('create_link_type', { api_name: 'e2e_reading_todos', title: '阅读复习', left_type: 'e2e_reading', right_type: 'todo', cardinality: 'one_to_many', fk_column: 'e2e_reading_ref' });
    const defined = await call('create_action_type', { api_name: 'e2e_finish_reading', title: '完成阅读并安排复习', parameters: [{ name: 'title', data_type: 'string', required: true }], operations: [
      { kind: 'create_object', objectType: 'e2e_reading', propertyMappings: { title: { source: { parameter: 'title' } }, status: { literal: 'done' } } },
      { kind: 'invoke_command', command: 'add_todo', params: { title: { source: { parameter: 'title' } }, notes: { result: { step: 0, path: ['objectId'] } } } },
      { kind: 'create_link', linkType: 'e2e_reading_todos', leftId: { result: { step: 0, path: ['objectId'] } }, rightId: { result: { step: 1, path: ['value', 'id'] } } },
    ] });
    expect(defined.ok).toBe(true);
    const input = { action: 'e2e_finish_reading', params: { title: '阅读组合复习' }, options: { idempotencyKey: 'mcp-reading-1' } };
    const first = await call('invoke_action', input);
    expect(first.ok).toBe(true);
    const replay = await call('invoke_action', input);
    expect(replay.data).toMatchObject({ executionId: first.data.executionId, replayed: true });
    const reading = (await call('query_objects', { object_type: 'e2e_reading' })).data.rows[0];
    const todo = (await call('list_todos', { search: '阅读组合复习' })).data.todos[0];
    expect(todo.notes).toBe(reading.id);
    const actions = (await call('list_object_types', {})).data.actionTypes;
    const update = actions.find((a: { template?: { targetName: string; operation: string } }) => a.template?.targetName === 'e2e_reading' && a.template.operation === 'update');
    const preview = (await call('preview_action', { action: update.apiName, params: { id: reading.id, values: { title: '修改' } } })).data;
    await call('update_object', { object_type: 'e2e_reading', id: reading.id, values: { status: 'pending' } });
    const stale = await call('invoke_action', { action: update.apiName, params: { id: reading.id, values: { title: '修改' } }, options: { expectedDefinitionRevision: preview.definitionRevision, expectedObjects: preview.targets } });
    expect(stale.code).toBe('REVISION_CONFLICT');
    const runs = (await call('list_action_executions', { action: 'e2e_finish_reading' })).data;
    expect(runs.rows.filter((r: { status: string }) => r.status === 'succeeded')).toHaveLength(1);
    expect(JSON.stringify(runs)).not.toContain('result_json');
    expect((await call('query_objects', { query: { version: 1, objectType: 'action_execution', select: ['request_key'] } })).code).toBe('FIELD_NOT_READABLE');
    await call('delete_action_type', { api_name: 'e2e_finish_reading' });
    await call('delete_link', { link_type: 'e2e_reading_todos', left_id: reading.id, right_id: todo.id });
    await call('delete_link_type', { api_name: 'e2e_reading_todos' });
    await call('delete_object', { object_type: 'e2e_reading', id: reading.id });
    await call('delete_object_type', { api_name: 'e2e_reading' });
    await call('update_object_type', { api_name: 'todo', patch: { drop_property: 'e2e_reading_ref' } });
    await call('delete_todo', { id: todo.id });
  });

  it('统一查询与旧查询并存，数组/NULL/布尔、字段投影与错误经真实协议一致', async () => {
    const call = async (name: string, args: Record<string, unknown>) => arg(await client.callTool({ name, arguments: args }));
    await call('create_object_type', { api_name: 'query_e2e', title: '统一查询夹具', properties: [
      { api_name: 'title', data_type: 'string', nullable: false },
      { api_name: 'active', data_type: 'boolean' }, { api_name: 'note', data_type: 'string' },
      { api_name: 'tags', data_type: 'json' },
    ] });
    const created = await call('create_object', { object_type: 'query_e2e', values: { title: '协议验收', active: true, tags: ['甲'] } });
    const id = created.data.id;
    const definitions = await call('list_object_types', {});
    const updateAction = definitions.data.actionTypes.find((a: { template?: { targetName: string; operation: string } }) => a.template?.targetName === 'query_e2e' && a.template.operation === 'update');
    expect(updateAction).toBeTruthy();
    await call('update_action_type', { api_name: updateAction.apiName, patch: { status: 'disabled' } });
    const blockedWrite = await call('update_object', { object_type: 'query_e2e', id, values: { title: '停用旁路' } });
    expect(blockedWrite.code).toBe('ACTION_DISABLED');
    await call('update_action_type', { api_name: updateAction.apiName, patch: { status: 'active' } });
    const contract = await call('get_query_contract', { object_type: 'query_e2e' });
    expect(contract.data.version).toBe(1);
    const input = { version: 1, objectType: 'query_e2e', select: ['title', 'tags'], where: { and: [
      { property: 'id', op: 'in', value: [id] }, { property: 'active', op: 'eq', value: true }, { property: 'note', op: 'is_null' },
    ] }, includeTotal: true };
    const result = await call('query_objects', { query: input });
    expect(result.ok).toBe(true);
    expect(result.data.rows).toEqual([{ id, title: '协议验收', tags: ['甲'] }]);
    expect(result.data.total).toBe(1);
    const grouped = await call('aggregate_objects', { query: { version: 1, objectType: 'query_e2e', groupBy: ['active'], metrics: [{ op: 'count', as: 'n' }], having: { property: 'n', op: 'gte', value: 1 } } });
    expect(grouped.data.rows).toEqual([{ dimensions: { active: true }, metrics: { n: 1 } }]);
    await call('create_object_type', { api_name: 'query_e2e_parent', title: '父对象', properties: [{ api_name: 'title', data_type: 'string' }] });
    await call('update_object_type', { api_name: 'query_e2e', patch: { add_properties: [{ api_name: 'parent_id', data_type: 'string' }] } });
    const parent = await call('create_object', { object_type: 'query_e2e_parent', values: { title: '父对象' } });
    await call('create_link_type', { api_name: 'query_e2e_link', title: '关系', left_type: 'query_e2e_parent', right_type: 'query_e2e', cardinality: 'one_to_many', fk_column: 'parent_id' });
    await call('create_link', { link_type: 'query_e2e_link', left_id: parent.data.id, right_id: id });
    const related = await call('query_related_objects', { query: { version: 1, objectType: 'query_e2e_parent', id: parent.data.id, linkType: 'query_e2e_link', side: 'left', select: ['title'] } });
    expect(related.data.rows).toEqual([{ id, title: '协议验收' }]);
    const legacy = await call('query_objects', { object_type: 'query_e2e', filters: [{ property: 'id', op: 'in', value: [id] }, { property: 'note', op: 'eq', value: null }, { property: 'active', op: 'eq', value: true }] });
    expect(legacy.data.rows[0].tags).toBe('["甲"]');
    expect((await call('get_object', { query: { version: 1, objectType: 'query_e2e', id, select: ['active'] } })).data).toEqual({ id, active: true });
    expect((await call('query_objects', { query: input, object_type: 'query_e2e' })).ok).toBe(false);
    const denied = await call('query_objects', { query: { version: 1, objectType: 'news_task', select: ['claim_token'] } });
    expect(denied.code).toBe('FIELD_NOT_READABLE');
    await call('delete_link', { link_type: 'query_e2e_link', left_id: parent.data.id, right_id: id });
    await call('delete_link_type', { api_name: 'query_e2e_link' });
    await call('delete_object', { object_type: 'query_e2e_parent', id: parent.data.id });
    await call('delete_object_type', { api_name: 'query_e2e_parent' });
    await call('delete_object', { object_type: 'query_e2e', id });
    await call('delete_object_type', { api_name: 'query_e2e' });
  });

  it('待办时段经专用工具和本体动作读写，完成后带精确打卡时间', async () => {
    const call = async (name: string, args: Record<string, unknown>) => arg(await client.callTool({ name, arguments: args }));
    const created = await call('add_todo', { title: '时段主链路', due_date: 'today', start_time: '09:00', end_time: '10:30' });
    expect(created.ok).toBe(true);
    const id = created.data.id;
    expect(created.data).toMatchObject({ start_time: '09:00', end_time: '10:30' });
    expect((await call('update_todo', { id, end_time: '08:00' })).ok).toBe(false);
    expect((await call('update_todo', { id, end_time: '11:00' })).data.end_time).toBe('11:00');
    const listed = await call('list_todos', { search: '时段主链路' });
    expect(listed.data.todos[0]).toMatchObject({ start_time: '09:00', end_time: '11:00' });
    expect((await call('invoke_action', { action: 'update_todo', params: { id, patch: { start_time: null, end_time: null } } })).ok).toBe(true);
    const actionTodo = await call('invoke_action', { action: 'add_todo', params: { title: '动作时段', due_date: todayStr(), start_time: '14:00', end_time: '15:00' } });
    expect(actionTodo.ok).toBe(true);
    const actionList = await call('list_todos', { search: '动作时段' });
    await call('delete_todo', { id: actionList.data.todos[0].id });
    await call('complete_todo', { id });
    const stats = await call('get_checkin_stats', {});
    expect(stats.data.recent_checkins.find((r: any) => r.ref_type === 'todo' && r.ref_id === id).created_at).toMatch(/T\d{2}:\d{2}:\d{2}/);
    await call('delete_todo', { id });
  });

  it('列出工具：包含全部核心工具', async () => {
    const res = await client.listTools();
    const names = res.tools.map((t) => t.name);
    for (const expected of [
      'list_todos', 'add_todo', 'update_todo', 'complete_todo', 'delete_todo',
      'create_study_plan', 'list_study_plans', 'get_study_plan', 'update_plan_item',
      'update_study_plan', 'delete_study_plan', 'checkin', 'get_today', 'get_checkin_stats',
      'create_review_schedule', 'list_news', 'create_news_task', 'list_news_tasks',
      'claim_news_task', 'submit_news_items', 'complete_news_task', 'release_news_task', 'cancel_news_task',
      'mark_news_read', 'mark_news_starred', 'mark_all_news_read', 'delete_news_item', 'read_news_html',
      'get_study_workflow', 'draft_study_plan', 'list_study_drafts', 'get_study_draft',
      'confirm_study_plan_draft', 'cancel_study_plan_draft',
      'record_study_session', 'list_study_sessions',
      'record_study_assessment', 'list_study_assessments', 'get_mastery',
      'suggest_plan_adjustments', 'apply_plan_adjustments',
      'preview_study_cards', 'export_study_cards', 'list_card_exports',
      'list_tools', 'add_tool', 'update_tool', 'delete_tool',
      'list_tool_categories', 'add_tool_category', 'rename_tool_category', 'delete_tool_category',
      'list_object_types', 'query_objects', 'invoke_action',
      'get_object', 'create_object', 'update_object', 'delete_object',
      'create_object_type', 'update_object_type', 'delete_object_type',
      'create_link_type', 'delete_link_type',
      'create_action_type', 'update_action_type', 'delete_action_type',
      // 知识库 vault（只读联动）
      'register_vault', 'list_vaults', 'scan_vault', 'list_vault_notes', 'search_vault_notes',
      'get_vault_note', 'link_concept_note', 'unlink_concept_note', 'list_concept_links',
      // 自媒体工作流
      'get_media_overview', 'add_media_topic', 'list_media_topics', 'update_media_topic', 'delete_media_topic',
      'add_media_content', 'list_media_contents', 'get_media_content', 'update_media_content', 'delete_media_content',
      'add_media_version', 'update_media_version', 'submit_media_version',
      'add_media_material', 'list_media_materials', 'update_media_material', 'delete_media_material',
      'attach_media_material', 'detach_media_material',
      'schedule_media_post', 'list_media_calendar', 'mark_media_published', 'cancel_media_schedule',
      'add_media_metric', 'list_media_metrics', 'get_media_stats', 'export_media_package',
      // 日历（个人日程）
      'list_calendar_events', 'add_calendar_event', 'update_calendar_event', 'delete_calendar_event',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('删除学习计划 action 与专用工具均支持连删或保留待办', async () => {
    const meta = arg(await client.callTool({ name: 'list_object_types', arguments: {} })).data;
    expect(meta.actionTypes.some((a: any) => a.apiName === 'delete_study_plan' && a.isBuiltin)).toBe(true);
    for (const viaAction of [true, false]) {
      for (const keepTodos of [false, true]) {
        const created = arg(await client.callTool({ name: 'create_study_plan', arguments: {
          title: '删除链路测试', start_date: todayStr(), items: [{ date: todayStr(), content: '关联待办' }],
        } }));
        expect(created.ok).toBe(true);
        const plan = arg(await client.callTool({ name: 'get_study_plan', arguments: { id: created.data.plan_id } })).data;
        await client.callTool({ name: 'update_plan_item', arguments: { id: plan.items[0].id, status: 'done' } });
        const params = { id: plan.id, ...(keepTodos ? { delete_todos: false } : {}) };
        const result = arg(await client.callTool(viaAction
          ? { name: 'invoke_action', arguments: { action: 'delete_study_plan', params } }
          : { name: 'delete_study_plan', arguments: params }));
        expect(result.ok).toBe(true);
        expect(arg(await client.callTool({ name: 'get_study_plan', arguments: { id: plan.id } })).ok).toBe(false);
        const todos = arg(await client.callTool({ name: 'list_todos', arguments: { tag: `plan:${plan.id}` } })).data.todos;
        expect(todos).toHaveLength(keepTodos ? 1 : 0);
        const db = new DatabaseSync(join(dbDir, 'e2e.db'), { readOnly: true });
        try {
          expect(db.prepare("SELECT COUNT(*) AS n FROM checkins WHERE ref_type='plan_item' AND ref_id=?").get(plan.items[0].id)?.n).toBe(0);
          expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
        } finally { db.close(); }
        if (keepTodos) await client.callTool({ name: 'delete_todo', arguments: { id: plan.items[0].todo_id } });
      }
    }
    const missing = arg(await client.callTool({ name: 'invoke_action', arguments: { action: 'delete_study_plan', params: { id: 999999 } } }));
    expect(missing.ok).toBe(false);
  });

  it('本体工具：list_object_types → query_objects → invoke_action 全链路', async () => {
    const meta = arg(await client.callTool({ name: 'list_object_types', arguments: {} })).data;
    expect(meta.objectTypes.map((t: any) => t.apiName)).toEqual(
      expect.arrayContaining(['todo', 'study_plan', 'plan_item', 'checkin', 'news_item', 'tool', 'tool_category', 'day']),
    );
    expect(meta.linkTypes.length).toBeGreaterThanOrEqual(6);
    expect(meta.actionTypes.filter((a: any) => a.isBuiltin).length).toBeGreaterThan(50);

    const added = arg(
      await client.callTool({ name: 'invoke_action', arguments: { action: 'add_todo', params: { title: '本体链路测试' } } }),
    ).data;
    const id = added.result.id;

    const found = arg(
      await client.callTool({ name: 'query_objects', arguments: { object_type: 'todo', filters: [{ property: 'id', op: 'eq', value: id }] } }),
    ).data;
    expect(found.total).toBe(1);
    expect(found.rows[0].title).toBe('本体链路测试');

    const done = arg(await client.callTool({ name: 'invoke_action', arguments: { action: 'complete_todo', params: { id } } })).data;
    expect(done.builtin).toBe(true);

    // 非法输入走错误信封
    const bad = arg(await client.callTool({ name: 'invoke_action', arguments: { action: 'add_todo', params: {} } }));
    expect(bad.ok).toBe(false);

    // 清理自己造的数据，避免污染后续用例的计数
    arg(await client.callTool({ name: 'invoke_action', arguments: { action: 'delete_todo', params: { id } } }));
  });

  it('本体管理：建类型→加属性→建链接→建实例→建动作→执行→清理 全链路', async () => {
    // 1. 建两个自定义类型
    arg(
      await client.callTool({
        name: 'create_object_type',
        arguments: { api_name: 'mcp_note', title: 'MCP笔记', properties: [{ api_name: 'content', data_type: 'string' }] },
      }),
    );
    arg(
      await client.callTool({
        name: 'create_object_type',
        arguments: { api_name: 'mcp_folder', title: 'MCP文件夹', properties: [{ api_name: 'name', data_type: 'string' }] },
      }),
    );
    // 2. 给笔记加外键属性并建 1:N 链接
    arg(
      await client.callTool({
        name: 'update_object_type',
        arguments: { api_name: 'mcp_note', patch: { add_properties: [{ api_name: 'folder_id', data_type: 'string' }] } },
      }),
    );
    arg(
      await client.callTool({
        name: 'create_link_type',
        arguments: { api_name: 'mcp_folder__note', title: '文件夹的笔记', left_type: 'mcp_folder', right_type: 'mcp_note', cardinality: 'one_to_many', fk_column: 'folder_id' },
      }),
    );
    // 3. 建实例 + 更新 + 详情
    const folder = arg(
      await client.callTool({ name: 'create_object', arguments: { object_type: 'mcp_folder', values: { name: '工作' } } }),
    ).data;
    const note = arg(
      await client.callTool({ name: 'create_object', arguments: { object_type: 'mcp_note', values: { content: '第一条', folder_id: folder.id } } }),
    ).data;
    arg(await client.callTool({ name: 'update_object', arguments: { object_type: 'mcp_note', id: note.id, values: { content: '第一条（改）' } } }));
    const got = arg(await client.callTool({ name: 'get_object', arguments: { object_type: 'mcp_note', id: note.id } })).data;
    expect(got.row.content).toBe('第一条（改）');
    // 出链解析到文件夹，入链从文件夹能看到笔记
    const out = got.links.filter((l: any) => l.direction === 'out');
    expect(out).toHaveLength(1);
    expect(out[0].targetType).toBe('mcp_folder');
    // 4. 建动作（create_link：把笔记挂到新文件夹）并执行
    arg(
      await client.callTool({
        name: 'create_action_type',
        arguments: {
          api_name: 'mcp_move_note',
          title: '移动笔记',
          parameters: [
            { name: 'folder_id', data_type: 'string', required: true },
            { name: 'note_id', data_type: 'string', required: true },
          ],
          operations: [{ kind: 'create_link', linkType: 'mcp_folder__note', leftId: { source: { parameter: 'folder_id' } }, rightId: { source: { parameter: 'note_id' } } }],
        },
      }),
    );
    const folder2 = arg(await client.callTool({ name: 'create_object', arguments: { object_type: 'mcp_folder', values: { name: '生活' } } })).data;
    const unlinked = await client.callTool({name:'delete_link',arguments:{link_type:'mcp_folder__note',left_id:folder.id,right_id:note.id}});
    expect(unlinked.isError).not.toBe(true);
    const ran = arg(await client.callTool({ name: 'invoke_action', arguments: { action: 'mcp_move_note', params: { folder_id: folder2.id, note_id: note.id } } })).data;
    expect(ran.results[0].kind).toBe('create_link');
    const moved = arg(await client.callTool({ name: 'get_object', arguments: { object_type: 'mcp_note', id: note.id } })).data;
    expect(moved.row.folder_id).toBe(folder2.id);
    // 5. 停用动作后执行被拒
    arg(await client.callTool({ name: 'update_action_type', arguments: { api_name: 'mcp_move_note', patch: { status: 'disabled' } } }));
    const denied = arg(await client.callTool({ name: 'invoke_action', arguments: { action: 'mcp_move_note', params: { folder_id: folder2.id, note_id: note.id } } }));
    expect(denied.ok).toBe(false);
    // 6. 清理：动作 → 链接 → 删实例 → 删类型（有引用时删除被拒，按序清理）
    arg(await client.callTool({ name: 'delete_action_type', arguments: { api_name: 'mcp_move_note' } }));
    arg(await client.callTool({ name: 'delete_link_type', arguments: { api_name: 'mcp_folder__note' } }));
    arg(await client.callTool({ name: 'delete_object', arguments: { object_type: 'mcp_note', id: note.id } }));
    arg(await client.callTool({ name: 'delete_object_type', arguments: { api_name: 'mcp_note' } }));
    arg(await client.callTool({ name: 'delete_object_type', arguments: { api_name: 'mcp_folder' } }));
    const meta = arg(await client.callTool({ name: 'list_object_types', arguments: {} })).data;
    expect(meta.objectTypes.find((t: any) => t.apiName === 'mcp_note')).toBeUndefined();
    expect(meta.objectTypes.find((t: any) => t.apiName === 'mcp_folder')).toBeUndefined();
  });

  it('完整用户旅程：建待办 → 生成学习计划 → 查今日 → 打卡 → 完成 → 统计', async () => {
    // 日期全部相对今天生成，避免用例跨天后失效
    const T0 = todayStr();
    const T1 = addDays(T0, 1);
    const T2 = addDays(T0, 2);
    // 1. AI 新增待办（优先级别名归一化）
    const addRes = arg(
      await client.callTool({
        name: 'add_todo',
        arguments: { title: '看完 TypeScript 第一课', priority: 'P0', due_date: T1, tags: ['学习'] },
      }),
    );
    expect(addRes.ok).toBe(true);
    expect(addRes.data.priority).toBe('high');
    expect(addRes.data.source).toBe('mcp');
    const todoId = addRes.data.id as number;

    // 2. 修改待办截止日期
    const updRes = arg(
      await client.callTool({ name: 'update_todo', arguments: { id: todoId, due_date: T2, notes: '调期' } }),
    );
    expect(updRes.data.due_date).toBe(T2);

    // 3. AI 生成学习计划（学习 + 复习编排），自动生成待办
    const planRes = arg(
      await client.callTool({
        name: 'create_study_plan',
        arguments: {
          title: 'TS 系列课程 3 天速通',
          goal: '掌握类型系统',
          start_date: T0,
          items: [
            { date: T0, content: '第 1 课：基础类型', item_type: 'learn', duration_min: 45 },
            { date: T1, content: '复习第 1 课 + 第 2 课：泛型', item_type: 'review' },
            { date: T2, content: '第 3 课：实战练习', item_type: 'practice' },
          ],
        },
      }),
    );
    expect(planRes.ok).toBe(true);
    expect(planRes.data.item_count).toBe(3);
    expect(planRes.data.todos_created).toBe(3);
    const planId = planRes.data.plan_id as number;

    // 4. 查看计划详情
    const detail = arg(await client.callTool({ name: 'get_study_plan', arguments: { id: planId } }));
    const todayItem = detail.data.items.find((i: any) => i.date === T0);
    expect(todayItem.content).toContain('第 1 课');

    // 5. 今日概览：能看到今日安排
    const today = arg(await client.callTool({ name: 'get_today', arguments: { date: T0 } }));
    expect(today.data.today_plan_items).toHaveLength(1);
    expect(today.data.summary.plan_item_done_count).toBe(0);
    expect(today.data.summary_text).toContain('学习安排 1 项');

    // 6. 学习打卡（条目置 done，联动待办 + 记打卡）
    const doneRes = arg(
      await client.callTool({ name: 'update_plan_item', arguments: { id: todayItem.id, status: 'done' } }),
    );
    expect(doneRes.data.item.status).toBe('done');
    expect(doneRes.data.plan_progress).toBeGreaterThanOrEqual(0.33);

    // 7. 每日打卡
    const ck = arg(
      await client.callTool({ name: 'checkin', arguments: { ref_type: 'day', date: T0, note: '坚持！' } }),
    );
    expect(ck.ok).toBe(true);

    // 8. 完成第 1 步的待办
    const comp = arg(await client.callTool({ name: 'complete_todo', arguments: { id: todoId } }));
    expect(comp.data.status).toBe('done');

    // 9. 列表核对：计划生成的待办 + 完成状态
    const list = arg(await client.callTool({ name: 'list_todos', arguments: { status: 'all' } }));
    expect(list.data.count).toBe(4);
    expect(list.data.todos.filter((t: any) => t.status === 'done')).toHaveLength(2);

    // 10. 打卡统计
    const stats = arg(await client.callTool({ name: 'get_checkin_stats', arguments: {} }));
    expect(stats.data.total_checkins).toBeGreaterThanOrEqual(3);

    // 11. 今日概览反映打卡结果
    const today2 = arg(await client.callTool({ name: 'get_today', arguments: { date: T0 } }));
    expect(today2.data.summary.plan_item_done_count).toBe(1);
    expect(today2.data.summary.todo_done_count).toBe(2); // 手工完成 1 + 计划联动完成 1
    expect(today2.data.summary.manual_checkin_count).toBe(1);
  });

  it('间隔复习：学完知识点后一键生成 D+1/3/7/21 复习计划与待办', async () => {
    const { addDays, todayStr } = await import('../../../packages/core/src/utils/date');
    const T0 = todayStr();
    const res = arg(
      await client.callTool({
        name: 'create_review_schedule',
        arguments: {
          topics: [{ name: 'SQLite WAL 并发', learned_date: addDays(T0, -1) }, 'MCP stdio 传输'],
          start_date: T0,
        },
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.data.topic_count).toBe(2);
    expect(res.data.item_count).toBe(8); // 2 主题 × 4 间隔
    expect(res.data.todos_created).toBe(8);
    // 最早复习日 = 昨天学完的 D+1 = 今天
    expect(res.data.review_dates[0]).toBe(T0);
    const detail = arg(await client.callTool({ name: 'get_study_plan', arguments: { id: res.data.plan_id } }));
    expect(detail.data.items.every((i: any) => i.item_type === 'review')).toBe(true);
    const dates = detail.data.items.map((i: any) => i.date);
    expect(dates).toContain(addDays(T0, 2)); // 昨天 + 3
    expect(dates).toContain(addDays(T0, 21)); // 今天 + 21
  });

  it('业务错误通过 isError 返回可读信息', async () => {
    const res = await client.callTool({ name: 'complete_todo', arguments: { id: 99999 } });
    expect(res.isError).toBe(true);
    expect(arg(res).error).toContain('不存在');
  });

  it('非法优先级被参数校验拦截', async () => {
    const res = await client.callTool({ name: 'add_todo', arguments: { title: 'x', priority: '超紧急' } });
    expect(res.isError).toBe(true);
  });

  it('新闻模块（agent-only）：create → claim → submit → complete → list_news 读回；24h/历史与收藏共享', async () => {
    // 历史行（模拟旧版抓取数据）：3 天前，无精确发布时间
    {
      const db = new DatabaseSync(join(dbDir, 'e2e.db'));
      try {
        db.prepare(
          "INSERT INTO news (source, title, url, summary, published_date, fetched_at, dedup_key, is_starred) VALUES ('hacker_news', 'e2e 历史旧行', 'https://old.example.com/hn', '旧摘要', ?, '2026-10-01T00:00:00.000', 'e2e:legacy:hn', 1)",
        ).run(addDays(todayStr(), -3));
      } finally {
        db.close();
      }
    }

    // 1. 建任务（预算 4、时间窗 24h）
    const task = arg(await client.callTool({ name: 'create_news_task', arguments: { title: 'e2e：AI 最近动态', instructions: '只要一手来源', max_items: 4, window_hours: 24 } })).data;
    expect(task.status).toBe('pending');
    expect(task.max_items).toBe(4);
    expect(task.remaining).toBe(4);

    // 2. 认领
    const claim = arg(await client.callTool({ name: 'claim_news_task', arguments: { task_id: task.id, claimed_by: 'e2e-agent' } })).data;
    expect(claim.task.status).toBe('claimed');
    expect(claim.task.claimed_by).toBe('e2e-agent');
    expect(claim.claim_token).toBeTruthy();

    // 3. 提交 2 条（agent 核实形态：原始来源链接 + 摘要 + 真实发布时间）
    const now = Date.now();
    const items = [
      { title: 'e2e 新闻一：模型发布', summary: '摘要一：性能与许可证变化。', source_url: 'https://example.com/e2e-1', source_name: 'Example', published_at: new Date(now - 3600_000).toISOString() },
      { title: 'e2e 新闻二：框架更新', summary: '摘要二：破坏性变更说明。', source_url: 'https://example.com/e2e-2', published_at: new Date(now - 7200_000).toISOString() },
    ];
    const submitted = arg(await client.callTool({ name: 'submit_news_items', arguments: { task_id: task.id, claim_token: claim.claim_token, items } })).data;
    expect(submitted.inserted).toBe(2);
    expect(submitted.task.inserted_count).toBe(2);
    expect(submitted.items[0].source).toBe('agent');

    // 4. list_news 读回：任务过滤 + 24h 窗口与历史视图
    const listed = arg(await client.callTool({ name: 'list_news', arguments: { task_id: task.id } })).data;
    expect(listed.count).toBe(2);
    expect(listed.news.every((n: any) => n.source === 'agent' && n.task_id === task.id)).toBe(true);
    const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();
    const recent = arg(await client.callTool({ name: 'list_news', arguments: { since: since24h, limit: 100 } })).data;
    expect(recent.news.some((n: any) => n.title === 'e2e 新闻一：模型发布')).toBe(true);
    expect(recent.news.some((n: any) => n.title === 'e2e 历史旧行')).toBe(false); // 旧数据无精确时间，按北京日末尾计，3 天前不在 24h 内
    const history = arg(await client.callTool({ name: 'list_news', arguments: { days: 7, limit: 100 } })).data;
    expect(history.news.some((n: any) => n.title === 'e2e 历史旧行')).toBe(true); // 历史视图不受任务 10 条预算限制

    // 5. 重复提交（同来源链接）被硬拒绝
    const dup = await client.callTool({ name: 'submit_news_items', arguments: { task_id: task.id, claim_token: claim.claim_token, items: [{ ...items[0], published_at: new Date(now - 1800_000).toISOString() }] } });
    expect(dup.isError).toBe(true);
    expect(arg(dup).error).toContain('已在库中');

    // 6. 已读/收藏（与 App 共享同一持久状态）
    const first = listed.news[0];
    expect(arg(await client.callTool({ name: 'mark_news_read', arguments: { id: first.id } })).data.is_read).toBe(true);
    expect(arg(await client.callTool({ name: 'mark_news_starred', arguments: { id: first.id, starred: true } })).data.is_starred).toBe(true);
    const starredList = arg(await client.callTool({ name: 'list_news', arguments: { task_id: task.id, filter: 'starred' } })).data;
    expect(starredList.news.map((n: any) => n.id)).toEqual([first.id]);
    expect(arg(await client.callTool({ name: 'mark_all_news_read', arguments: { task_id: task.id } })).data).toBe(1);

    // 7. 完成任务（note 留痕）→ 任务列表可见
    const done = arg(await client.callTool({ name: 'complete_news_task', arguments: { task_id: task.id, claim_token: claim.claim_token, note: 'e2e 收录 2 条' } })).data;
    expect(done.status).toBe('completed');
    expect(done.completed_note).toBe('e2e 收录 2 条');
    const tasks = arg(await client.callTool({ name: 'list_news_tasks', arguments: { status: 'completed' } })).data.tasks;
    expect(tasks.map((t: any) => t.id)).toContain(task.id);
  });

  it('新闻本地快照：submit 带 html 落盘消毒 → list/read 回读 → 删除随行清理', async () => {
    // 1. 建任务并认领
    const task = arg(await client.callTool({ name: 'create_news_task', arguments: { title: 'e2e：X 快照任务', max_items: 2 } })).data;
    const claim = arg(await client.callTool({ name: 'claim_news_task', arguments: { task_id: task.id, claimed_by: 'e2e-snap' } })).data;

    // 2. 提交一条带 html 快照（X 来源）+ 一条普通 URL 条目
    const snapshotHtml = [
      '<article><h3>某作者的推文</h3>',
      '<p>正文：新模型开源了。</p>',
      '<img src="https://pbs.twimg.com/media/e2e.jpg" alt="配图">',
      '<a href="https://x.com/author/status/999">原帖</a>',
      "<script>alert('bad')</script>",
      '<a href="javascript:alert(1)">危险链接</a>',
      '</article>',
    ].join('');
    const submitted = arg(await client.callTool({ name: 'submit_news_items', arguments: {
      task_id: task.id,
      claim_token: claim.claim_token,
      items: [
        { title: 'e2e X 快照新闻', summary: '摘要：推文宣布开源。', source_url: 'https://x.com/author/status/999', source_name: 'X', published_at: new Date(Date.now() - 1800_000).toISOString(), html: snapshotHtml },
        { title: 'e2e 普通网页新闻', summary: '摘要：普通页面。', source_url: 'https://example.com/e2e-snap-plain', published_at: new Date(Date.now() - 2400_000).toISOString() },
      ],
    } })).data;
    expect(submitted.inserted).toBe(2);
    const snap = submitted.items[0];
    const plain = submitted.items[1];
    expect(snap.content_kind).toBe('html');
    expect(snap.html_rel).toMatch(/^[0-9a-f-]{36}\.html$/);
    expect(plain.content_kind).toBe('url');
    expect(plain.html_rel).toBeNull();

    // 3. 文件真实落盘在库旁 news/ 目录，且已消毒（无脚本/危险协议，保留图床外链），带 charset
    const abs = join(dbDir, 'news', snap.html_rel);
    expect(existsSync(abs)).toBe(true);
    const saved = readFileSync(abs, 'utf8');
    expect(saved).not.toContain('<script');
    expect(saved).not.toContain('javascript:');
    expect(saved).toContain('https://pbs.twimg.com/media/e2e.jpg');
    expect(saved).toMatch(/<meta charset="utf-8">/);

    // 4. list_news 携带内容形态；read_news_html 回读快照原文，url 条目返回 null
    const listed = arg(await client.callTool({ name: 'list_news', arguments: { task_id: task.id } })).data;
    expect(listed.news.find((n: any) => n.id === snap.id).content_kind).toBe('html');
    const back = arg(await client.callTool({ name: 'read_news_html', arguments: { id: snap.id } })).data;
    expect(back.content_kind).toBe('html');
    expect(back.missing).toBe(false);
    expect(back.html).toContain('新模型开源了');
    expect(arg(await client.callTool({ name: 'read_news_html', arguments: { id: plain.id } })).data).toMatchObject({ content_kind: 'url', html: null });

    // 5. 空快照整批拒绝（原子性），不占用预算
    const bad = await client.callTool({ name: 'submit_news_items', arguments: { task_id: task.id, claim_token: claim.claim_token, items: [{ title: 'e2e 空快照', summary: 'x。', source_url: 'https://x.com/author/status/1000', published_at: new Date(Date.now() - 1200_000).toISOString(), html: ' ' }] } });
    expect(bad.isError).toBe(true);
    expect(arg(bad).error).toContain('html 快照不能为空');

    // 6. 删除快照新闻：文件随行清理，指纹防回流
    const del = arg(await client.callTool({ name: 'delete_news_item', arguments: { id: snap.id } })).data;
    expect(del.deleted).toBe(true);
    expect(del.html_removed).toBe(1);
    expect(existsSync(abs)).toBe(false);
    await client.callTool({ name: 'complete_news_task', arguments: { task_id: task.id, claim_token: claim.claim_token, note: 'e2e 快照链路完成' } });
  });

   it('新闻删除：delete_news_item 事务删除、指纹防回流、媒体引用解除、预算不返还、幂等', async () => {
     // 1. 真实提交路径造 2 条 + 一条引用它的自媒体选题
     const task = arg(await client.callTool({ name: 'create_news_task', arguments: { title: 'e2e：删除任务', max_items: 2 } })).data;
     const claim = arg(await client.callTool({ name: 'claim_news_task', arguments: { task_id: task.id, claimed_by: 'e2e-del' } })).data;
     const items = [1, 2].map((n) => ({
       title: `e2e 删除新闻 ${n}`,
       summary: `删除摘要 ${n}。`,
       source_url: `https://example.com/e2e-del-${n}`,
       published_at: new Date(Date.now() - 3600_000).toISOString(),
     }));
     const submitted = arg(await client.callTool({ name: 'submit_news_items', arguments: { task_id: task.id, claim_token: claim.claim_token, items } })).data;
     const target = submitted.items[0];
     const alive = submitted.items[1];
     const db0 = new DatabaseSync(join(dbDir, 'e2e.db'));
     try {
       const topicId = arg(await client.callTool({ name: 'add_media_topic', arguments: { title: '引用待删新闻的选题', source: 'news', source_news_id: target.id } })).data.id;
       // 2. 删除：事务返回明细节点
       const del = arg(await client.callTool({ name: 'delete_news_item', arguments: { id: target.id } })).data;
       expect(del).toMatchObject({ deleted: true, id: target.id, media_refs_cleared: 1, fingerprints_kept: 2 });
       // 3. 幂等：重复删除 → deleted:false
       expect(arg(await client.callTool({ name: 'delete_news_item', arguments: { id: target.id } })).data.deleted).toBe(false);
       // 4. 库内不再可见；另一条保留
       const listed = arg(await client.callTool({ name: 'list_news', arguments: { limit: 100 } })).data;
       expect(listed.news.some((n: any) => n.id === target.id)).toBe(false);
       expect(listed.news.some((n: any) => n.id === alive.id)).toBe(true);
       // 5. 自媒体成果保留、快照保留、失效引用解除
       const t = db0.prepare('SELECT source_news_id, source_desc FROM media_topics WHERE id = ?').get(topicId) as Record<string, unknown>;
       expect(t.source_news_id).toBeNull();
       expect(String(t.source_desc)).toContain('e2e 删除新闻 1');
       // 6. 指纹防回流：同链接提交被拒（新任务）
       const task2 = arg(await client.callTool({ name: 'create_news_task', arguments: { title: 'e2e：删除后回流测试' } })).data;
       const claim2 = arg(await client.callTool({ name: 'claim_news_task', arguments: { task_id: task2.id } })).data;
       const reflow = await client.callTool({ name: 'submit_news_items', arguments: { task_id: task2.id, claim_token: claim2.claim_token, items: [{ ...items[0], published_at: new Date(Date.now() - 1800_000).toISOString() }] } });
      expect(reflow.isError).toBe(true);
       expect(String(arg(reflow).error ?? '')).toContain('已被用户删除');
       // 7. 预算不返还：删 1 条后任务 accepted_count 仍为 2、remaining 0
       const tasksAfter = arg(await client.callTool({ name: 'list_news_tasks', arguments: {} })).data.tasks;
       const t1 = tasksAfter.find((x: any) => x.id === task.id);
       expect(t1.inserted_count).toBe(1);
       expect(t1.accepted_count).toBe(2);
       expect(t1.remaining).toBe(0);
     } finally {
       db0.close();
     }
   });
  it('新闻模块（agent-only）：离线保持待执行；恶意/错误输入硬拒绝；预算整批拒；释放与取消', async () => {
    const freshItem = (n: number) => ({
      title: `e2e 边界新闻 ${n}`,
      summary: `边界摘要 ${n}。`,
      source_url: `https://example.com/e2e-edge-${n}`,
      published_at: new Date(Date.now() - 3600_000).toISOString(),
    });

    // 离线语义：任务创建后保持待执行（没有本地进程会去「唤醒」执行）
    const task = arg(await client.callTool({ name: 'create_news_task', arguments: { title: 'e2e：待执行任务' } })).data;
    const pending = arg(await client.callTool({ name: 'list_news_tasks', arguments: { status: 'pending' } })).data.tasks;
    expect(pending.map((t: any) => t.id)).toContain(task.id);

    // 未认领直接提交 → 拒
    const noClaim = await client.callTool({ name: 'submit_news_items', arguments: { task_id: task.id, claim_token: 'none', items: [freshItem(101)] } });
    expect(noClaim.isError).toBe(true);
    expect(arg(noClaim).error).toContain('认领');

    // 认领后逐项恶意/错误输入全部拒绝
    const claim = arg(await client.callTool({ name: 'claim_news_task', arguments: { task_id: task.id } })).data;
    const badCases = [
      { ...freshItem(102), source_url: 'javascript:alert(1)' },
      { ...freshItem(103), source_url: 'http://192.168.0.1/x' },
      { ...freshItem(104), published_at: new Date(Date.now() + 86400_000).toISOString() },
      { ...freshItem(105), published_at: new Date(Date.now() - 48 * 3600_000).toISOString() },
      { ...freshItem(106), summary: '' },
      { ...freshItem(107), published_at: 'not-a-date' },
    ];
    for (const c of badCases) {
      const bad = await client.callTool({ name: 'submit_news_items', arguments: { task_id: task.id, claim_token: claim.claim_token, items: [c] } });
      expect(bad.isError).toBe(true);
    }
    // 错误令牌
    const wrong = await client.callTool({ name: 'submit_news_items', arguments: { task_id: task.id, claim_token: '00000000-0000-0000-0000-000000000000', items: [freshItem(108)] } });
    expect(arg(wrong).error).toContain('令牌');

    // 预算整批拒：max_items=2，一次提交 3 条 → 全部拒绝
    const t2 = arg(await client.callTool({ name: 'create_news_task', arguments: { title: 'e2e：预算任务', max_items: 2 } })).data;
    const c2 = arg(await client.callTool({ name: 'claim_news_task', arguments: { task_id: t2.id } })).data;
    const over = await client.callTool({ name: 'submit_news_items', arguments: { task_id: t2.id, claim_token: c2.claim_token, items: [freshItem(201), freshItem(202), freshItem(203)] } });
    expect(arg(over).error).toContain('预算');
    expect(arg(await client.callTool({ name: 'list_news_tasks', arguments: {} })).data.tasks.find((t: any) => t.id === t2.id).inserted_count).toBe(0);

    // 释放：回待执行、原因留痕；有效认领时不可取消，释放后可取消
    const rel = arg(await client.callTool({ name: 'release_news_task', arguments: { task_id: t2.id, claim_token: c2.claim_token, reason: 'e2e 释放' } })).data;
    expect(rel.status).toBe('pending');
    expect(rel.last_error).toBe('e2e 释放');
    const c3 = arg(await client.callTool({ name: 'claim_news_task', arguments: { task_id: t2.id } })).data;
    const cancelDenied = await client.callTool({ name: 'cancel_news_task', arguments: { task_id: t2.id } });
    expect(cancelDenied.isError).toBe(true);
    await client.callTool({ name: 'release_news_task', arguments: { task_id: t2.id, claim_token: c3.claim_token } });
    expect(arg(await client.callTool({ name: 'cancel_news_task', arguments: { task_id: t2.id } })).data.status).toBe('cancelled');

    // 收尾：第一个任务释放（保留 pending 由后续会话认领是合法状态，但避免堆积）
    await client.callTool({ name: 'release_news_task', arguments: { task_id: task.id, claim_token: claim.claim_token } });
  });

  it('验收场景A：add_todo due_date=今天 → 出现在今日到期待办', async () => {
    const added = arg(
      await client.callTool({ name: 'add_todo', arguments: { title: '场景A：加入今日待办', due_date: '今天' } }),
    );
    expect(added.ok).toBe(true);
    expect(added.data.due_date).toBe(todayStr());

    const today = arg(await client.callTool({ name: 'get_today', arguments: {} }));
    expect(today.data.due_today_todos.map((t: any) => t.id)).toContain(added.data.id);

    // 英文别名与「明天」同样归一；非法日期被 schema 拦截
    const t2 = arg(await client.callTool({ name: 'add_todo', arguments: { title: '明天再做的别名测试', due_date: 'tomorrow' } }));
    expect(t2.data.due_date).toBe(addDays(todayStr(), 1));
    const bad = await client.callTool({ name: 'add_todo', arguments: { title: 'x', due_date: '下周三吧' } });
    expect(bad.isError).toBe(true);
    arg(await client.callTool({ name: 'delete_todo', arguments: { id: t2.data.id } }));
  });

  it('验收场景B：add_tool 装入工具箱 → App 同源可见 → 文件落盘 → 替换/删除', async () => {
    // 1. file_paths 通道：把本地 HTML 文件装入，分类自动创建
    const srcPath = join(dbDir, 'e2e-tool-src.html');
    writeFileSync(srcPath, '<h1>hello tododesk</h1>', 'utf8');
    const added = arg(
      await client.callTool({
        name: 'add_tool',
        arguments: { title: '场景B：色板转换器', category_name: 'E2E分类', file_paths: [srcPath] },
      }),
    );
    expect(added.ok).toBe(true);
    const id = added.data.tool.id as number;
    expect(added.data.tool.category_id).not.toBeNull();
    expect(added.data.files).toEqual(['e2e-tool-src.html']);

    // 2. 文件真实落盘在数据库旁 tools/<id>/（App 的 tool-file:// 协议读的就是这里）
    const toolDir = join(dbDir, 'tools', String(id));
    expect(existsSync(join(toolDir, 'e2e-tool-src.html'))).toBe(true);
    expect(readFileSync(join(toolDir, 'e2e-tool-src.html'), 'utf8')).toContain('hello tododesk');

    // 3. list_tools 可见；本体查询（App 数据面板同一数据源）同样可查
    const listed = arg(await client.callTool({ name: 'list_tools', arguments: {} }));
    expect(listed.data.tools.find((t: any) => t.id === id)?.title).toBe('场景B：色板转换器');
    const q = arg(
      await client.callTool({ name: 'query_objects', arguments: { object_type: 'tool', filters: [{ property: 'id', op: 'eq', value: id }] } }),
    );
    expect(q.data.total).toBe(1);
    const cats = arg(await client.callTool({ name: 'list_tool_categories', arguments: {} }));
    expect(cats.data.categories.some((c: any) => c.name === 'E2E分类' && c.tool_count === 1)).toBe(true);

    // 4. base64 通道整体替换（现场生成 HTML 场景），入口自动切到 index.html
    const html = '<!doctype html><title>色板</title><p>PICKED</p>';
    const upd = arg(
      await client.callTool({
        name: 'update_tool',
        arguments: { id, files: [{ name: 'index.html', content_base64: Buffer.from(html).toString('base64') }] },
      }),
    );
    expect(upd.data.tool.entry_file).toBe('index.html');
    expect(readFileSync(join(toolDir, 'index.html'), 'utf8')).toContain('PICKED');
    expect(existsSync(join(toolDir, 'e2e-tool-src.html'))).toBe(false); // 整体重建，旧文件不残留

    // 5. 错误路径：入口不在文件列表 / 双通道同时传
    const bad1 = arg(
      await client.callTool({
        name: 'add_tool',
        arguments: { title: 'X', files: [{ name: 'a.html', content_base64: 'aGk=' }], entry_file: 'b.html' },
      }),
    );
    expect(bad1.ok).toBe(false);
    const bad2 = arg(
      await client.callTool({ name: 'add_tool', arguments: { title: 'X', file_paths: [srcPath], files: [{ name: 'a.html', content_base64: 'aGk=' }] } }),
    );
    expect(bad2.ok).toBe(false);

    // 6. 删除：库记录 + 文件目录一起清理
    arg(await client.callTool({ name: 'delete_tool', arguments: { id } }));
    expect(existsSync(toolDir)).toBe(false);
    const listed2 = arg(await client.callTool({ name: 'list_tools', arguments: {} }));
    expect(listed2.data.tools.find((t: any) => t.id === id)).toBeUndefined();
  });
});

describe('日历模块（MCP 主链路：读写对称，App 今日页同源）', () => {
  it('add（别名日期/颜色别名/跨天）→ list 区间相交 → get_today 带出今日日程 → update 部分更新 → delete', async () => {
    const t = todayStr();
    // 1. 新建：今天全天（别名颜色）、明天 09:30–11:00、跨天（今天→后天）
    const ev1 = arg(await client.callTool({ name: 'add_calendar_event', arguments: { title: '日历链路：全天事项', date: '今天', color: '蓝' } }));
    expect(ev1.ok).toBe(true);
    expect(ev1.data.date).toBe(t);
    expect(ev1.data.color).toBe('blue');
    expect(ev1.data.start_time).toBeNull();
    expect(ev1.data.source).toBe('mcp');
    const ev2 = arg(await client.callTool({ name: 'add_calendar_event', arguments: { title: '日历链路：晨会', date: '明天', start_time: '09:30', end_time: '11:00', note: '带时间' } }));
    expect(ev2.ok).toBe(true);
    expect(ev2.data.date).toBe(addDays(t, 1));
    const ev3 = arg(await client.callTool({ name: 'add_calendar_event', arguments: { title: '日历链路：跨城出差', date: t, end_date: addDays(t, 2) } }));
    expect(ev3.ok).toBe(true);

    // 2. list 区间相交：后天（区间 [t, t+2]）能同时看到三条；单查「今天」也命中跨天日程
    const range = arg(await client.callTool({ name: 'list_calendar_events', arguments: { from: '今天', to: addDays(t, 2) } }));
    const titles = range.data.events.map((e: any) => e.title);
    expect(titles).toContain('日历链路：全天事项');
    expect(titles).toContain('日历链路：晨会');
    expect(titles).toContain('日历链路：跨城出差');
    const onlyToday = arg(await client.callTool({ name: 'list_calendar_events', arguments: {} }));
    expect(onlyToday.data.events.map((e: any) => e.title)).toContain('日历链路：跨城出差');

    // 3. get_today 集成：今日日程含全天与跨天，全天排最前
    const today = arg(await client.callTool({ name: 'get_today', arguments: {} }));
    const todayTitles = today.data.calendar_events.map((e: any) => e.title);
    expect(todayTitles).toContain('日历链路：全天事项');
    expect(todayTitles).toContain('日历链路：跨城出差');
    expect(todayTitles.indexOf('日历链路：全天事项')).toBeLessThan(todayTitles.indexOf('日历链路：跨城出差'));
    expect(today.data.summary_text).toContain('日程');

    // 4. update 只传要改的字段：颜色不被重置、时间可改；显式传 null 清除结束日期
    const upd = arg(await client.callTool({ name: 'update_calendar_event', arguments: { id: ev3.data.id, title: '日历链路：出差（改期）', end_date: null } }));
    expect(upd.ok).toBe(true);
    expect(upd.data.title).toBe('日历链路：出差（改期）');
    expect(upd.data.end_date).toBeNull();
    expect(upd.data.color).toBe('blue'); // 未传颜色不得被重置
    const upd2 = arg(await client.callTool({ name: 'update_calendar_event', arguments: { id: ev2.data.id, start_time: '08:00' } }));
    expect(upd2.data.start_time).toBe('08:00');
    expect(upd2.data.end_time).toBe('11:00'); // 未传字段保持原值
    const upd3 = arg(await client.callTool({ name: 'update_calendar_event', arguments: { id: ev2.data.id, start_time: '10:00', end_time: '12:00' } }));
    expect(upd3.data.start_time).toBe('10:00');
    expect(upd3.data.end_time).toBe('12:00');

    // 5. search 命中标题/备注；delete 后不可再查
    const found = arg(await client.callTool({ name: 'list_calendar_events', arguments: { search: '带时间' } }));
    expect(found.data.events.length).toBe(1);
    for (const id of [ev1.data.id, ev2.data.id, ev3.data.id]) {
      arg(await client.callTool({ name: 'delete_calendar_event', arguments: { id } }));
    }
    const after = arg(await client.callTool({ name: 'list_calendar_events', arguments: { search: '日历链路' } }));
    expect(after.data.events.length).toBe(0);
    const gone = await client.callTool({ name: 'delete_calendar_event', arguments: { id: ev1.data.id } });
    expect(gone.isError).toBe(true); // 不存在的日程删除报错
  });

  it('边界校验：非法时间/日期倒置/全天带结束时间/未知颜色/区间倒置被拒', async () => {
    const t = todayStr();
    const badTime = await client.callTool({ name: 'add_calendar_event', arguments: { title: 'x', date: t, start_time: '25:00' } });
    expect(badTime.isError).toBe(true);
    const badRange = await client.callTool({ name: 'add_calendar_event', arguments: { title: 'x', date: t, end_date: addDays(t, -1) } });
    expect(badRange.isError).toBe(true);
    const allDayEnd = await client.callTool({ name: 'add_calendar_event', arguments: { title: 'x', date: t, end_time: '10:00' } });
    expect(allDayEnd.isError).toBe(true);
    const endTimeFirst = await client.callTool({ name: 'add_calendar_event', arguments: { title: 'x', date: t, start_time: '11:00', end_time: '10:00' } });
    expect(endTimeFirst.isError).toBe(true);
    const badColor = await client.callTool({ name: 'add_calendar_event', arguments: { title: 'x', date: t, color: 'pink' } });
    expect(badColor.isError).toBe(true);
    const ok = arg(await client.callTool({ name: 'add_calendar_event', arguments: { title: '临时校验事件', date: t } }));
    const badUpdate = await client.callTool({ name: 'update_calendar_event', arguments: { id: ok.data.id, end_date: '2020-01-01' } });
    expect(badUpdate.isError).toBe(true);
    arg(await client.callTool({ name: 'delete_calendar_event', arguments: { id: ok.data.id } }));
  });
});

describe('学习闭环主链路（agent 视角：学习线性代数）', () => {
  const LINALG_POINTS = [
    { key: 'linalg-vectors', name: '向量与线性组合', est_minutes: 60, outcome: '能不用资料解释线性组合并举一个例子' },
    { key: 'linalg-matrix-mult', name: '矩阵乘法', est_minutes: 90, outcome: '能手算 2x2 矩阵乘法并说明行列视角', depends_on: ['linalg-vectors'] },
  ];

  it('规范可发现：工具与资源同源；规范正文提到的工具名全部真实注册', async () => {
    const tool = arg(await client.callTool({ name: 'get_study_workflow', arguments: {} })).data;
    expect(tool.spec_markdown).toContain('透明规则');
    expect(tool.spec_markdown).toContain('draft_study_plan');
    expect(tool.tool_chain.join(' ')).toContain('export_study_cards');
    const res = await client.readResource({ uri: 'tododesk://study/workflow' });
    const text = (res.contents[0] as { text?: string }).text ?? '';
    expect(text).toBe(tool.spec_markdown);
    // 发现性验收：规范正文反引号引用的工具名必须都能在工具列表中找到（杜绝「规范让调、实际没注册」）
    const TOOL_VERBS = /^(get|list|draft|confirm|cancel|record|suggest|apply|preview|export|create|update|invoke|query)_/;
    const mentioned = [...tool.spec_markdown.matchAll(/`([a-z][a-z_]{3,})`/g)].map((m) => m[1]).filter((n) => TOOL_VERBS.test(n));
    expect(mentioned.length).toBeGreaterThanOrEqual(10); // 防止正则失效导致空集假通过
    const toolNames = new Set((await client.listTools()).tools.map((t) => t.name));
    expect(mentioned.filter((n) => !toolNames.has(n))).toEqual([]);
  });

  it('草案→预览→确认：透明排程、假设记录、确认幂等、取消无副作用', async () => {
    const plansBefore = arg(await client.callTool({ name: 'list_study_plans', arguments: {} })).data.count;
    const todosBefore = arg(await client.callTool({ name: 'list_todos', arguments: { status: 'all' } })).data.count;

    const draft = arg(
      await client.callTool({
        name: 'draft_study_plan',
        arguments: {
          title: '线性代数入门',
          goal: '为机器学习打线性代数基础',
          material_source: '《线性代数及其应用》第 1-2 章',
          daily_minutes: 120,
          start_date: '今天',
          knowledge_points: LINALG_POINTS,
        },
      }),
    ).data;
    expect(draft.status).toBe('draft');
    // 排程透明可验：D0 向量(60)，矩阵乘法(90) 放不下 → D1
    expect(draft.daily_schedule.map((i: any) => [i.knowledge_key, i.date])).toEqual([
      ['linalg-vectors', todayStr()],
      ['linalg-matrix-mult', addDays(todayStr(), 1)],
    ]);
    expect(draft.assumptions).toHaveLength(0);

    // 草案阶段：计划与待办数量不变（预览不写库）
    expect(arg(await client.callTool({ name: 'list_study_plans', arguments: {} })).data.count).toBe(plansBefore);
    expect(arg(await client.callTool({ name: 'list_todos', arguments: { status: 'all' } })).data.count).toBe(todosBefore);

    const confirmed = arg(await client.callTool({ name: 'confirm_study_plan_draft', arguments: { draft_id: draft.draft_id } })).data;
    expect(confirmed.item_count).toBe(2);
    expect(confirmed.todos_created).toBe(2);

    // 幂等：重复确认返回原计划，不重复创建
    const again = arg(await client.callTool({ name: 'confirm_study_plan_draft', arguments: { draft_id: draft.draft_id } })).data;
    expect(again.plan_id).toBe(confirmed.plan_id);
    expect(arg(await client.callTool({ name: 'list_study_plans', arguments: {} })).data.count).toBe(plansBefore + 1);

    // 取消链路：再建一个草案直接取消 → 无计划副作用
    const draft2 = arg(
      await client.callTool({ name: 'draft_study_plan', arguments: { title: '会被取消的草案', daily_minutes: 60, start_date: '今天', knowledge_points: [{ key: 'tmp-kp', name: '临时' }] } }),
    ).data;
    const cancelled = arg(await client.callTool({ name: 'cancel_study_plan_draft', arguments: { draft_id: draft2.draft_id } })).data;
    expect(cancelled.status).toBe('cancelled');
    expect(arg(await client.callTool({ name: 'list_study_plans', arguments: {} })).data.count).toBe(plansBefore + 1);
    const badConfirm = arg(await client.callTool({ name: 'confirm_study_plan_draft', arguments: { draft_id: draft2.draft_id } }));
    expect(badConfirm.ok).toBe(false);

    // 本体层同样可查（新对象类型注册）
    const meta = arg(await client.callTool({ name: 'list_object_types', arguments: {} })).data;
    expect(meta.objectTypes.map((t: any) => t.apiName)).toEqual(expect.arrayContaining(['study_plan_draft', 'study_session', 'study_assessment']));
  });

  it('会话与测评：稳定 id 幂等、多次尝试、纠正历史、客观必须带依据', async () => {
    const plans = arg(await client.callTool({ name: 'list_study_plans', arguments: {} })).data.plans;
    const planId = plans.find((p: any) => p.title === '线性代数入门').id;
    const detail = arg(await client.callTool({ name: 'get_study_plan', arguments: { id: planId } })).data;
    const todayItem = detail.items.find((i: any) => i.date === todayStr());
    expect(todayItem.knowledge_key).toBe('linalg-vectors');

    const s1 = arg(
      await client.callTool({
        name: 'record_study_session',
        arguments: {
          id: 'sess-linalg-a1',
          plan_id: planId,
          plan_item_id: todayItem.id,
          knowledge_key: 'linalg-vectors',
          topic: '向量与线性组合',
          actual_minutes: 35,
          explanation: '向量是有序数表；线性组合 = 用系数缩放一组向量再相加',
          questions: '零向量参与的组合还有意义吗？',
          material_source: '《线性代数及其应用》1.1',
        },
      }),
    ).data;
    expect(s1.attempt).toBe(1);

    // 同一稳定 id 重试 → 更新不重复
    arg(
      await client.callTool({
        name: 'record_study_session',
        arguments: { id: 'sess-linalg-a1', plan_item_id: todayItem.id, knowledge_key: 'linalg-vectors', actual_minutes: 40 },
      }),
    );
    expect(arg(await client.callTool({ name: 'list_study_sessions', arguments: { plan_item_id: todayItem.id } })).data).toHaveLength(1);

    // 第二次尝试（无 id 显式 attempt）
    const s2 = arg(
      await client.callTool({
        name: 'record_study_session',
        arguments: { plan_item_id: todayItem.id, knowledge_key: 'linalg-vectors', attempt: 2, actual_minutes: 20, explanation: '第二次：给同学讲了一遍基变换' },
      }),
    ).data;
    expect(s2.attempt).toBe(2);

    // 自评 40 → weak；同 id 纠正到 85 → strong，历史保留
    const a1 = arg(
      await client.callTool({
        name: 'record_study_assessment',
        arguments: { id: 'asm-linalg-1', session_id: 'sess-linalg-a1', knowledge_key: 'linalg-vectors', question: '解释线性组合并举例', criteria: '能脱稿说明并给出正确例子', answer: s1.session.explanation, source: 'self', score: 40, feedback: '讲得含糊，例子没给对', evidence: '自评：对照教材 1.1 例 3' },
      }),
    ).data;
    expect(a1.assessment_id).toBe('asm-linalg-1');
    let mastery = arg(await client.callTool({ name: 'get_mastery', arguments: { plan_id: planId } })).data;
    expect(mastery.entries.find((e: any) => e.knowledge_key === 'linalg-vectors').mastery).toBe('weak');
    expect(mastery.entries.find((e: any) => e.knowledge_key === 'linalg-matrix-mult').mastery).toBe('unknown'); // 无证据未知
    expect(mastery.plan_progress).toMatchObject({ total_items: 2, done_items: 0 });

    const a1b = arg(
      await client.callTool({
        name: 'record_study_assessment',
        arguments: { id: 'asm-linalg-1', session_id: 'sess-linalg-a1', knowledge_key: 'linalg-vectors', question: '解释线性组合并举例', answer: s1.session.explanation, source: 'self', score: 85, feedback: '重讲后补上了例子', evidence: '自评：能独立复述例 3' },
      }),
    ).data;
    expect(a1b.corrections).toHaveLength(1);
    expect(a1b.corrections[0]).toMatchObject({ from_score: 40, to_score: 85 });
    mastery = arg(await client.callTool({ name: 'get_mastery', arguments: { plan_id: planId } })).data;
    expect(mastery.entries.find((e: any) => e.knowledge_key === 'linalg-vectors').mastery).toBe('strong');

    // 客观测评缺依据被拒
    const bad = arg(
      await client.callTool({ name: 'record_study_assessment', arguments: { knowledge_key: 'linalg-vectors', question: '算 [1 2;3 4] 的行列式', answer: '-2', source: 'objective', score: 100, objective_passed: true } }),
    );
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('evidence');
  });

  it('调整：预览不写库 → 应用只动未完成并同步待办', async () => {
    // 构造：昨天开始的计划，昨天条目已完成但自评薄弱，今天条目先不改
    const T0 = todayStr();
    const Y = addDays(T0, -1);
    const draft = arg(
      await client.callTool({
        name: 'draft_study_plan',
        arguments: {
          title: '调整链路计划',
          daily_minutes: 120,
          start_date: Y,
          knowledge_points: [
            { key: 'adj-k1', name: '旧知识点', est_minutes: 60, outcome: '能复述' },
            { key: 'adj-k2', name: '新知识点', est_minutes: 60, outcome: '能复述' },
          ],
        },
      }),
    ).data;
    const { plan_id } = arg(await client.callTool({ name: 'confirm_study_plan_draft', arguments: { draft_id: draft.draft_id } })).data;
    const detail = arg(await client.callTool({ name: 'get_study_plan', arguments: { id: plan_id } })).data;
    const doneItem = detail.items.find((i: any) => i.knowledge_key === 'adj-k1'); // 昨天的条目
    const pendingItem = detail.items.find((i: any) => i.knowledge_key === 'adj-k2'); // 昨天排不下则今天，否则同日
    expect(doneItem.date).toBe(Y);
    arg(await client.callTool({ name: 'update_plan_item', arguments: { id: doneItem.id, status: 'done' } }));
    const adjSession = arg(
      await client.callTool({ name: 'record_study_session', arguments: { plan_item_id: doneItem.id, plan_id, knowledge_key: 'adj-k1', actual_minutes: 30, explanation: '学了但没底' } }),
    ).data;
    arg(await client.callTool({ name: 'record_study_assessment', arguments: { session_id: adjSession.session_id, knowledge_key: 'adj-k1', question: '复述旧知识点', answer: '……', source: 'self', score: 40 } }));

    // 预览：漏做(pending 且过期)改期 + 薄弱补复习；不写库（重复预览结果一致）
    const sugg = arg(await client.callTool({ name: 'suggest_plan_adjustments', arguments: { plan_id } })).data;
    const reschedule = sugg.suggestions.find((s: any) => s.kind === 'reschedule');
    const review = sugg.suggestions.find((s: any) => s.kind === 'add_review');
    expect(reschedule.item_id).toBe(pendingItem.id);
    expect(reschedule.reason).toContain('漏做');
    expect(review.knowledge_key).toBe('adj-k1');
    expect(review.reason).toContain('自评 40');
    const again = arg(await client.callTool({ name: 'suggest_plan_adjustments', arguments: { plan_id } })).data;
    expect(again.suggestions.map((s: any) => s.id).sort()).toEqual(sugg.suggestions.map((s: any) => s.id).sort());

    // 只应用改期建议：未完成条目改到今天，待办截止同步；已完成条目不动
    const applied = arg(await client.callTool({ name: 'apply_plan_adjustments', arguments: { plan_id, suggestions: [{ id: reschedule.id, to_date: reschedule.to_date }] } })).data;
    expect(applied.applied).toHaveLength(1);
    expect(applied.todos_synced).toBe(1);
    const after = arg(await client.callTool({ name: 'get_study_plan', arguments: { id: plan_id } })).data;
    const moved = after.items.find((i: any) => i.id === pendingItem.id);
    expect(moved.date).toBe(T0);
    if (moved.todo_id != null) {
      const todo = arg(await client.callTool({ name: 'list_todos', arguments: { status: 'all' } })).data.todos.find((t: any) => t.id === moved.todo_id);
      expect(todo.due_date).toBe(T0);
    }
    expect(after.items.find((i: any) => i.id === doneItem.id)).toMatchObject({ status: 'done', date: Y });

    // 再应用补复习建议：新增复习条目与待办
    const applied2 = arg(await client.callTool({ name: 'apply_plan_adjustments', arguments: { plan_id, suggestions: [{ id: review.id, to_date: review.to_date }] } })).data;
    expect(applied2.applied).toHaveLength(1);
    const after2 = arg(await client.callTool({ name: 'get_study_plan', arguments: { id: plan_id } })).data;
    const reviewItem = after2.items.find((i: any) => i.item_type === 'review' && i.knowledge_key === 'adj-k1');
    expect(reviewItem.date).toBe(addDays(T0, 1));
    expect(reviewItem.todo_id).not.toBeNull();

    // 过期建议再应用 → 跳过并说明
    const stale = arg(await client.callTool({ name: 'apply_plan_adjustments', arguments: { plan_id, suggestions: [{ id: reschedule.id, to_date: reschedule.to_date }] } })).data;
    expect(stale.applied).toHaveLength(0);
    expect(stale.skipped[0].reason).toContain('不存在或已失效');
  });

  it('卡片：预览不落盘 → 导出防重 → 保护人工编辑 → 导出记录可查', async () => {
    const cardsDir = join(dbDir, 'study-cards');
    const preview = arg(await client.callTool({ name: 'preview_study_cards', arguments: { knowledge_keys: ['linalg-vectors'] } })).data;
    expect(preview.count).toBe(2); // 两次尝试各一张
    const card = preview.cards.find((c: any) => c.session_id === 'sess-linalg-a1');
    expect(card.markdown).toContain('status: draft');
    expect(card.markdown).toContain('verified: false');
    expect(card.markdown).toContain('assessed: "self:85"');
    expect(existsSync(cardsDir)).toBe(false); // 预览不落盘

    const exported = arg(await client.callTool({ name: 'export_study_cards', arguments: { session_ids: ['sess-linalg-a1'], export_dir: cardsDir } })).data;
    expect(exported.exported).toBe(1);
    const filePath = join(cardsDir, card.file_name);
    expect(readFileSync(filePath, 'utf8')).toContain('待审卡片');

    // 幂等：内容一致 → skipped
    const again = arg(await client.callTool({ name: 'export_study_cards', arguments: { session_ids: ['sess-linalg-a1'], export_dir: cardsDir } })).data;
    expect(again.skipped).toBe(1);

    // 人工编辑后 → protected 不覆盖
    writeFileSync(filePath, '# 我人工改过了\n', 'utf8');
    const third = arg(await client.callTool({ name: 'export_study_cards', arguments: { session_ids: ['sess-linalg-a1'], export_dir: cardsDir } })).data;
    expect(third.protected).toBe(1);
    expect(readFileSync(filePath, 'utf8')).toContain('我人工改过了');

    const history = arg(await client.callTool({ name: 'list_card_exports', arguments: {} })).data;
    expect(history.some((h: any) => h.card_key === card.card_key)).toBe(true);
  });
});

describe('无日期专题草案（agent 视角：专题文稿先存后排期）', () => {
  const POINTS = [
    { key: 'rust-basics', name: 'Rust 基础概念', est_minutes: 60, outcome: '能说清 Rust 的定位与典型用法' },
    { key: 'rust-advanced', name: 'Rust 进阶实践', est_minutes: 90, outcome: '能独立完成一次进阶操作', depends_on: ['rust-basics'] },
  ];

  it('先存后排期全链路：创建零副作用 → 样课关联 → 更新 → 预览 → 幂等排期 → 确认生成计划', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    // 未确认样课的课程：先导入样课包（不确认，样课门禁保持）
    const stage = mkdtempSync(join(dbDir, 'td-topic-stage-'));
    mkdirSync(join(stage, 'lessons'), { recursive: true });
    writeFileSync(join(stage, 'lessons', 'd1.html'), '<h1>Rust 样课</h1><p>样课正文</p>');
    writeFileSync(join(stage, 'course.json'), JSON.stringify({
      slug: 'rust-topic-e2e',
      title: 'Rust 专题课',
      version: '1.0.0',
      lessons: [{ day: 1, title: '第一天', html: 'lessons/d1.html', is_sample: true }],
    }));
    const course = arg(await client.callTool({ name: 'import_course', arguments: { staging_dir: stage } })).data;
    expect(course.status).toBe('imported'); // 样课尚未确认，仍可关联草案

    const plansBefore = arg(await client.callTool({ name: 'list_study_plans', arguments: {} })).data.count;
    const todosBefore = arg(await client.callTool({ name: 'list_todos', arguments: { status: 'all' } })).data.count;

    // 1) 创建无日期草案：不排日程、不产待办、不占预算
    const d = arg(
      await client.callTool({
        name: 'draft_study_topic',
        arguments: {
          title: 'Rust 专题：文稿一',
          goal: '吃透文稿一',
          material_source: 'Rust 专题文稿（日期待排期、未确认）',
          knowledge_points: POINTS,
          course_id: course.course_id,
        },
      }),
    ).data;
    expect(d.scheduled).toBe(false);
    expect(d.draft.start_date).toBeNull();
    expect(d.draft.end_date).toBeNull();
    expect(d.draft.daily_minutes).toBeNull();
    expect(d.draft.items).toEqual([]);
    expect(d.draft.course_id).toBe(course.course_id);
    expect(arg(await client.callTool({ name: 'list_study_plans', arguments: {} })).data.count).toBe(plansBefore);
    expect(arg(await client.callTool({ name: 'list_todos', arguments: { status: 'all' } })).data.count).toBe(todosBefore);

    // 2) 内容可更新（未排期时）
    const upd = arg(await client.callTool({ name: 'update_study_topic_draft', arguments: { draft_id: d.draft_id, notes: '已复核文稿一' } })).data;
    expect(upd.draft.notes).toBe('已复核文稿一');

    // 3) 排期预览（只读）：选远离其他用例计划（复习 D+21 等）的干净区间，无冲突无预警；依赖顺序先修在前
    const D0 = addDays(todayStr(), 40);
    const prev = arg(
      await client.callTool({ name: 'preview_study_draft_schedule', arguments: { draft_id: d.draft_id, start_date: D0, daily_minutes: 120 } }),
    ).data;
    expect(prev.items.map((i: any) => i.knowledge_key)).toEqual(['rust-basics', 'rust-advanced']);
    expect(prev.ordered_keys).toEqual(['rust-basics', 'rust-advanced']);
    expect(prev.warnings).toEqual([]);
    expect(prev.conflicts).toEqual([]);
    // 预览不写库：草案仍未排期
    const peek = arg(await client.callTool({ name: 'get_study_draft', arguments: { id: d.draft_id } })).data;
    expect(peek.start_date).toBeNull();
    expect(peek.items).toEqual([]);

    // 4) 事务排期 + 重复提交幂等
    const sched = arg(await client.callTool({ name: 'schedule_study_draft', arguments: { draft_id: d.draft_id, start_date: D0, daily_minutes: 120 } })).data;
    expect(sched.item_count).toBe(2);
    expect(sched.date_range).toBe(`${D0} ~ ${addDays(D0, 1)}`);
    const schedAgain = arg(await client.callTool({ name: 'schedule_study_draft', arguments: { draft_id: d.draft_id, start_date: D0, daily_minutes: 120 } })).data;
    expect(schedAgain.item_count).toBe(2);
    const after = arg(await client.callTool({ name: 'get_study_draft', arguments: { id: d.draft_id } })).data;
    expect(after.items).toHaveLength(2); // 幂等：不重复产生条目
    expect(after.start_date).toBe(D0);

    // 5) 确认生成计划与待办（旧确认门禁不变）
    const confirmed = arg(await client.callTool({ name: 'confirm_study_plan_draft', arguments: { draft_id: d.draft_id } })).data;
    expect(confirmed.item_count).toBe(2);
    expect(confirmed.todos_created).toBe(2);
    expect(arg(await client.callTool({ name: 'list_study_plans', arguments: {} })).data.count).toBe(plansBefore + 1);
    // 确认后拒绝再排期
    const badSched = arg(await client.callTool({ name: 'schedule_study_draft', arguments: { draft_id: d.draft_id, start_date: D0, daily_minutes: 60 } }));
    expect(badSched.ok).toBe(false);

    // 样课确认门禁不变：MCP 工具列表里没有确认样课的工具（只有 App 用户可确认）
    const toolNames = (await client.listTools()).tools.map((t) => t.name);
    expect(toolNames.filter((n) => n.includes('sample'))).toEqual([]);
  });

  it('预算冲突硬校验全链路：预览 → 不带确认集被拒 → 带集排期 → 确认被拒 → 带集确认', async () => {
    const D0 = addDays(todayStr(), 10);
    // 既有 active 计划：D0 已排 90 分钟，且含 knowledge_key 'rust2-basics' 的未完成条目
    const exist = arg(
      await client.callTool({
        name: 'draft_study_plan',
        arguments: {
          title: '既有占用计划',
          daily_minutes: 120,
          start_date: D0,
          knowledge_points: [{ key: 'rust2-basics', name: '既有基础', est_minutes: 90, outcome: '既有成果' }],
        },
      }),
    ).data;
    await client.callTool({ name: 'confirm_study_plan_draft', arguments: { draft_id: exist.draft_id } });

    const d = arg(
      await client.callTool({
        name: 'draft_study_topic',
        arguments: {
          title: 'Rust 专题：文稿二',
          knowledge_points: [
            { key: 'rust2-basics', name: '基础（与既有计划重复）', est_minutes: 60, outcome: '成果' },
            { key: 'rust2-advanced', name: '进阶', est_minutes: 60, outcome: '成果', depends_on: ['rust2-basics'] },
          ],
        },
      }),
    ).data;
    const prev = arg(await client.callTool({ name: 'preview_study_draft_schedule', arguments: { draft_id: d.draft_id, start_date: D0, daily_minutes: 120 } })).data;
    const firstDay = prev.conflicts.find((c: any) => c.date === D0);
    // 60+60=120 同日装箱：当日新排 120 分钟，叠加既有 90 → 超出预算预警
    expect(firstDay).toMatchObject({ existing_minutes: 90, new_minutes: 120, over_budget: true });
    expect(prev.over_budget_dates).toEqual([D0]);
    expect(prev.duplicate_knowledge_keys).toEqual([
      { knowledge_key: 'rust2-basics', plan_id: expect.any(Number), plan_title: '既有占用计划' },
    ]);
    expect(prev.warnings.join('\n')).toContain('预算冲突');
    expect(prev.warnings.join('\n')).toContain('知识点重复');

    // 排期硬校验：服务层按当下重算，不带确认集（服务层可绕过 UI 提示也不行）
    const schedNoConfirm = arg(await client.callTool({ name: 'schedule_study_draft', arguments: { draft_id: d.draft_id, start_date: D0, daily_minutes: 120 } }));
    expect(schedNoConfirm.ok).toBe(false);
    expect(String(schedNoConfirm.error)).toContain('预算冲突硬校验失败');
    // 带过期确认集（空集）同样拒绝
    const schedStale = arg(await client.callTool({ name: 'schedule_study_draft', arguments: { draft_id: d.draft_id, start_date: D0, daily_minutes: 120, confirmed_over_dates: [] } }));
    expect(schedStale.ok).toBe(false);
    // 带最新确认集（预览的 over_budget_dates 原样传回）→ 排期成功
    const sched = arg(
      await client.callTool({ name: 'schedule_study_draft', arguments: { draft_id: d.draft_id, start_date: D0, daily_minutes: 120, confirmed_over_dates: prev.over_budget_dates } }),
    ).data;
    expect(sched.item_count).toBe(2);

    // 确认边界硬校验：确认时重算仍有冲突，不带集拒绝；带当下重算集通过
    const confirmNoSet = arg(await client.callTool({ name: 'confirm_study_plan_draft', arguments: { draft_id: d.draft_id } }));
    expect(confirmNoSet.ok).toBe(false);
    expect(String(confirmNoSet.error)).toContain('预算冲突硬校验失败');
    const rePrev = arg(await client.callTool({ name: 'preview_study_draft_schedule', arguments: { draft_id: d.draft_id, start_date: D0, daily_minutes: 120 } })).data;
    const confirmed = arg(
      await client.callTool({ name: 'confirm_study_plan_draft', arguments: { draft_id: d.draft_id, confirmed_over_dates: rePrev.over_budget_dates } }),
    ).data;
    expect(confirmed.item_count).toBe(2);
    expect(confirmed.todos_created).toBe(2);

    // 取消后预览拒绝（独立草案验证，已确认草案不能取消）
    const other = arg(await client.callTool({ name: 'draft_study_topic', arguments: { title: '会被取消的专题', knowledge_points: POINTS } })).data;
    await client.callTool({ name: 'cancel_study_plan_draft', arguments: { draft_id: other.draft_id } });
    const badPrev = arg(await client.callTool({ name: 'preview_study_draft_schedule', arguments: { draft_id: other.draft_id, start_date: D0, daily_minutes: 120 } }));
    expect(badPrev.ok).toBe(false);
  });

  it('App 确认流程同构：确认前取最新冲突 → 弹窗期间冲突变化带旧集被拒 → 刷新后带最新集通过', async () => {
    // e2e 共库：从远期候选中找一个当前完全无超预算冲突的干净起始日（找不到即失败，避免偶发碰撞）
    let D0 = '';
    let schedPrev: any = null;
    const d = arg(
      await client.callTool({
        name: 'draft_study_topic',
        arguments: { title: 'Rust 专题：确认窗口', knowledge_points: [{ key: 'win-kp', name: '确认窗口知识点', est_minutes: 120, outcome: '成果' }] },
      }),
    ).data;
    for (const off of [60, 100, 140, 180, 220]) {
      const cand = addDays(todayStr(), off);
      const p = arg(await client.callTool({ name: 'preview_study_draft_schedule', arguments: { draft_id: d.draft_id, start_date: cand, daily_minutes: 120 } })).data;
      if (p.over_budget_dates.length === 0 && !p.conflicts.some((c: any) => c.date === cand && c.existing_minutes > 0)) {
        D0 = cand;
        schedPrev = p;
        break;
      }
    }
    expect(D0).not.toBe('');
    // 排期：干净区间，带空确认集
    await client.callTool({ name: 'schedule_study_draft', arguments: { draft_id: d.draft_id, start_date: D0, daily_minutes: 120, confirmed_over_dates: schedPrev.over_budget_dates } });

    // App 语义：点「确认生成计划」先取当下最新冲突集，弹窗列出并由用户同意
    const atConfirm = arg(await client.callTool({ name: 'preview_study_draft_schedule', arguments: { draft_id: d.draft_id, start_date: D0, daily_minutes: 120 } })).data;
    expect(atConfirm.over_budget_dates).toEqual([]);
    // 用户停留在弹窗期间：另一进程（App ↔ MCP 共库）新增同日占用
    const occ = arg(
      await client.callTool({
        name: 'create_study_plan',
        arguments: { title: '弹窗期间新增占用', start_date: D0, items: [{ date: D0, content: '占用 90 分钟', duration_min: 90 }] },
      }),
    ).data;
    expect(occ.plan_id).toBeGreaterThan(0);
    // 带弹窗时看到的旧确认集（空集）确认 → 服务端按当下重算拒绝，绝不自动默认同意
    const stale = arg(await client.callTool({ name: 'confirm_study_plan_draft', arguments: { draft_id: d.draft_id, confirmed_over_dates: atConfirm.over_budget_dates } }));
    expect(stale.ok).toBe(false);
    expect(String(stale.error)).toContain('预算冲突硬校验失败');
    // 引导刷新：重新预览取最新集，用户对冲突显式同意后带精确集合确认 → 通过
    const fresh = arg(await client.callTool({ name: 'preview_study_draft_schedule', arguments: { draft_id: d.draft_id, start_date: D0, daily_minutes: 120 } })).data;
    expect(fresh.over_budget_dates).toEqual([D0]);
    const confirmed = arg(
      await client.callTool({ name: 'confirm_study_plan_draft', arguments: { draft_id: d.draft_id, confirmed_over_dates: fresh.over_budget_dates } }),
    ).data;
    expect(confirmed.item_count).toBe(1);
  });

  it('旧路径豁免（明确限定）：draft_study_plan 创建即排期的草案确认不设冲突门', async () => {
    const D0 = addDays(todayStr(), 12);
    // 同日先落一个占用计划（agent 视角：既有安排）
    const occ = arg(
      await client.callTool({
        name: 'create_study_plan',
        arguments: { title: '豁免用占用计划', start_date: D0, items: [{ date: D0, content: '占用 90 分钟', duration_min: 90 }] },
      }),
    ).data;
    expect(occ.plan_id).toBeGreaterThan(0);
    // 旧路径草案：同日叠加排期并直接确认——不因冲突门被拒（历史行为保持；新排期路径的校验不受影响）
    const dated = arg(
      await client.callTool({
        name: 'draft_study_plan',
        arguments: { title: '旧路径同日草案', daily_minutes: 120, start_date: D0, knowledge_points: [{ key: 'legacy-kp', name: '旧知识点', est_minutes: 120, outcome: '成果' }] },
      }),
    ).data;
    const confirmed = arg(await client.callTool({ name: 'confirm_study_plan_draft', arguments: { draft_id: dated.draft_id } })).data;
    expect(confirmed.ok !== false).toBe(true);
    expect(confirmed.item_count).toBe(1);
  });

  it('未排期不能确认；依赖环在创建时即报错；课程不存在拒绝关联', async () => {
    const d = arg(
      await client.callTool({
        name: 'draft_study_topic',
        arguments: { title: 'Rust 专题：文稿三', knowledge_points: POINTS },
      }),
    ).data;
    const badConfirm = arg(await client.callTool({ name: 'confirm_study_plan_draft', arguments: { draft_id: d.draft_id } }));
    expect(badConfirm.ok).toBe(false);
    expect(String(badConfirm.error)).toContain('尚未排期');

    const badCycle = arg(
      await client.callTool({
        name: 'draft_study_topic',
        arguments: {
          title: '环依赖专题',
          knowledge_points: [
            { key: 'cyc-a', name: 'A', depends_on: ['cyc-b'] },
            { key: 'cyc-b', name: 'B', depends_on: ['cyc-a'] },
          ],
        },
      }),
    );
    expect(badCycle.ok).toBe(false);
    expect(String(badCycle.error)).toContain('依赖存在环');

    const badCourse = arg(
      await client.callTool({ name: 'draft_study_topic', arguments: { title: '坏关联', knowledge_points: POINTS, course_id: 99999 } }),
    );
    expect(badCourse.ok).toBe(false);
    expect(String(badCourse.error)).toContain('关联课程 99999 不存在');
  });
});

describe('学习闭环：依赖联动的调整（终验回归）', () => {
  it('漏做前置时后继联动顺延且不早于前置；快照应用同步待办；旧快照重放被拒', async () => {
    const T0 = todayStr();
    const draft = arg(
      await client.callTool({
        name: 'draft_study_plan',
        arguments: {
          title: '依赖链路计划',
          daily_minutes: 60,
          start_date: addDays(T0, -1),
          knowledge_points: [
            { key: 'dep-a', name: '前置知识点', est_minutes: 60, outcome: '能解释 A' },
            { key: 'dep-b', name: '后继知识点', depends_on: ['dep-a'], est_minutes: 60, outcome: '能解释 B' },
          ],
        },
      }),
    ).data;
    const { plan_id } = arg(await client.callTool({ name: 'confirm_study_plan_draft', arguments: { draft_id: draft.draft_id } })).data;
    const detail = arg(await client.callTool({ name: 'get_study_plan', arguments: { id: plan_id } })).data;
    const a = detail.items.find((i: any) => i.knowledge_key === 'dep-a');
    const b = detail.items.find((i: any) => i.knowledge_key === 'dep-b');
    expect(a.date).toBe(addDays(T0, -1));
    expect(b.date).toBe(T0);

    const sugg = arg(await client.callTool({ name: 'suggest_plan_adjustments', arguments: { plan_id } })).data;
    const sa = sugg.suggestions.find((s: any) => s.item_id === a.id);
    const sb = sugg.suggestions.find((s: any) => s.item_id === b.id);
    expect(sa.to_date).toBe(addDays(T0, 1)); // 今天被 B 占满（预算 60）→ A 顺延明天
    expect(sb.to_date).toBe(addDays(T0, 2)); // 依赖联动 → B 不早于前置生效日期，后天
    expect(sb.reason).toContain('依赖联动');
    expect(sb.to_date > sa.to_date).toBe(true);

    const applied = arg(
      await client.callTool({
        name: 'apply_plan_adjustments',
        arguments: { plan_id, suggestions: [{ id: sa.id, to_date: sa.to_date }, { id: sb.id, to_date: sb.to_date }] },
      }),
    ).data;
    expect(applied.applied).toHaveLength(2);
    expect(applied.todos_synced).toBe(2); // A、B 各自关联待办截止日同步
    const after = arg(await client.callTool({ name: 'get_study_plan', arguments: { id: plan_id } })).data;
    expect(after.items.find((i: any) => i.id === a.id).date).toBe(addDays(T0, 1));
    expect(after.items.find((i: any) => i.id === b.id).date).toBe(addDays(T0, 2));
    const todoA = after.items.find((i: any) => i.id === a.id).todo_id;
    if (todoA != null) {
      const todo = arg(await client.callTool({ name: 'list_todos', arguments: { status: 'all' } })).data.todos.find((t: any) => t.id === todoA);
      expect(todo.due_date).toBe(addDays(T0, 1));
    }

    // 旧快照重放：建议已消费 → 拒绝并说明，不重复执行
    const stale = arg(await client.callTool({ name: 'apply_plan_adjustments', arguments: { plan_id, suggestions: [{ id: sa.id, to_date: sa.to_date }] } })).data;
    expect(stale.applied).toHaveLength(0);
    expect(stale.skipped[0].reason).toContain('不存在或已失效');
  });
});

describe('学习闭环：依赖组完整性（部分应用保护）', () => {
  it('只勾选前置改期被整组拒绝（计划不变）；勾齐联动建议后原子生效', async () => {
    const T0 = todayStr();
    const draft = arg(
      await client.callTool({
        name: 'draft_study_plan',
        arguments: {
          title: '部分确认保护',
          daily_minutes: 60,
          start_date: addDays(T0, -1),
          knowledge_points: [
            { key: 'pg-a', name: '前置甲', est_minutes: 60, outcome: '能解释 A' },
            { key: 'pg-b', name: '后继乙', depends_on: ['pg-a'], est_minutes: 60, outcome: '能解释 B' },
          ],
        },
      }),
    ).data;
    const { plan_id } = arg(await client.callTool({ name: 'confirm_study_plan_draft', arguments: { draft_id: draft.draft_id } })).data;
    const before = arg(await client.callTool({ name: 'get_study_plan', arguments: { id: plan_id } })).data;
    const a = before.items.find((i: any) => i.knowledge_key === 'pg-a');
    const b = before.items.find((i: any) => i.knowledge_key === 'pg-b');

    const sugg = arg(await client.callTool({ name: 'suggest_plan_adjustments', arguments: { plan_id } })).data;
    const sa = sugg.suggestions.find((s: any) => s.item_id === a.id);
    const sb = sugg.suggestions.find((s: any) => s.item_id === b.id);

    // 只应用前置：被依赖组完整性拒绝，计划保持原状（后继不早于前置的不变量不被破坏）
    const partial = arg(
      await client.callTool({ name: 'apply_plan_adjustments', arguments: { plan_id, suggestions: [{ id: sa.id, to_date: sa.to_date }] } }),
    ).data;
    expect(partial.applied).toHaveLength(0);
    expect(partial.skipped[0].reason).toContain('不完整勾选');
    const unchanged = arg(await client.callTool({ name: 'get_study_plan', arguments: { id: plan_id } })).data;
    expect(unchanged.items.find((i: any) => i.id === a.id).date).toBe(a.date);
    expect(unchanged.items.find((i: any) => i.id === b.id).date).toBe(b.date);

    // 勾齐前置 + 后继联动：原子应用，先修顺序保持
    const full = arg(
      await client.callTool({ name: 'apply_plan_adjustments', arguments: { plan_id, suggestions: [{ id: sa.id, to_date: sa.to_date }, { id: sb.id, to_date: sb.to_date }] } }),
    ).data;
    expect(full.applied).toHaveLength(2);
    const after = arg(await client.callTool({ name: 'get_study_plan', arguments: { id: plan_id } })).data;
    const aNow = after.items.find((i: any) => i.id === a.id).date;
    const bNow = after.items.find((i: any) => i.id === b.id).date;
    expect(aNow).toBe(sa.to_date);
    expect(bNow).toBe(sb.to_date);
    expect(bNow > aNow).toBe(true);
  });
});

describe('新闻任务边界（租约接管与预算累计）', () => {
  it('认领租约：过期后旧令牌失效、他人可接管接力；预算跨认领累计不重置', async () => {
    const freshItem = (n: number) => ({
      title: `e2e 租约新闻 ${n}`,
      summary: `租约摘要 ${n}。`,
      source_url: `https://example.com/e2e-lease-${n}`,
      published_at: new Date(Date.now() - 3600_000).toISOString(),
    });
    // 预算 3：首个会话提交 2 条后失联
    const task = arg(await client.callTool({ name: 'create_news_task', arguments: { title: 'e2e：租约任务', max_items: 3 } })).data;
    const a = arg(await client.callTool({ name: 'claim_news_task', arguments: { task_id: task.id, claimed_by: 'session-a' } })).data;
    expect(arg(await client.callTool({ name: 'submit_news_items', arguments: { task_id: task.id, claim_token: a.claim_token, items: [freshItem(1), freshItem(2)] } })).data.inserted).toBe(2);

    // 模拟执行方失联 30 分钟（租约过期）：直接改库（与 App/MCP 共库的其他进程视角一致）
    {
      const db = new DatabaseSync(join(dbDir, 'e2e.db'));
      try {
        db.exec(`UPDATE news_tasks SET claim_expires_at = '2000-01-01T00:00:00.000' WHERE id = ${task.id}`);
      } finally {
        db.close();
      }
    }
    // 旧令牌提交被拒（认领已过期）
    const stale = await client.callTool({ name: 'submit_news_items', arguments: { task_id: task.id, claim_token: a.claim_token, items: [freshItem(3)] } });
    expect(arg(stale).error).toContain('过期');
    // 他人接管：attempts=2；预算沿用已入库 2 条 → 再提交 2 条超限整批拒，恰好 1 条可以
    const b = arg(await client.callTool({ name: 'claim_news_task', arguments: { task_id: task.id, claimed_by: 'session-b' } })).data;
    expect(b.task.attempts).toBe(2);
    expect(b.task.inserted_count).toBe(2);
    const over = await client.callTool({ name: 'submit_news_items', arguments: { task_id: task.id, claim_token: b.claim_token, items: [freshItem(3), freshItem(4)] } });
    expect(arg(over).error).toContain('预算');
    expect(arg(await client.callTool({ name: 'submit_news_items', arguments: { task_id: task.id, claim_token: b.claim_token, items: [freshItem(5)] } })).data.task.inserted_count).toBe(3);
    expect(arg(await client.callTool({ name: 'complete_news_task', arguments: { task_id: task.id, claim_token: b.claim_token, note: '接力完成' } })).data.status).toBe('completed');
  });
});

describe('教学课程（MCP 主链路）', () => {
  it('import → lessons → quiz → 确认前置拒绝 → 确认 → 请求 → claim → 完整包 → complete', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    // d1 引用包内样式表：导入时应内联为消毒 <style>（离线自包含，排版保留）；完整包逐字节一致防哈希漂移
    const D1_RAW = '<h1>Day 1</h1><p>安全正文</p><script>alert(1)</script><link rel="stylesheet" href="../assets/style.css">';
    const D1_CSS = ':root{--e2e-ink:#10254d}.lesson-banner{color:#fff}';
    const stage = mkdtempSync(join(dbDir, 'td-course-e2e-'));
    mkdirSync(join(stage, 'lessons'), { recursive: true });
    mkdirSync(join(stage, 'assets'), { recursive: true });
    writeFileSync(join(stage, 'assets', 'style.css'), D1_CSS);
    writeFileSync(join(stage, 'lessons', 'd1.html'), D1_RAW);
    writeFileSync(join(stage, 'overview.html'), '<h1>课程路线</h1><p>总览独立于第一天</p><script>alert(1)</script>');
    writeFileSync(join(stage, 'course.json'), JSON.stringify({
      schema_version: 2,
      slug: 'e2e-course', title: 'E2E 课程', version: '1.0.0',
      overview: { html: 'overview.html' },
      lessons: [{ day: 1, title: '第一天', html: 'lessons/d1.html', is_sample: true, quiz: [{ question: '1+1', options: ['1', '2'], answer_index: 1, explanation: '算术' }] }],
    }));
    // 1. 导入
    const imp = arg(await client.callTool({ name: 'import_course', arguments: { staging_dir: stage } })).data;
    expect(imp.slug).toBe('e2e-course');
    expect(imp.lessons[0].is_sample).toBe(true);
    expect(imp.lessons).toHaveLength(1); // 样课包只含样课一天，不会多生成其他天
    expect(imp.has_overview).toBe(true);
    const cid = imp.course_id;
    const courseOverview = arg(await client.callTool({ name: 'get_course_overview', arguments: { course_id: cid } })).data;
    expect(courseOverview.html).toContain('总览独立于第一天');
    expect(courseOverview.html).not.toContain('<script');
    const listed = arg(await client.callTool({ name: 'list_courses', arguments: {} })).data;
    expect(listed.find((c: { id: number }) => c.id === cid).has_overview).toBe(true);
    // 2. 读讲义（已消毒 + 包内样式已内联）
    const html = arg(await client.callTool({ name: 'get_lesson_html', arguments: { course_id: cid, day: 1 } })).data;
    expect(html.html).not.toContain('<script');
    expect(html.html).not.toContain('<link');
    expect(html.html).toContain('内联自课程包 assets/style.css');
    expect(html.html).toContain('--e2e-ink');
    // 3. 答题
    const quiz = arg(await client.callTool({ name: 'submit_lesson_quiz', arguments: { course_id: cid, day: 1, answers: [{ question_id: 'q1', picked: 1 }] } })).data;
    expect(quiz.quiz_answers).toHaveLength(1);
    // 4. 未确认 → 创建请求被拒
    const denied = arg(await client.callTool({ name: 'create_course_request', arguments: { course_id: cid } }));
    expect(denied.ok).toBe(false);
    // 5. 用户在 App 确认（MCP 无确认工具——此处直写临时库模拟 App 动作）→ 请求 → 认领
    confirmSampleAsApp(cid);
    const req = arg(await client.callTool({ name: 'create_course_request', arguments: { course_id: cid, requested_by: 'e2e' } })).data;
    expect(req.status).toBe('pending');
    const claimed = arg(await client.callTool({ name: 'claim_course_request', arguments: { request_id: req.id, claimed_by: 'e2e-agent' } })).data;
    expect(claimed.status).toBe('claimed');
    // 6. 完整包导入 → complete（d1 与样课逐字节一致，含同一样式表）
    const full = mkdtempSync(join(dbDir, 'td-course-full-'));
    mkdirSync(join(full, 'lessons'), { recursive: true });
    mkdirSync(join(full, 'assets'), { recursive: true });
    writeFileSync(join(full, 'assets', 'style.css'), D1_CSS);
    writeFileSync(join(full, 'lessons', 'd1.html'), D1_RAW);
    writeFileSync(join(full, 'lessons', 'd2.html'), '<h1>Day 2</h1>');
    writeFileSync(join(full, 'overview.html'), '<h1>课程路线</h1><p>总览独立于第一天</p><script>alert(1)</script>');
    writeFileSync(join(full, 'course.json'), JSON.stringify({
      schema_version: 2,
      slug: 'e2e-course', title: 'E2E 课程', version: '1.1.0',
      overview: { html: 'overview.html' },
      lessons: [{ day: 1, title: '第一天', html: 'lessons/d1.html', is_sample: true }, { day: 2, title: '第二天', html: 'lessons/d2.html' }],
    }));
    const impFull = arg(await client.callTool({ name: 'import_course', arguments: { staging_dir: full } })).data;
    expect(impFull.lessons).toHaveLength(2);
    const done = arg(await client.callTool({ name: 'complete_course_request', arguments: { request_id: req.id, claimed_by: 'e2e-agent' } })).data;
    expect(done.status).toBe('done');
    // 7. 队列查询（agent 发现入口）
    const reqs = arg(await client.callTool({ name: 'list_course_requests', arguments: {} })).data;
    expect(reqs[0].course_id).toBe(cid);
    rmSync(stage, { recursive: true, force: true });
    rmSync(full, { recursive: true, force: true });
  });

  it('完整包不绕过确认与请求：首导/未认领导入被拒；确认工具不暴露；quiz 选项越界拒绝；plan_id 不存在拒绝', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    // 工具清单不得暴露样课确认（用户亲自动作，agent 不得代确认）
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('confirm_sample_lesson');

    // 首导完整包（无既有课程，无论是否带样课标记）→ 拒绝：课程必须从样课包开始
    const mkFreshFull = (slug: string, withSample: boolean) => {
      const full = mkdtempSync(join(dbDir, 'td-course-fresh-full-'));
      mkdirSync(join(full, 'lessons'), { recursive: true });
      writeFileSync(join(full, 'lessons', 'd1.html'), '<h1>Fresh 1</h1>');
      writeFileSync(join(full, 'lessons', 'd2.html'), '<h1>Fresh 2</h1>');
      writeFileSync(join(full, 'course.json'), JSON.stringify({
        slug, title: '首导完整包', version: '1.0.0',
        lessons: [
          { day: 1, title: '第一天', html: 'lessons/d1.html', ...(withSample ? { is_sample: true } : {}) },
          { day: 2, title: '第二天', html: 'lessons/d2.html' },
        ],
      }));
      return full;
    };
    const freshA = arg(await client.callTool({ name: 'import_course', arguments: { staging_dir: mkFreshFull('fresh-full-a', true) } }));
    expect(freshA.ok).toBe(false);
    expect(freshA.error).toContain('完整包导入被拒');
    const freshB = arg(await client.callTool({ name: 'import_course', arguments: { staging_dir: mkFreshFull('fresh-full-b', false) } }));
    expect(freshB.ok).toBe(false);
    expect(freshB.error).toContain('样课包');

    // 样课导入
    const stage = mkdtempSync(join(dbDir, 'td-course-gate-'));
    mkdirSync(join(stage, 'lessons'), { recursive: true });
    writeFileSync(join(stage, 'lessons', 'd1.html'), '<h1>Gate Day 1</h1><p>安全正文</p>');
    writeFileSync(join(stage, 'course.json'), JSON.stringify({
      slug: 'gate-course', title: '门槛课程', version: '1.0.0',
      lessons: [{ day: 1, title: '第一天', html: 'lessons/d1.html', is_sample: true, quiz: [{ question: '1+1', options: ['1', '2'], answer_index: 1, explanation: '算术' }] }],
    }));
    const imp = arg(await client.callTool({ name: 'import_course', arguments: { staging_dir: stage } })).data;
    const cid = imp.course_id;
    expect(imp.has_overview).toBe(false);
    expect(arg(await client.callTool({ name: 'get_course_overview', arguments: { course_id: cid } })).data).toBeNull();

    // 已确认但未认领 → 直接导完整包仍被拒（不能绕过请求队列）
    confirmSampleAsApp(cid);
    const mkFull = (v: string) => {
      const full = mkdtempSync(join(dbDir, 'td-course-gate-full-'));
      mkdirSync(join(full, 'lessons'), { recursive: true });
      writeFileSync(join(full, 'lessons', 'd1.html'), '<h1>Gate Day 1</h1><p>安全正文</p>');
      writeFileSync(join(full, 'lessons', 'd2.html'), '<h1>Gate Day 2</h1>');
      writeFileSync(join(full, 'course.json'), JSON.stringify({
        slug: 'gate-course', title: '门槛课程', version: v,
        lessons: [{ day: 1, title: '第一天', html: 'lessons/d1.html', is_sample: true }, { day: 2, title: '第二天', html: 'lessons/d2.html' }],
      }));
      return full;
    };
    const denied = arg(await client.callTool({ name: 'import_course', arguments: { staging_dir: mkFull('1.1.0') } }));
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain('完整包导入被拒');

    // 认领后：完整包样课正文被偷换（day1 与用户确认版本不一致）→ 导入即拒绝（不得拖到 complete 才发现）
    const req = arg(await client.callTool({ name: 'create_course_request', arguments: { course_id: cid, requested_by: 'e2e' } })).data;
    const claimed = arg(await client.callTool({ name: 'claim_course_request', arguments: { request_id: req.id, claimed_by: 'e2e-agent' } })).data;
    expect(claimed.status).toBe('claimed');
    const tampered = mkdtempSync(join(dbDir, 'td-course-gate-tamper-'));
    mkdirSync(join(tampered, 'lessons'), { recursive: true });
    writeFileSync(join(tampered, 'lessons', 'd1.html'), '<h1>Gate Day 1 被偷换</h1>');
    writeFileSync(join(tampered, 'lessons', 'd2.html'), '<h1>Gate Day 2</h1>');
    writeFileSync(join(tampered, 'course.json'), JSON.stringify({
      slug: 'gate-course', title: '门槛课程', version: '1.1.1',
      lessons: [{ day: 1, title: '第一天', html: 'lessons/d1.html', is_sample: true }, { day: 2, title: '第二天', html: 'lessons/d2.html' }],
    }));
    const badFull = arg(await client.callTool({ name: 'import_course', arguments: { staging_dir: tampered } }));
    expect(badFull.ok).toBe(false);
    expect(badFull.error).toContain('不一致');
    rmSync(tampered, { recursive: true, force: true });
    // day1 与确认逐字节一致的完整包 → 放行并完成
    const okFull = arg(await client.callTool({ name: 'import_course', arguments: { staging_dir: mkFull('1.2.0') } })).data;
    expect(okFull.lessons).toHaveLength(2);
    const done = arg(await client.callTool({ name: 'complete_course_request', arguments: { request_id: req.id, claimed_by: 'e2e-agent' } })).data;
    expect(done.status).toBe('done');

    // quiz 选项越界（picked=9 超出 options 长度）→ 拒绝
    const quiz = arg(await client.callTool({ name: 'submit_lesson_quiz', arguments: { course_id: cid, day: 1, answers: [{ question_id: 'q1', picked: 9 }] } }));
    expect(quiz.ok).toBe(false);
    expect(quiz.error).toContain('无效');

    // plan_id 不存在 → 导入拒绝
    const bad = mkdtempSync(join(dbDir, 'td-course-gate-bad-'));
    mkdirSync(join(bad, 'lessons'), { recursive: true });
    writeFileSync(join(bad, 'lessons', 'd1.html'), '<h1>x</h1>');
    writeFileSync(join(bad, 'course.json'), JSON.stringify({
      slug: 'gate-course-2', title: 'T', version: '1.0.0', plan_id: 99999,
      lessons: [{ day: 1, title: 'a', html: 'lessons/d1.html', is_sample: true }],
    }));
    const badImp = arg(await client.callTool({ name: 'import_course', arguments: { staging_dir: bad } }));
    expect(badImp.ok).toBe(false);
    expect(badImp.error).toContain('不存在');

    rmSync(stage, { recursive: true, force: true });
    rmSync(bad, { recursive: true, force: true });
  });
});

describe('知识库 vault（MCP 只读联动主链路）', () => {
  let fixtureVault: string;

  beforeAll(() => {
    fixtureVault = join(dbDir, 'vault-fixture');
    mkdirSync(join(fixtureVault, 'knowledge/moc'), { recursive: true });
    mkdirSync(join(fixtureVault, 'knowledge/resources/fa'), { recursive: true });
    mkdirSync(join(fixtureVault, 'knowledge/inbox-cards'), { recursive: true });
    writeFileSync(
      join(fixtureVault, 'knowledge/moc/首页.md'),
      '---\ntitle: 首页\ntype: moc\n---\n导航：[[知识库价值公式]] 与 [[不存在断链]]。',
    );
    writeFileSync(
      join(fixtureVault, 'knowledge/resources/fa/知识库价值公式.md'),
      '---\ntype: 知识卡片\nlevel: fa\nstatus: active\ntags: [知识库, 方法论]\n---\n一句话核心：价值 = 沉淀 × 复用。见 [[首页]]。',
    );
    writeFileSync(join(fixtureVault, 'knowledge/inbox-cards/待审草稿.md'), '---\nstatus: draft\n---\n草稿体。');
  });

  it('注册 → 扫描 → 浏览/搜索 → 阅读 → 链接解析', async () => {
    const reg = arg(await client.callTool({ name: 'register_vault', arguments: { root_path: fixtureVault, name: 'e2e 库' } })).data;
    expect(reg.name).toBe('e2e 库');

    const scan = arg(await client.callTool({ name: 'scan_vault', arguments: { vault_id: reg.id } })).data;
    expect(scan.discovered).toBe(3);
    expect(scan.missing).toBe(0);

    const notes = arg(await client.callTool({ name: 'list_vault_notes', arguments: { vault_id: reg.id, kind: 'card' } })).data.notes;
    expect(notes).toHaveLength(1);
    expect(notes[0].level).toBe('fa');

    const hit = arg(await client.callTool({ name: 'search_vault_notes', arguments: { query: '复用' } })).data.results;
    expect(hit.some((n: any) => n.rel_path.includes('知识库价值公式'))).toBe(true);

    const note = arg(
      await client.callTool({ name: 'get_vault_note', arguments: { vault_id: reg.id, rel_path: 'knowledge/moc/首页.md' } }),
    ).data;
    expect(note.markdown).toContain('导航');
    expect(note.stale).toBe(false);
    const resolved = note.links.find((l: any) => l.raw_target === '知识库价值公式');
    expect(resolved.resolved.rel_path).toBe('knowledge/resources/fa/知识库价值公式.md');
    const broken = note.links.find((l: any) => l.raw_target === '不存在断链');
    expect(broken.resolved).toBeNull();
    expect(note.backlinks.map((b: any) => b.rel_path)).toContain('knowledge/resources/fa/知识库价值公式.md'); // 价值公式卡引用了首页
    const card = arg(
      await client.callTool({ name: 'get_vault_note', arguments: { vault_id: reg.id, rel_path: 'knowledge/resources/fa/知识库价值公式.md' } }),
    ).data;
    expect(card.backlinks.map((b: any) => b.rel_path)).toContain('knowledge/moc/首页.md');
  });

  it('路径安全：越界与绝对路径读取被拒', async () => {
    const bad = arg(await client.callTool({ name: 'get_vault_note', arguments: { vault_id: 1, rel_path: '../outside.md' } }));
    expect(bad.ok).toBe(false);
    const bad2 = arg(await client.callTool({ name: 'get_vault_note', arguments: { vault_id: 1, rel_path: '/etc/passwd' } }));
    expect(bad2.ok).toBe(false);
  });

  it('概念关联：link → 查询 → 解除（只写 Dayfolio 库）', async () => {
    const link = arg(
      await client.callTool({
        name: 'link_concept_note',
        arguments: { vault_id: 1, rel_path: 'knowledge/resources/fa/知识库价值公式.md', knowledge_key: 'e2e/kb-formula' },
      }),
    ).data;
    expect(link.knowledge_key).toBe('e2e/kb-formula');
    const dup = arg(
      await client.callTool({
        name: 'link_concept_note',
        arguments: { vault_id: 1, rel_path: 'knowledge/resources/fa/知识库价值公式.md', knowledge_key: 'e2e/kb-formula' },
      }),
    );
    expect(dup.ok).toBe(false);
    const byKey = arg(await client.callTool({ name: 'list_concept_links', arguments: { knowledge_key: 'e2e/kb-formula' } })).data.links;
    expect(byKey).toHaveLength(1);
    const un = arg(await client.callTool({ name: 'unlink_concept_note', arguments: { link_id: link.id } }));
    expect(un.ok).toBe(true);
    // vault 文件未被写入：正文不含概念键
    const after = arg(
      await client.callTool({ name: 'get_vault_note', arguments: { vault_id: 1, rel_path: 'knowledge/resources/fa/知识库价值公式.md' } }),
    ).data;
    expect(after.markdown).not.toContain('e2e/kb-formula');
  });
});

describe('自媒体工作流（MCP 主链路：agent 写稿 + 用户审核红线）', () => {
  it('审核工具不暴露给 agent（approve/reject 只在 App）', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('approve_media_version');
    expect(names).not.toContain('reject_media_version');
    expect(names).toContain('submit_media_version');
  });

  it('新闻来源选题 → 母稿 → 多平台版本 → 提交审核（agent 到此为止）', async () => {
    // 造一条新闻（agent-only：任务提交）
    const seedTask = arg(await client.callTool({ name: 'create_news_task', arguments: { title: 'e2e：媒体选题素材任务', max_items: 2 } })).data;
    const seedClaim = arg(await client.callTool({ name: 'claim_news_task', arguments: { task_id: seedTask.id, claimed_by: 'media-seed' } })).data;
    arg(await client.callTool({
      name: 'submit_news_items',
      arguments: {
        task_id: seedTask.id, claim_token: seedClaim.claim_token,
        items: [{ title: 'e2e 媒体素材：知识管理工具发布', summary: '一款新工具正式发布。', source_url: 'https://example.com/e2e-media', published_at: new Date(Date.now() - 3600_000).toISOString() }],
      },
    }));
    await client.callTool({ name: 'complete_news_task', arguments: { task_id: seedTask.id, claim_token: seedClaim.claim_token } });
    const news = arg(await client.callTool({ name: 'list_news', arguments: { limit: 5 } })).data.news;
    const item = (news as any[])[0];
    expect(item).toBeTruthy();

    const topic = arg(
      await client.callTool({
        name: 'add_media_topic',
        arguments: { title: '来自新闻的选题', angle: '只读联动视角', source: 'news', source_news_id: item.id },
      }),
    ).data;
    expect(topic.source_desc).toContain(item.title);

    const content = arg(
      await client.callTool({
        name: 'add_media_content',
        arguments: { title: '只读知识库联动', topic_id: topic.id, master_content: '母稿：知识库价值 = 沉淀 × 复用。' },
      }),
    ).data;
    const xhs = arg(
      await client.callTool({ name: 'add_media_version', arguments: { content_id: content.id, platform: 'XiaohongShu', body: '小红书短版' } }),
    ).data;
    expect(xhs.platform).toBe('xiaohongshu');
    const wx = arg(
      await client.callTool({ name: 'add_media_version', arguments: { content_id: content.id, platform: 'weixin', body: '公众号长版' } }),
    ).data;

    // 未审核排期必须被拒
    const early = arg(await client.callTool({ name: 'schedule_media_post', arguments: { content_version_id: xhs.id, planned_date: 'tomorrow' } }));
    expect(early.ok).toBe(false);
    expect(early.error).toContain('approved');

    arg(await client.callTool({ name: 'submit_media_version', arguments: { id: xhs.id } }));
    arg(await client.callTool({ name: 'submit_media_version', arguments: { id: wx.id } }));

    // 模拟用户在 App 内人工审核（MCP 无该工具；直写临时库，语义与 App IPC 一致）
    const db = new DatabaseSync(join(dbDir, 'e2e.db'));
    try {
      db.exec(`UPDATE media_content_versions SET status = 'approved', reviewed_at = '2026-10-11T00:00:00.000Z' WHERE id = ${xhs.id}`);
    } finally {
      db.close();
    }

    const cal = arg(
      await client.callTool({ name: 'schedule_media_post', arguments: { content_version_id: xhs.id, planned_date: 'tomorrow', note: '首发' } }),
    ).data;
    expect(cal.status).toBe('planned');

    const pub = arg(
      await client.callTool({ name: 'mark_media_published', arguments: { id: cal.id, publish_url: 'https://xhs.example.com/post/1' } }),
    ).data;
    expect(pub.status).toBe('published');

    const metric = arg(
      await client.callTool({ name: 'add_media_metric', arguments: { calendar_id: cal.id, views: 1200, likes: 88, custom: { 完读率: 0.6 } } }),
    ).data;
    expect(metric.views).toBe(1200);

    const stats = arg(await client.callTool({ name: 'get_media_stats', arguments: {} })).data.stats;
    expect(stats[0].platform).toBe('xiaohongshu');
    expect(stats[0].views).toBe(1200);

    const ov = arg(await client.callTool({ name: 'get_media_overview', arguments: {} })).data;
    expect(ov.versions.in_review).toBeGreaterThanOrEqual(1); // weixin 版仍在待审

    // 素材与导出
    const mat = arg(
      await client.callTool({ name: 'add_media_material', arguments: { title: '金句', kind: 'text', content: '价值 = 沉淀 × 复用' } }),
    ).data;
    arg(await client.callTool({ name: 'attach_media_material', arguments: { content_id: content.id, material_id: mat.id } }));
    const exportDir = join(dbDir, 'media-exports');
    const pkg = arg(await client.callTool({ name: 'export_media_package', arguments: { content_id: content.id, export_dir: exportDir } })).data;
    expect(pkg.files).toContain('master.md');
    expect(existsSync(join(pkg.dir, 'master.md'))).toBe(true);
    expect(existsSync(join(pkg.dir, 'versions/xiaohongshu.md'))).toBe(true);

    // vault 内导出拒绝（已注册）
    const vaultReg = arg(await client.callTool({ name: 'list_vaults', arguments: {} })).data.vaults[0];
    const inVault = arg(await client.callTool({ name: 'export_media_package', arguments: { content_id: content.id, export_dir: vaultReg.root_path } }));
    expect(inVault.ok).toBe(false);
    expect(inVault.error).toContain('vault');
    // 未注册 vault 也硬拒绝（TODODESK_PROTECTED_DIRS 保护根）；export_study_cards 同一 core 层约束
    const unreg = arg(
      await client.callTool({ name: 'export_media_package', arguments: { content_id: content.id, export_dir: join(dbDir, 'protected-vault', 'out') } }),
    );
    expect(unreg.ok).toBe(false);
    expect(unreg.error).toContain('vault');
    const studyIn = arg(
      await client.callTool({ name: 'export_study_cards', arguments: { export_dir: join(dbDir, 'protected-vault', 'cards') } }),
    );
    expect(studyIn.ok).toBe(false);
    expect(studyIn.error).toContain('vault');
  });
});


describe('轻量本体公开契约',()=>{
  it('系统状态裸写拒绝，停用动作对专用 MCP 同样生效',async()=>{
    const todo=arg(await client.callTool({name:'add_todo',arguments:{title:'写边界验收'}})).data;
    expect(arg(await client.callTool({name:'update_object',arguments:{object_type:'todo',id:todo.id,values:{status:'done'}}})).ok).toBe(false);
    await client.callTool({name:'update_action_type',arguments:{api_name:'complete_todo',patch:{status:'disabled'}}});
    try {const denied=arg(await client.callTool({name:'complete_todo',arguments:{id:todo.id}}));expect(denied.ok).toBe(false);expect(denied.error).toContain('ACTION_DISABLED');}
    finally {await client.callTool({name:'update_action_type',arguments:{api_name:'complete_todo',patch:{status:'active'}}});}
    const done=arg(await client.callTool({name:'invoke_action',arguments:{action:'complete_todo',params:{id:todo.id}}}));expect(done.ok).toBe(true);
    await client.callTool({name:'delete_todo',arguments:{id:todo.id}});
  });
  it('目录包含现有业务对象，通用任务详情不返回认领令牌',async()=>{
    const meta=arg(await client.callTool({name:'list_object_types',arguments:{}})).data;
    for(const type of ['course','course_lesson','course_overview','vault','vault_note','media_content','media_metric','card_export'])expect(meta.objectTypes.some((t:{apiName:string})=>t.apiName===type)).toBe(true);
    const task=arg(await client.callTool({name:'create_news_task',arguments:{title:'凭据读取边界'}})).data;
    const claim=arg(await client.callTool({name:'claim_news_task',arguments:{task_id:task.id}})).data;
    expect(claim.claim_token).toBeTruthy();
    const obj=arg(await client.callTool({name:'get_object',arguments:{object_type:'news_task',id:task.id}})).data;
    expect(obj.row).not.toHaveProperty('claim_token');
    expect(arg(await client.callTool({name:'complete_news_task',arguments:{task_id:task.id,claim_token:claim.claim_token,note:'零条验收完成'}})).ok).toBe(true);
  });
  it('从素材反查内容，重复关联幂等，解除通过同一服务',async()=>{
    const content=arg(await client.callTool({name:'add_media_content',arguments:{title:'关系验收内容'}})).data;
    const material=arg(await client.callTool({name:'add_media_material',arguments:{title:'关系验收素材'}})).data;
    const args={link_type:'media_content__media_material',left_id:content.id,right_id:material.id};
    expect(arg(await client.callTool({name:'create_link',arguments:args})).data.created).toBe(true);
    expect(arg(await client.callTool({name:'create_link',arguments:args})).data.created).toBe(false);
    const links=arg(await client.callTool({name:'list_object_links',arguments:{object_type:'media_material',id:material.id,link_type:args.link_type,side:'right'}})).data;
    expect(links.items.some((r:{targetId:number})=>r.targetId===content.id)).toBe(true);
    expect(arg(await client.callTool({name:'delete_link',arguments:args})).data.deleted).toBe(true);
    await client.callTool({name:'delete_media_content',arguments:{id:content.id}});await client.callTool({name:'delete_media_material',arguments:{id:material.id}});
  });
  it('通用动作不可代替 App 的平台审核',async()=>{
    const content=arg(await client.callTool({name:'add_media_content',arguments:{title:'审核边界'}})).data;
    const version=arg(await client.callTool({name:'add_media_version',arguments:{content_id:content.id,platform:'weixin',body:'正文'}})).data;
    await client.callTool({name:'submit_media_version',arguments:{id:version.id}});
    const result=arg(await client.callTool({name:'invoke_action',arguments:{action:'review_media_version',params:{id:version.id,action:'approve'}}}));
    expect(result.ok).toBe(false);expect(result.error).toContain('ACTION_CHANNEL_DENIED');
    await client.callTool({name:'delete_media_content',arguments:{id:content.id}});
  });
});
