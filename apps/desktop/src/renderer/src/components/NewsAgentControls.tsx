import ActionButton from './ActionButton';
import { IconEye, IconPlay, IconRefresh, IconSettings, IconStop } from './icons';
import { useEffect, useRef, useState } from 'react';
import type { NewsRun } from '../../../../../../packages/core/src';
import type { NewsFeedBatch } from '../../../../../../packages/core/src/news-types';
import type { NewsScheduleStatus } from '../../../../../../packages/core/src/services/news-schedule';
import type { NewsAgentStatus } from '../../../main/news-agent-runner';
import { api, call } from '../api';

export function useNewsAgent(onChanged: () => void) {
  const [runs, setRuns] = useState<NewsRun[]>([]);
  const [batches, setBatches] = useState<NewsFeedBatch[]>([]);
  const [status, setStatus] = useState<NewsAgentStatus | null>(null);
  const [schedule, setSchedule] = useState<(NewsScheduleStatus & { error: string | null }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const changed = useRef(onChanged); changed.current = onChanged;
  const signature = useRef('');
  const mounted = useRef(true);
  const refresh = async () => {
    const [next, batchRows, planned] = await Promise.all([call<NewsRun[]>(() => api.news.agentRuns()), call<NewsFeedBatch[]>(() => api.news.feedBatches({ limit: 12 })), call<NewsScheduleStatus & { error: string | null }>(() => api.news.feedScheduleStatus())]);
    if (!mounted.current) return; setRuns(next); setBatches(batchRows); setSchedule(planned);
    const value = JSON.stringify([next, batchRows]);
    if (signature.current && signature.current !== value) changed.current(); signature.current = value;
  };
  useEffect(() => {
    mounted.current = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { try { await refresh(); } catch (e) { if (mounted.current) setError((e as Error).message); } if (mounted.current) timer = setTimeout(() => void poll(), 4000); };
    void poll(); void call<NewsAgentStatus>(() => api.news.agentStatus()).then(value => { if (mounted.current) setStatus(value); }).catch(e => { if (mounted.current) setError((e as Error).message); });
    return () => { mounted.current = false; clearTimeout(timer); };
  }, []);
  const update = async (batchId?: string) => {
    if (busy) return; setBusy(true); setError('');
    try { if (batchId) await call(() => api.news.feedContinueUpdate({ batch_id: batchId })); else await call(() => api.news.feedStartUpdate({ trigger: 'manual' })); await refresh(); changed.current(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const stop = async (batchId: string) => { setBusy(true); setError(''); try { await call(() => api.news.feedStopUpdate({ batch_id: batchId })); await refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return { runs, batches, status, schedule, busy, error, update, stop };
}
const statusText: Record<NewsFeedBatch['status'], string> = { active: '正在更新', completed: '本轮已完成', stopped: '已停止', budget_exhausted: '已达时间预算', invalidated: '配置撤回，已停止旧要求' };
const moduleStatus = { waiting: '等待', pending: '待核实', claimed: '核实中', completed: '检索完成', cancelled: '已停止', skipped: '已跳过' };
export default function NewsAgentControls({ agent, disabled, compact = false }: { agent: ReturnType<typeof useNewsAgent>; disabled: boolean; compact?: boolean }) {
  const batch = agent.batches[0]; const active = agent.batches.some(b => b.status === 'active');
  if (compact) return batch ? <div className="nf-progress-compact" aria-live="polite"><span>{statusText[batch.status]} · {batch.modules.map(m => `${m.name} ${m.accepted_count}/${m.target}`).join(' · ')}</span><ActionButton icon={active ? IconEye : IconRefresh} className="btn slim ghost" onClick={() => void agent.update()} disabled={disabled || agent.busy}>{active ? '查看当前进度' : '更新新闻'}</ActionButton></div> : null;
  return <section className="news3-agent nf-agent" aria-label="新闻更新进度"><header className="nf-section-head"><div><h2>采集进度</h2><p>{agent.status?.message || '正在检查 Agent 配置…'}</p></div><div className="nf-actions"><ActionButton icon={IconSettings} className="btn slim" onClick={() => window.dispatchEvent(new Event('dayfolio:openSettings'))}>配置 Agent</ActionButton><ActionButton icon={active ? IconEye : IconRefresh} className="btn primary" disabled={disabled || agent.busy || !agent.status?.available} onClick={() => void agent.update()}>{active ? '查看当前更新' : '更新新闻'}</ActionButton></div></header>
    {agent.schedule && <p className="nf-note">{agent.schedule.enabled ? `每日 ${agent.schedule.times.join('、')} 开始更新（北京时间）${agent.schedule.next_at ? `；下次 ${new Date(agent.schedule.next_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}` : ''}` : '自动更新已关闭，仍可手动更新。'}</p>}
    {agent.schedule?.error && <div className="notice error" role="alert">自动更新暂不可用：{agent.schedule.error}。请检查 Agent 配置，已有内容保留。</div>}
    {disabled && <p className="notice">配置有未保存修改，请先保存或撤销。</p>}
    <p className="nf-note">先覆盖各模块重点，再补足内容；缺口如实保留。重复更新复用当前批次，停止后已收录内容继续可读。</p>
    {agent.error && <div className="notice error" role="alert">{agent.error}</div>}
    {agent.batches.length === 0 && <p className="nf-empty-inline">还没有模块采集记录。保存配置后可开始第一轮更新。</p>}
    {agent.batches.map((b, index) => <details className="nf-batch" key={b.id} open={index === 0}><summary><strong>{statusText[b.status]}</strong><span>{new Date(b.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} · {b.trigger === 'scheduled' ? '定时' : '手动'}</span></summary><p className="nf-note">配置版本 {b.config_revision} · 截止 {new Date(b.deadline_at).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）</p>
      <ul className="nf-batch-modules">{b.modules.map((m, mi) => <li key={`${m.module_id}:${m.phase}:${mi}`}><div><strong>{m.name}</strong><span>{m.phase === 1 ? '重点覆盖' : '补足内容'} · {moduleStatus[m.status]}</span></div><span>已接受 {m.accepted_count} / 目标 {m.target}</span>{m.note && <p>{m.note}</p>}{m.status === 'completed' && m.accepted_count < m.target && <p className="nf-note">未达目标 {m.target - m.accepted_count} 则；不以重复或低质量内容补齐。</p>}</li>)}</ul>
      <div className="nf-actions">{b.status === 'active' ? <ActionButton icon={IconStop} className="btn slim" disabled={agent.busy} onClick={() => void agent.stop(b.id)}>停止本轮更新</ActionButton> : ['stopped', 'budget_exhausted'].includes(b.status) && <ActionButton icon={IconPlay} className="btn slim" disabled={disabled || agent.busy || active} onClick={() => void agent.update(b.id)}>继续本轮（保留已有结果与配额）</ActionButton>}</div>
    </details>)}
    {agent.runs.some(r => r.error) && <details className="nf-fieldset"><summary>执行错误与恢复</summary>{agent.runs.filter(r => r.error).slice(0, 5).map(r => <p key={r.id}>任务 #{r.task_id}：{r.error}</p>)}<p className="nf-note">执行失败与来源不足分别记录；检查 Agent、网络及权限后再继续本轮。</p></details>}
  </section>;
}
