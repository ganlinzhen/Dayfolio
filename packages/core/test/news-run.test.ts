import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkCore, type TestCtx } from './helpers';

describe('新闻后台运行与业务任务', () => {
  let ctx: TestCtx;
  beforeEach(() => { ctx = mkCore(); });
  afterEach(() => ctx.cleanup());
  it('连点复用运行，完成必须核对业务状态，失败后保留任务并可重试', () => {
    const { newsRuns, news } = ctx.core;
    const run = newsRuns.enqueue();
    expect(newsRuns.enqueue().id).toBe(run.id);
    const held = newsRuns.claimNext('owner', process.pid)!;
    expect(held.run.id).toBe(run.id);
    expect(newsRuns.claimNext('second', process.pid)).toBeNull();
    expect(newsRuns.finish(run.id, 'owner', 'succeeded').status).toBe('failed');
    expect(news.getTask(run.task_id).status).toBe('pending');
    const retry = newsRuns.enqueue(run.task_id);
    expect(retry.id).not.toBe(run.id);
    const next = newsRuns.claimNext('next', process.pid)!;
    news.completeTask(run.task_id, next.claim.claim_token, '时间窗内无合格新闻');
    expect(newsRuns.finish(retry.id, 'next', 'succeeded').status).toBe('succeeded');
  });
  it('停止运行保留已提交内容，旧令牌不能再次写入；公开记录无执行密钥', () => {
    const { newsRuns, news } = ctx.core;
    const run = newsRuns.enqueue();
    const { claim } = newsRuns.claimNext('owner-secret', process.pid)!;
    news.submitItems(run.task_id, claim.claim_token, [{ title: '运行保留内容', summary: '已核实的内容', source_url: 'https://example.com/run', published_at: new Date(Date.now() - 60000).toISOString() }]);
    expect(newsRuns.cancel(run.id).status).toBe('cancelling');
    expect(() => newsRuns.finish(run.id, 'wrong', 'cancelled')).toThrow('身份');
    newsRuns.finish(run.id, 'owner-secret', 'cancelled');
    expect(news.list({ task_id: run.task_id })).toHaveLength(1);
    expect(() => news.completeTask(run.task_id, claim.claim_token)).toThrow();
    expect(JSON.stringify(newsRuns.list())).not.toContain('owner-secret');
    expect(JSON.stringify(newsRuns.list())).not.toContain(claim.claim_token);
    expect(() => newsRuns.recover(newsRuns.claimNext('unused', process.pid)?.run.id ?? run.id)).not.toThrow();
  });
  it('停止时释放动作被停用也能终结运行授权，不留活动记录阻塞队列', () => {
    const { newsRuns, ontology } = ctx.core;
    const run = newsRuns.enqueue(); newsRuns.claimNext('owner', process.pid);
    ontology.updateActionType('release_news_task', { status: 'disabled' });
    expect(newsRuns.finish(run.id, 'owner', 'cancelled')).toMatchObject({ status: 'failed' });
    expect(() => newsRuns.progress(run.id, 'owner', '不应再写')).toThrow();
  });
  it('排队取消不认领任务，活着的执行器不被接管，动作停用仍生效', () => {
    const { newsRuns, news, ontology } = ctx.core;
    const run = newsRuns.enqueue();
    newsRuns.cancel(run.id);
    expect(news.getTask(run.task_id).status).toBe('pending');
    const retry = newsRuns.enqueue(run.task_id);
    newsRuns.claimNext('owner', process.pid);
    expect(() => newsRuns.recover(retry.id)).toThrow('仍在运行');
    ontology.updateActionType('enqueue_news_agent_run', { status: 'disabled' });
    expect(() => newsRuns.enqueue()).toThrow('停用');
  });
});
