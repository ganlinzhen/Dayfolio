// 真实受限 MCP 协议验证：批次中每个模块保持独立认领与授权。
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCore, openNodeSqliteDb } from '../../../packages/core/src';

const SERVER = new URL('../dist/mcp-server.cjs', import.meta.url).pathname;
const decode = (result: { content: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0].text);

describe('新闻批次受限 MCP', () => {
  let dir: string;
  let db: ReturnType<typeof openNodeSqliteDb>;
  let core: ReturnType<typeof createCore>;
  let client: Client;
  let runId: string;
  let batchId: string;
  let taskIds: number[];
  const owner = 'batch-e2e-owner';
  const call = async (name: string, input: Record<string, unknown> = {}) => decode(await client.callTool({ name, arguments: input }) as { content: unknown });
  const item = (suffix: string) => ({ title: `受限批次新闻${suffix}`, summary: `受限批次新闻${suffix}包含可核对的事实和进展。`, source_url: `https://example.com/batch-e2e/${suffix}`, published_at: new Date(Date.now() - 60000).toISOString() });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dayfolio-batch-mcp-'));
    const path = join(dir, 'dayfolio.db');
    mkdirSync(join(dir, 'home')); mkdirSync(join(dir, 'user-data'));
    db = openNodeSqliteDb(path); core = createCore(db, { dbPath: path });
    const config = core.newsFeed.getConfig();
    config.modules = config.modules.filter(module => ['domestic', 'ai'].includes(module.id)).map(module => ({ ...module, headline_count: 2, max_items: 2 }));
    config.learning = { enabled: false, exploration_enabled: false };
    core.newsFeed.updateConfig({ config, expected_revision: config.revision });
    let batch = core.newsFeed.startUpdate(); batchId = batch.id;
    const run = core.newsRuns.enqueue(batch.next_task_id!); runId = run.id;
    core.newsRuns.claimNext(owner, process.pid);
    batch = core.newsFeed.prepareBatchTasks(batch.id);
    taskIds = batch.modules.flatMap(module => module.task_id == null ? [] : [module.task_id]);
    core.newsRuns.attachBatchTasks(runId, owner, taskIds);
    client = new Client({ name: 'batch-scope-e2e', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(dir, 'home'), TODODESK_DB: path,
      TODODESK_USER_DATA: join(dir, 'user-data'), DAYFOLIO_NEWS_RUN_ID: runId, DAYFOLIO_NEWS_RUN_TOKEN: owner,
    } }));
  }, 30000);

  afterEach(async () => {
    await client?.close();
    try { core.newsRuns.finish(runId, owner, 'cancelled'); } catch { /* 测试可能已完成或停止运行。 */ }
    db?.close(); rmSync(dir, { recursive: true, force: true });
  });

  it('多个模块各自提交、总结、完成，摘要拒绝未公开 ID 和过期修订', async () => {
    expect(taskIds).toHaveLength(2);
    const initial = await call('get_news_batch'); expect(initial.ok, initial.error).toBe(true);
    expect(initial.data.map((entry: { task_id: number }) => entry.task_id).sort()).toEqual([...taskIds].sort());
    const submitted: number[] = [];
    for (const [index, taskId] of taskIds.entries()) {
      const result = await call('submit_batch_news', { task_id: taskId, items: [item(String(index))] });
      expect(result.ok, result.error).toBe(true); submitted.push(result.data.items[0].id);
    }
    const firstDaily = core.newsFeed.getTaskContext(taskIds[0])!.daily_edition!;
    const summary = { task_id: taskIds[0], summary: '该事项取得已核实的新进展。', news_ids: [submitted[0]], expected_revision: firstDaily.edition.revision };
    expect((await call('summarize_batch_news', summary)).ok).toBe(false);
    const fresh = await call('get_news_batch'); expect(fresh.ok, fresh.error).toBe(true);
    expect((await call('summarize_batch_news', { ...summary, news_ids: [submitted[1]] })).ok).toBe(false);
    const saved = await call('summarize_batch_news', summary); expect(saved.ok, saved.error).toBe(true);
    expect((await call('summarize_batch_news', summary)).ok).toBe(false);
    const secondDaily = core.newsFeed.getTaskContext(taskIds[1])!.daily_edition!;
    const second = await call('summarize_batch_news', { task_id: taskIds[1], summary: '另一模块发布了新的进展。', news_ids: [submitted[1]], expected_revision: secondDaily.edition.revision });
    expect(second.ok, second.error).toBe(true);
    for (const taskId of taskIds) expect((await call('complete_batch_task', { task_id: taskId, note: '测试完成' })).ok).toBe(true);
    expect(core.newsRuns.finish(runId, owner, 'succeeded').status).toBe('succeeded');
    for (const taskId of taskIds) expect(core.news.getTask(taskId).status).toBe('completed');
  }, 30000);

  it('拒绝未关联任务及停止后的任何写入', async () => {
    const foreign = core.news.createTask({ title: '不属于本批次' });
    expect((await call('submit_batch_news', { task_id: foreign.id, items: [item('foreign')] })).ok).toBe(false);
    core.newsFeed.stopUpdate(batchId);
    expect((await call('submit_batch_news', { task_id: taskIds[0], items: [item('stopped')] })).ok).toBe(false);
    expect((await call('complete_batch_task', { task_id: taskIds[1] })).ok).toBe(false);
  }, 30000);

  it('模块撤权与租约过期后拒绝对应任务写入', async () => {
    const context = core.newsFeed.getTaskContext(taskIds[0])!;
    const config = core.newsFeed.getConfig();
    config.modules = config.modules.map(module => module.id === context.module_id ? { ...module, enabled: false } : module);
    core.newsFeed.updateConfig({ config, expected_revision: config.revision });
    expect((await call('submit_batch_news', { task_id: taskIds[0], items: [item('revoked')] })).ok).toBe(false);
    db.prepare('UPDATE news_tasks SET claim_expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), taskIds[1]);
    expect((await call('submit_batch_news', { task_id: taskIds[1], items: [item('expired')] })).ok).toBe(false);
  }, 30000);
});
