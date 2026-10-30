import { chmodSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkCore, type TestCtx } from '../../../packages/core/test/helpers';
import type { AgentProvider } from '../../../packages/core/src';
import { createNewsAgentRunner } from '../src/main/news-agent-runner';

describe('后台进程经真实受限 MCP 写回新闻', () => {
  let ctx: TestCtx;
  let runner: ReturnType<typeof createNewsAgentRunner> | undefined;
  beforeEach(() => { ctx = mkCore(); });
  afterEach(async () => { await runner?.stop(); ctx.cleanup(); });
  const fake = (mode: 'success' | 'incomplete' | 'wait' | 'batch' | 'rss-wait', provider: AgentProvider = 'codex') => {
    const file = join(dirname(ctx.dbPath), 'fake-codex.mjs');
    writeFileSync(file, `#!${process.execPath}
process.env.DAYFOLIO_TEST_PROVIDER = ${JSON.stringify(provider)};
process.env.DAYFOLIO_NEWS_FIXTURE_MODE = ${JSON.stringify(mode)};
await import(${JSON.stringify(new URL('./fixtures/fake-news-agent.mjs', import.meta.url).href)});
`);
    chmodSync(file, 0o700);
    ctx.core.agentSettings.update({ provider, binary: file, expected_revision: ctx.core.agentSettings.get().revision });
    runner = createNewsAgentRunner({ core: ctx.core, dbPath: ctx.dbPath, nodeBinary: process.execPath,
      mcpServer: new URL('../../mcp/dist/mcp-server.cjs', import.meta.url).pathname,
      rssCollector: mode === 'rss-wait' ? async ({ signal }) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('已停止')))) : async () => ({ candidates: [], sources: [] }) });
    return runner;
  };
  it.each(['codex', 'claude', 'gemini'] as const)('%s 通过保存的连接配置执行，业务完成后可独立回读', async provider => {
    const worker = fake('success', provider);
    expect((await worker.status()).available).toBe(true);
    const run = ctx.core.newsRuns.enqueue(); worker.start();
    await expect.poll(() => ctx.core.newsRuns.get(run.id).status, { timeout: 20000 }).toBe('succeeded');
    expect(ctx.core.news.list({ task_id: run.task_id })).toHaveLength(1);
    expect(ctx.core.news.getTask(run.task_id).status).toBe('completed');
    expect(ctx.core.newsRuns.get(run.id).thread_id).toBe('fixture-thread');
  }, 25000);
  it('即使退出码为0，未完成业务任务仍失败并释放认领', async () => {
    const worker = fake('incomplete'), run = ctx.core.newsRuns.enqueue(); worker.start();
    await expect.poll(() => ctx.core.newsRuns.get(run.id).status, { timeout: 20000 }).toBe('failed');
    expect(ctx.core.news.getTask(run.task_id).status).toBe('pending');
    expect(ctx.core.news.list({ task_id: run.task_id })).toHaveLength(1);
  }, 25000);
  it('取消实际终止进程，保留已收录内容并撤销写入认领', async () => {
    const worker = fake('wait'), run = ctx.core.newsRuns.enqueue(); worker.start();
    await expect.poll(() => ctx.core.news.list({ task_id: run.task_id }).length, { timeout: 20000 }).toBe(1);
    ctx.core.newsRuns.cancel(run.id);
    await expect.poll(() => ctx.core.newsRuns.get(run.id).status, { timeout: 10000 }).toBe('cancelled');
    expect(ctx.core.news.getTask(run.task_id).status).toBe('pending');
    expect(ctx.core.news.list({ task_id: run.task_id })).toHaveLength(1);
  }, 30000);
  it('一轮多个模块使用同一进程及受限 MCP 完成', async () => {
    const worker = fake('batch');
    const batch = await worker.startFeedUpdate();
    worker.start();
    await expect.poll(() => ctx.core.newsFeed.listBatches().find(item => item.id === batch.id)?.status, { timeout: 20000 }).toBe('completed');
    const finished = ctx.core.newsFeed.listBatches().find(item => item.id === batch.id)!;
    const ids = finished.modules.flatMap(item => item.task_id == null ? [] : [item.task_id]);
    expect(ids.length).toBeGreaterThan(1);
    expect(ids.map(id => ({ id, status: ctx.core.news.getTask(id).status, runs: ctx.core.newsRuns.list(id) }))).toEqual(ids.map(id => expect.objectContaining({ id, status: 'completed' })));
    expect(new Set(ids.map(id => ctx.core.newsRuns.list(id)[0]?.id)).size).toBe(1);
  }, 25000);
  it('批次进程失败时不会对其余关联任务重复启动', async () => {
    const worker = fake('incomplete');
    const batch = await worker.startFeedUpdate(); worker.start();
    await expect.poll(() => ctx.core.newsFeed.listBatches().find(item => item.id === batch.id)?.status, { timeout: 20000 }).toBe('completed');
    const finished = ctx.core.newsFeed.listBatches().find(item => item.id === batch.id)!;
    const ids = finished.modules.flatMap(item => item.task_id == null ? [] : [item.task_id]);
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids.flatMap(id => ctx.core.newsRuns.list(id).map(run => run.id))).size).toBe(1);
    expect(ids.every(id => ctx.core.news.getTask(id).status === 'cancelled')).toBe(true);
  }, 25000);
  it('抓取 RSS 期间取消会记录取消并释放认领', async () => {
    const worker = fake('rss-wait');
    const batch = await worker.startFeedUpdate(); worker.start();
    await expect.poll(() => ctx.core.newsRuns.list(batch.next_task_id!)[0]?.status, { timeout: 5000 }).toBe('running');
    const run = ctx.core.newsRuns.list(batch.next_task_id!)[0];
    ctx.core.newsRuns.cancel(run.id);
    await expect.poll(() => ctx.core.newsRuns.get(run.id).status, { timeout: 5000 }).toBe('cancelled');
  }, 10000);
});
