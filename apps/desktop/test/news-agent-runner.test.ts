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
  const fake = (mode: 'success' | 'incomplete' | 'wait', provider: AgentProvider = 'codex') => {
    const file = join(dirname(ctx.dbPath), 'fake-codex.mjs');
    writeFileSync(file, `#!${process.execPath}
process.env.DAYFOLIO_TEST_PROVIDER = ${JSON.stringify(provider)};
process.env.DAYFOLIO_NEWS_FIXTURE_MODE = ${JSON.stringify(mode)};
await import(${JSON.stringify(new URL('./fixtures/fake-news-agent.mjs', import.meta.url).href)});
`);
    chmodSync(file, 0o700);
    ctx.core.agentSettings.update({ provider, binary: file, expected_revision: ctx.core.agentSettings.get().revision });
    runner = createNewsAgentRunner({ core: ctx.core, dbPath: ctx.dbPath, nodeBinary: process.execPath,
      mcpServer: new URL('../../mcp/dist/mcp-server.cjs', import.meta.url).pathname });
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
});
