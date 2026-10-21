import { useEffect, useRef, useState } from 'react';
import type { NewsRun } from '../../../../../../packages/core/src';
import type { NewsAgentStatus } from '../../../main/news-agent-runner';
import { api, call } from '../api';

export function useNewsAgent(onChanged: () => void) {
  const [runs, setRuns] = useState<NewsRun[]>([]);
  const [status, setStatus] = useState<NewsAgentStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const changed = useRef(onChanged); changed.current = onChanged;
  const signature = useRef('');
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await call<NewsRun[]>(() => api.news.agentRuns());
        if (!alive) return;
        setRuns(next);
        const value = JSON.stringify(next);
        if (signature.current !== value) { signature.current = value; changed.current(); }
      } catch (e) { if (alive) setError((e as Error).message); }
      if (alive) timer = setTimeout(() => void poll(), 1500);
    };
    void poll();
    void call<NewsAgentStatus>(() => api.news.agentStatus()).then(value => { if (alive) setStatus(value); }).catch(e => { if (alive) setError((e as Error).message); });
    return () => { alive = false; clearTimeout(timer); };
  }, []);
  const check = async () => {
    setBusy(true); setError('');
    try { setStatus(await call<NewsAgentStatus>(() => api.news.agentStatus())); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const run = async (taskId?: number) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const next = await call<NewsRun>(() => api.news.runAgent(taskId == null ? undefined : { task_id: taskId }));
      setRuns(previous => [next, ...previous.filter(r => r.id !== next.id)]); changed.current();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const cancel = async (id: string) => {
    try {
      const next = await call<NewsRun>(() => api.news.stopAgent({ run_id: id }));
      setRuns(previous => previous.map(r => r.id === id ? next : r));
    } catch (e) { setError((e as Error).message); }
  };
  return { runs, status, busy, error, check, run, cancel };
}

export default function NewsAgentControls({ agent, disabled }: { agent: ReturnType<typeof useNewsAgent>; disabled: boolean }) {
  const active = agent.runs.some(r => ['queued', 'running', 'cancelling'].includes(r.status));
  return <section className="news3-agent" aria-label="新闻后台执行">
    <div className="news3-agent-head">
      <div><h3>后台更新</h3><p>{agent.status?.message ?? '正在读取 Agent 配置…'}</p></div>
      <div className="news3-agent-actions">
        <button className="btn slim" onClick={() => window.dispatchEvent(new Event('dayfolio:openSettings'))}>配置 Agent</button>
        <button className="btn slim primary" disabled={disabled || agent.busy || active || !agent.status?.available} onClick={() => void agent.run()}>更新今日新闻</button>
      </div>
    </div>
    {disabled && <p>采集要求有未保存修改，请先保存或撤销。</p>}
    <p className="news3-agent-note">按已保存要求采集，结果自动刷新。关闭窗口后可继续；退出 Dayfolio 会停止采集，已收录内容保留。</p>
    {agent.error && <div className="notice error" role="alert">{agent.error}</div>}
    <div aria-live="polite">
      {agent.runs.slice(0, 5).map(r => <div className="news3-agent-run" key={r.id} data-run-status={r.status}>
        <div><strong>采集 #{r.task_id} · {r.progress}</strong>{r.error && <p>{r.error}</p>}</div>
        {['queued', 'running'].includes(r.status) && <button className="btn slim ghost" onClick={() => void agent.cancel(r.id)}>停止采集</button>}
        {['failed', 'cancelled', 'interrupted'].includes(r.status) && <button className="btn slim" disabled={agent.busy || active} onClick={() => void agent.run(r.task_id)}>重试本次采集</button>}
      </div>)}
    </div>
  </section>;
}
