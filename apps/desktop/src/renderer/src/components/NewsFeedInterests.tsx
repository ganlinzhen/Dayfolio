import ActionButton from './ActionButton';
import { IconChevronDown, IconHeart, IconPause, IconPlay, IconPlus, IconRefresh, IconStar, IconStop, IconTrash, IconUndo, IconUnlink, IconUpload, IconX } from './icons';
import { useCallback, useEffect, useState } from 'react';
import type { NewsEventFollow, NewsFeedItem, NewsInterestState, NewsTopicInput } from '../../../../../../packages/core/src/news-types';
import { api, call } from '../api';
import { toast } from './Toast';

export default function NewsFeedInterests({ onAddModule, onChanged }: { onChanged?: () => void; onAddModule: (name: string, scope: string) => void }) {
  const [state, setState] = useState<NewsInterestState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [starred, setStarred] = useState<NewsFeedItem[] | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [newEvent, setNewEvent] = useState('');
  const [newScope, setNewScope] = useState('');
  const [newTopic, setNewTopic] = useState('');
  const load = useCallback(async () => { setState(await call<NewsInterestState>(() => api.news.feedInterests())); }, []);
  useEffect(() => { void load().catch(e => setError((e as Error).message)); }, [load]);
  const mutate = async (action: () => Promise<unknown>, message?: string) => {
    if (busy) return; setBusy(true); setError('');
    try { await action(); await load(); onChanged?.(); if (message) toast(message); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const topic = (key: string, action: NewsTopicInput['action']) => void mutate(() => call(() => api.news.feedManageTopic({ key, action })));
  const event = (value: NewsEventFollow, status: NewsEventFollow['status']) => void mutate(() => call(() => api.news.feedUpdateEvent({ id: value.id, status, ...(status === 'active' && value.expires_at && Date.parse(value.expires_at) <= Date.now() ? { expires_at: null } : {}), expected_revision: value.revision })), status === 'active' ? '已明确恢复关注，后续更新将重新检索' : '关注状态已更新，历史内容保留');
  const loadStarred = async () => {
    setBusy(true); setError('');
    try { const rows: NewsFeedItem[] = []; for (let offset = 0; offset < 1000; offset += 100) { const page = await call<NewsFeedItem[]>(() => api.news.feedList({ history: true, filter: 'starred', limit: 100, offset })); rows.push(...page); if (page.length < 100) break; } setStarred(rows); setSelected([]); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <section className="nf-interests" aria-label="兴趣与时事管理"><header className="nf-section-head"><div><h2>兴趣与时事</h2><p>管理长期兴趣和阶段性关注。关注管理立即生效；加入模块草稿需保存配置。</p></div></header>
    {error && <div className="notice error" role="alert">{error}<ActionButton icon={IconRefresh} className="btn slim" onClick={() => void load().catch(e => setError((e as Error).message))}>重新读取</ActionButton></div>}
    {!state ? <p>正在读取兴趣…</p> : <>
      <details className="nf-management-group"><summary><span><strong>阶段性时事</strong><small>管理事件、关注期限和状态</small></span><span className="nf-management-count">{state.events.length} 项</span></summary><div className="nf-management-body"><p className="nf-note">暂停、到期或结束后停止专门检索，明确恢复后重新跟踪；重大消息仍可能进入公共新闻。</p>
      <fieldset disabled={busy} className="nf-fieldset">
        {state.events.map(value => <div className="nf-event" key={value.id}>
          <div><strong>{value.name}</strong><span className="nf-badge">{value.status === 'active' ? '关注中' : value.status === 'paused' ? '已暂停' : '已结束'}</span><p>{value.scope}</p></div>
          <label>关注到<input aria-label={`${value.name}关注期限`} type="date" value={value.expires_at?.slice(0, 10) || ''} onChange={e => void mutate(() => call(() => api.news.feedUpdateEvent({ id: value.id, expires_at: e.target.value ? `${e.target.value}T23:59:59+08:00` : null, expected_revision: value.revision })))} /></label>
          <span className="nf-note">{value.expires_at ? '到期暂停' : '持续关注'}</span>
          <div className="nf-actions">{value.status === 'active' ? <ActionButton icon={IconPause} className="btn slim" onClick={() => event(value, 'paused')}>暂停</ActionButton> : <ActionButton icon={IconPlay} className="btn slim" onClick={() => event(value, 'active')}>恢复关注</ActionButton>}{value.status !== 'ended' && <ActionButton icon={IconStop} className="btn slim" onClick={() => event(value, 'ended')}>结束关注</ActionButton>}</div>
          {value.reminder_due && <div className="notice nf-wide">近期较少查看，要继续关注吗？<ActionButton icon={IconHeart} className="btn slim" onClick={() => void mutate(() => call(() => api.news.feedDismissEventReminder({ id: value.id })))}>继续关注</ActionButton><ActionButton icon={IconPause} className="btn slim" onClick={() => event(value, 'paused')}>暂停</ActionButton></div>}
        </div>)}
        <details className="nf-advanced"><summary>新增时事关注</summary><div className="nf-form-grid"><label>事件名称<input value={newEvent} onChange={e => setNewEvent(e.target.value)} placeholder="例如：一项阶段性政策" /></label><label>检索方向<input value={newScope} onChange={e => setNewScope(e.target.value)} /></label><ActionButton icon={IconPlus} className="btn" disabled={!newEvent.trim() || !newScope.trim()} onClick={() => void mutate(async () => { await call(() => api.news.feedUpdateEvent({ id: `event-${crypto.randomUUID()}`, name: newEvent.trim(), scope: newScope.trim(), status: 'active', expected_revision: 0 })); setNewEvent(''); setNewScope(''); }, '时事关注已加入')}>加入关注</ActionButton></div></details>
      </fieldset>
      </div></details>
      <details className="nf-management-group"><summary><span><strong>长期主题与探索</strong><small>管理关注、推荐和探索方向</small></span><span className="nf-management-count">{state.topics.length} 项</span></summary><div className="nf-management-body"><p className="nf-note">{state.enabled ? '正在根据新的阅读和反馈学习。' : '个性化学习已关闭；明确关注仍然保留。'} 推荐理由来自实际证据；移除候选后进入冷却，可手动恢复。</p>
      {state.exploration && <div className="nf-exploration"><strong>发现新方向：{state.exploration.name}</strong><p>{state.exploration.reason}</p><div className="nf-actions"><ActionButton icon={IconHeart} className="btn slim" disabled={busy} onClick={() => void mutate(() => call(() => api.news.feedManageTopic({ key: state.exploration!.key, name: state.exploration!.name, action: 'follow' })), '已关注这个方向')}>关注主题</ActionButton><ActionButton icon={IconPlus} className="btn slim" disabled={busy} onClick={() => onAddModule(state.exploration!.name, state.exploration!.scope || state.exploration!.name)}>加入模块草稿</ActionButton><ActionButton icon={IconChevronDown} className="btn slim" disabled={busy} onClick={() => topic(state.exploration!.key, 'reduce')}>少推荐</ActionButton><ActionButton icon={IconX} className="btn slim" disabled={busy} onClick={() => topic(state.exploration!.key, 'remove')}>移除候选</ActionButton></div></div>}
      {state.topics.length === 0 && <p className="nf-empty-inline">还没有兴趣证据。启用学习后阅读新闻，或在新闻上明确选择“感兴趣”。</p>}
      <fieldset disabled={busy} className="nf-fieldset">{state.topics.map(value => <div className="nf-topic" key={value.key}><div><strong>{value.name}</strong><span className="nf-badge">{{ inferred: '阅读推断', followed: '明确关注', reduced: '已减少', removed: '已移除' }[value.state]}</span>{value.reduced && value.state === 'followed' && <span className="nf-badge">已降频</span>}<p>{value.reasons.join('；') || '探索推荐，尚无长期证据'}</p>{(value.candidate_cooldown_until || value.cooldown_until) && <p className="nf-note">候选冷却至 {(value.candidate_cooldown_until || value.cooldown_until)!.slice(0, 10)}{value.state === 'followed' ? '，明确关注继续保留' : ''}</p>}</div><div className="nf-actions">{value.state === 'followed' ? <ActionButton icon={IconUnlink} className="btn slim" onClick={() => topic(value.key, 'unfollow')}>取消关注</ActionButton> : <ActionButton icon={value.state === 'removed' ? IconUndo : IconHeart} className="btn slim" onClick={() => topic(value.key, value.state === 'removed' ? 'restore' : 'follow')}>{value.state === 'removed' ? '恢复候选' : '关注主题'}</ActionButton>}<ActionButton icon={IconPlus} className="btn slim" onClick={() => onAddModule(value.name, value.scope || value.name)}>加入模块草稿</ActionButton>{value.reduced || value.state === 'reduced' ? <ActionButton icon={IconUndo} className="btn slim" onClick={() => topic(value.key, 'restore')}>恢复推荐</ActionButton> : <ActionButton icon={IconChevronDown} className="btn slim" onClick={() => topic(value.key, 'reduce')}>少推荐</ActionButton>}{value.state !== 'removed' && value.state !== 'followed' && <ActionButton icon={IconX} className="btn slim" onClick={() => topic(value.key, 'remove')}>移除候选</ActionButton>}</div></div>)}</fieldset>
      <div className="nf-actions nf-topic-add"><label>主动关注主题<input value={newTopic} onChange={e => setNewTopic(e.target.value)} placeholder="输入你想持续了解的方向" /></label><ActionButton icon={IconHeart} className="btn slim" disabled={busy || !newTopic.trim()} onClick={() => void mutate(async () => { await call(() => api.news.feedManageTopic({ key: newTopic.trim(), name: newTopic.trim(), action: 'follow' })); setNewTopic(''); }, '主题已关注，下轮会参考这个方向')}>关注主题</ActionButton></div>
      {state.reduced_sources.length > 0 && <section className="nf-source-preferences"><h4>已减少的来源</h4>{state.reduced_sources.map(source => <div className="nf-actions" key={source}><span>{source}</span><ActionButton icon={IconUndo} className="btn slim" disabled={busy} onClick={() => void mutate(() => call(() => api.news.feedManageSource({ source_name: source, action: 'restore' })), '来源降频已撤销')}>恢复来源推荐</ActionButton></div>)}</section>}
      </div></details>
      <details className="nf-management-group"><summary><span><strong>历史收藏与学习数据</strong><small>选择旧收藏或清空学习结果</small></span></summary><div className="nf-management-body"><p className="nf-note">旧收藏不会自动参与学习。清空保留新闻、收藏、已读、模块和明确关注；此前已发送给外部 Agent 的会话副本不在清空范围内。</p><div className="nf-actions"><ActionButton icon={IconStar} className="btn" disabled={busy || !state.enabled} onClick={() => void loadStarred()}>选择旧收藏参与学习</ActionButton><ActionButton icon={IconTrash} className="btn danger" disabled={busy} onClick={() => { if (window.confirm('清空阅读行为与推断兴趣？新闻、收藏、已读、模块配置和明确关注／结束状态会保留，旧收藏不会自动重建画像。')) void mutate(() => call(() => api.news.feedResetLearning()), '学习结果已清空'); }}>清空学习结果</ActionButton></div>
        {starred && <div className="nf-star-import"><h4>选择想用于推荐的收藏</h4>{starred.length === 0 && <p>还没有收藏新闻。</p>}{starred.map(row => <label className="nf-check" key={row.id}><input type="checkbox" checked={selected.includes(row.id)} onChange={e => setSelected(e.target.checked ? [...selected, row.id] : selected.filter(id => id !== row.id))} />{row.title}</label>)}<div className="nf-actions"><ActionButton icon={IconUpload} className="btn primary" disabled={busy || selected.length === 0} onClick={() => void mutate(async () => { await call(() => api.news.feedImportStarred({ news_ids: selected })); setStarred(null); }, '已选收藏已参与本轮学习')}>导入所选 {selected.length} 条</ActionButton><ActionButton icon={IconX} className="btn" onClick={() => setStarred(null)}>取消</ActionButton></div></div>}
      </div></details>
    </>}
  </section>;
}
