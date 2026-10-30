import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkCore, type TestCtx } from './helpers';

describe('新闻批次后台运行', () => {
  let ctx: TestCtx;
  beforeEach(() => { ctx = mkCore(); });
  afterEach(() => ctx.cleanup());

  // 使用已存在的批次关系，重点验证认领与释放，而不是采集内容。
  const setup = () => {
    const { news, newsRuns, db } = ctx.core;
    const first = news.createTask({ title: '国内' });
    const second = news.createTask({ title: '国际' });
    const third = news.createTask({ title: 'AI' });
    const foreign = news.createTask({ title: '其他批次' });
    const add = db.prepare('INSERT INTO news_feed_tasks(task_id,batch_id,module_id,phase,context_json) VALUES(?,?,?,?,?)');
    for (const task of [first, second, third]) add.run(task.id, 'batch-1', String(task.id), 1, '{}');
    add.run(foreign.id, 'batch-2', 'foreign', 1, '{}');
    const run = newsRuns.enqueue(first.id);
    newsRuns.claimNext('owner', process.pid);
    return { news, newsRuns, db, first, second, third, foreign, run };
  };

  it('关联同批次任务并幂等，失败退出时释放全部认领', () => {
    const { news, newsRuns, first, second, third, run } = setup();
    expect(newsRuns.attachBatchTasks(run.id, 'owner', [first.id, second.id, third.id])).toEqual([first.id, second.id, third.id]);
    expect(newsRuns.attachBatchTasks(run.id, 'owner', [second.id])).toEqual([first.id, second.id, third.id]);
    expect(newsRuns.list(second.id).map(r => r.id)).toContain(run.id);
    expect(newsRuns.finish(run.id, 'owner', 'succeeded').status).toBe('failed');
    for (const task of [first, second, third]) expect(news.getTask(task.id).status).toBe('pending');
  });

  it('拒绝跨批次、错误身份与其他认领，关联失败时事务回滚', () => {
    const { news, newsRuns, second, third, foreign, run } = setup();
    expect(() => newsRuns.attachBatchTasks(run.id, 'wrong', [second.id])).toThrow('身份');
    expect(() => newsRuns.attachBatchTasks(run.id, 'owner', [second.id, foreign.id])).toThrow('同一新闻批次');
    expect(news.getTask(second.id).status).toBe('pending');
    const otherClaim = news.claimTask(third.id, 'other-agent');
    expect(() => newsRuns.attachBatchTasks(run.id, 'owner', [second.id, third.id])).toThrow('占用');
    expect(news.getTask(second.id).status).toBe('pending');
    expect(news.getTask(third.id).claimed_by).toBe('other-agent');
    news.releaseTask(third.id, otherClaim.claim_token);
    newsRuns.cancel(run.id);
    expect(() => newsRuns.attachBatchTasks(run.id, 'owner', [second.id])).toThrow('正在停止');
    newsRuns.finish(run.id, 'owner', 'cancelled');
  });

  it('宿主崩溃恢复时释放所有关联任务，且不触碰其他执行者认领', () => {
    const { news, newsRuns, db, first, second, third, run } = setup();
    newsRuns.attachBatchTasks(run.id, 'owner', [second.id, third.id]);
    // 模拟租约到期后其他执行者接手；恢复不得释放该认领。
    db.prepare("UPDATE news_tasks SET claim_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(third.id);
    news.claimTask(third.id, 'other-agent');
    db.prepare('UPDATE news_agent_runs SET host_pid=? WHERE id=?').run(2147483647, run.id);
    expect(newsRuns.recover(run.id).status).toBe('interrupted');
    expect(news.getTask(first.id).status).toBe('pending');
    expect(news.getTask(second.id).status).toBe('pending');
    expect(news.getTask(third.id).claimed_by).toBe('other-agent');
  });
});
