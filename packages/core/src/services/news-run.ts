// 新闻后台执行记录。业务任务与执行尝试分开；令牌只交给受信执行器，不出现在公开记录中。
import { randomUUID } from 'node:crypto';
import { inTx, type DbAdapter } from '../db';
import type { NewsService } from './news';
import { todayStr } from '../utils/date';

export type NewsRunStatus = 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export interface NewsRun {
  id: string; task_id: number; status: NewsRunStatus; progress: string;
  error: string | null; thread_id: string | null; created_at: string;
  started_at: string | null; finished_at: string | null; host_pid: number | null;
}
const ACTIVE = ['queued', 'running', 'cancelling'];

export function createNewsRunService(db: DbAdapter, news: NewsService) {
  const row = (id: string) => db.prepare('SELECT * FROM news_agent_runs WHERE id=?').get(id);
  const publicRow = (r: Record<string, unknown>): NewsRun => ({
    id: String(r.id), task_id: Number(r.task_id), status: r.status as NewsRunStatus,
    progress: String(r.progress), error: r.error == null ? null : String(r.error),
    thread_id: r.thread_id == null ? null : String(r.thread_id), created_at: String(r.created_at),
    started_at: r.started_at == null ? null : String(r.started_at),
    finished_at: r.finished_at == null ? null : String(r.finished_at), host_pid: r.host_pid == null ? null : Number(r.host_pid),
  });
  const get = (id: string): NewsRun => { const r = row(id); if (!r) throw new Error('新闻执行记录不存在'); return publicRow(r); };
  const list = (taskId?: number): NewsRun[] => (taskId == null
    ? db.prepare("SELECT * FROM news_agent_runs ORDER BY CASE WHEN status IN ('queued','running','cancelling') THEN 0 ELSE 1 END, rowid DESC LIMIT 50").all()
    : db.prepare('SELECT * FROM news_agent_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 50').all(taskId)).map(publicRow);
  const enqueue = (taskId?: number): NewsRun => inTx(db, () => {
    const active = db.prepare(`SELECT * FROM news_agent_runs WHERE status IN ('queued','running','cancelling') ${taskId == null ? '' : 'AND task_id=?'} ORDER BY rowid LIMIT 1`);
    const existing = taskId == null ? active.get() : active.get(taskId);
    if (existing) return publicRow(existing);
    const task = taskId == null ? news.createTask({ title: `${todayStr()} 每日新闻`, use_collection_prompt: true }, 'app-agent') : news.getTask(taskId);
    if (task.status !== 'pending' && !(task.status === 'claimed' && task.claim_expires_at && task.claim_expires_at <= new Date().toISOString())) throw new Error('只能执行待处理或租约已过期的新闻任务');
    if (list().filter(r => ACTIVE.includes(r.status)).length >= 10) throw new Error('后台新闻队列已满，请等待现有任务完成');
    const id = randomUUID();
    db.prepare("INSERT INTO news_agent_runs(id,task_id,status,progress,created_at) VALUES(?,?,'queued','等待后台执行',?)").run(id, task.id, new Date().toISOString());
    return get(id);
  });
  const cancel = (id: string): NewsRun => inTx(db, () => {
    const r = get(id);
    if (r.status === 'queued') db.prepare("UPDATE news_agent_runs SET status='cancelled',progress='已停止本次执行，新闻请求保留',finished_at=? WHERE id=?").run(new Date().toISOString(), id);
    else if (r.status === 'running') db.prepare("UPDATE news_agent_runs SET status='cancelling',progress='正在停止采集' WHERE id=?").run(id);
    return get(id);
  });
  const claimNext = (owner: string, hostPid: number) => inTx(db, () => {
    if (!owner || !Number.isInteger(hostPid) || hostPid <= 0) throw new Error('执行器身份无效');
    if (db.prepare("SELECT id FROM news_agent_runs WHERE status IN ('running','cancelling')").get()) return null;
    const next = db.prepare("SELECT * FROM news_agent_runs WHERE status='queued' ORDER BY rowid LIMIT 1").get();
    if (!next) return null;
    const id = String(next.id);
    try {
      const claim = news.claimTask(Number(next.task_id), `dayfolio-run:${id}`);
      db.prepare("UPDATE news_agent_runs SET status='running',progress='正在启动 Agent',owner_token=?,host_pid=?,started_at=? WHERE id=? AND status='queued'").run(owner, hostPid, new Date().toISOString(), id);
      return { run: get(id), claim };
    } catch (e) {
      db.prepare("UPDATE news_agent_runs SET status='failed',progress='任务暂时无法认领',error=?,finished_at=? WHERE id=?").run(e instanceof Error ? e.message : String(e), new Date().toISOString(), id);
      return null;
    }
  });
  const assertOwner = (id: string, owner: string) => {
    const r = row(id);
    if (!r || r.owner_token !== owner || !['running', 'cancelling'].includes(String(r.status))) throw new Error('执行已结束或执行器身份不匹配');
    return r;
  };
  const progress = (id: string, owner: string, message: string, threadId?: string) => {
    assertOwner(id, owner);
    db.prepare('UPDATE news_agent_runs SET progress=?,thread_id=COALESCE(?,thread_id) WHERE id=?').run(message.slice(0, 300), threadId ?? null, id);
    return get(id);
  };
  const finish = (id: string, owner: string, status: 'succeeded' | 'failed' | 'cancelled' | 'interrupted', error?: string): NewsRun => inTx(db, () => {
    const r = assertOwner(id, owner), task = news.getTask(Number(r.task_id));
    // 以业务库为准：进程退出码或最后一句回复都不能替代真实完成。
    if (status === 'succeeded' && task.status !== 'completed') { status = 'failed'; error = 'Agent 已退出，但新闻任务尚未完成；可重试接续已入库结果'; }
    const claim = db.prepare('SELECT claim_token,claimed_by FROM news_tasks WHERE id=?').get(task.id);
    if (task.status === 'claimed' && claim?.claimed_by === `dayfolio-run:${id}` && claim.claim_token) {
      try { news.releaseTask(task.id, String(claim.claim_token), error?.slice(0, 300) || '后台执行已停止'); }
      catch { status = 'failed'; error = '执行已停止，但释放认领动作不可用；请恢复该动作或等待认领到期后重试'; }
    }
    const message = status === 'succeeded' ? `采集完成，当前收录 ${task.inserted_count} 条` : status === 'cancelled' ? '已停止，已收录内容保留' : status === 'interrupted' ? '上次执行中断，可重试' : '采集失败，可重试';
    db.prepare('UPDATE news_agent_runs SET status=?,progress=?,error=?,finished_at=?,owner_token=NULL WHERE id=?').run(status, message, error?.slice(0, 1000) ?? null, new Date().toISOString(), id);
    return get(id);
  });
  const recover = (id: string): NewsRun => {
    const r = row(id); if (!r || !['running', 'cancelling'].includes(String(r.status))) return get(id);
    try { process.kill(Number(r.host_pid), 0); throw new Error('执行器仍在运行，不能接管'); }
    catch (e) { if (!(e instanceof Error && 'code' in e && e.code === 'ESRCH')) throw e; }
    return finish(id, String(r.owner_token), 'interrupted', '原执行器已退出');
  };
  return { get, list, enqueue, cancel, claimNext, progress, finish, recover };
}
export type NewsRunService = ReturnType<typeof createNewsRunService>;
