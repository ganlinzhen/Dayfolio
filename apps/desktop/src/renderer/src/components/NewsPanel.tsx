import { useCallback, useEffect, useRef, useState } from 'react';
import type { NewsFeedConfig, NewsFeedItem, NewsFeedbackKind, NewsInterestState } from '../../../../../../packages/core/src/news-types';
import { api, call } from '../api';
import NewsCollectionEditor from './NewsCollectionEditor';
import NewsAgentControls, { useNewsAgent } from './NewsAgentControls';
import NewsFeedReader, { NewsFeedImage, newsSource, newsTime } from './NewsFeedReader';
import { IconSearch, IconStar } from './icons';
import { toast } from './Toast';
import './news-feed.css';

type Filter = 'all' | 'unread' | 'starred' | 'hidden';
type Snapshot = Record<string, NewsFeedItem[]>;
const labels: Record<Filter, string> = { all: '全部', unread: '未读', starred: '收藏', hidden: '已隐藏' };
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

export default function NewsPanel() {
  const [config, setConfig] = useState<NewsFeedConfig | null>(null);
  const [interests, setInterests] = useState<NewsInterestState | null>(null);
  const [correctionItems, setCorrectionItems] = useState<NewsFeedItem[]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot>({});
  const [pending, setPending] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [moduleId, setModuleId] = useState('all');
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<NewsFeedItem | null>(null);
  const [page, setPage] = useState<'read' | 'config' | 'progress'>('read');
  const [expanded, setExpanded] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [moduleSeed, setModuleSeed] = useState<{ name: string; scope: string } | null>(null);
  const [error, setError] = useState('');
  const [historyLimit, setHistoryLimit] = useState(100);
  const scroller = useRef<HTMLDivElement | null>(null); const scrollTop = useRef(0); const snapshotRef = useRef(snapshot); snapshotRef.current = snapshot;
  const requestGeneration = useRef(0); const initialLoaded = useRef(false); const readingSession = useRef(crypto.randomUUID());
  useEffect(() => { const timer = setTimeout(() => setQuery(search.trim()), 250); return () => clearTimeout(timer); }, [search]);
  const loadConfig = useCallback(async () => { const [value, profile, corrected] = await Promise.all([call<NewsFeedConfig>(() => api.news.feedConfig()), call<NewsInterestState>(() => api.news.feedInterests()), call<NewsFeedItem[]>(() => api.news.feedList({ history: true, corrections_only: true, limit: 1000 }))]); setCorrectionItems(corrected); setConfig(previous => JSON.stringify(previous) === JSON.stringify(value) ? previous : value); setInterests(profile); }, []);
  useEffect(() => { void loadConfig().catch(e => { setError(errorText(e)); setLoading(false); }); }, [loadConfig]);
  const fetchSnapshot = useCallback(async (): Promise<Snapshot> => {
    if (!config) return {};
    const ids = moduleId === 'all' ? config.modules.filter(m => m.enabled).map(m => m.id) : [moduleId];
    if (moduleId === 'all') ids.push('for_you');
    const values = await Promise.all(ids.map(async id => [id, await call<NewsFeedItem[]>(() => api.news.feedList({ module_id: id === 'history' ? undefined : id, filter, search: query || undefined, history: id === 'history', limit: id === 'history' ? historyLimit : config.modules.find(m => m.id === id)?.max_items || 10, offset: 0 }))] as const));
    return Object.fromEntries(values);
  }, [config, moduleId, filter, query, historyLimit]);
  useEffect(() => {
    const generation = ++requestGeneration.current; setLoading(true); setPending(null); initialLoaded.current = false;
    void fetchSnapshot().then(value => { if (generation !== requestGeneration.current) return; setSnapshot(value); initialLoaded.current = true; }).catch(e => { if (generation === requestGeneration.current) setError(errorText(e)); }).finally(() => { if (generation === requestGeneration.current) setLoading(false); });
  }, [fetchSnapshot]);
  const checkUpdates = useCallback(async () => {
    if (!initialLoaded.current) return; const generation = requestGeneration.current;
    try { const value = await fetchSnapshot(); if (generation !== requestGeneration.current) return; if (JSON.stringify(value) !== JSON.stringify(snapshotRef.current)) setPending(value); const corrected = await call<NewsFeedItem[]>(() => api.news.feedList({ history: true, corrections_only: true, limit: 1000 })); if (generation === requestGeneration.current) setCorrectionItems(corrected); }
    catch (e) { setError(errorText(e)); }
  }, [fetchSnapshot]);
  useEffect(() => { const timer = setInterval(() => { void checkUpdates(); }, 15000); const focus = () => { void checkUpdates(); }; window.addEventListener('focus', focus); return () => { clearInterval(timer); window.removeEventListener('focus', focus); }; }, [checkUpdates]);
  const agent = useNewsAgent(() => { void checkUpdates(); void call<NewsInterestState>(() => api.news.feedInterests()).then(setInterests).catch(() => {}); });
  useEffect(() => { if (selected || page !== 'read') return; if (scroller.current) scroller.current.scrollTop = scrollTop.current; }, [selected, page]);
  useEffect(() => { const escape = (e: KeyboardEvent) => { if (e.key === 'Escape' && selected) setSelected(null); }; window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape); }, [selected]);
  const updateRow = (id: number, patch: Partial<NewsFeedItem>) => { const update = (value: Snapshot) => Object.fromEntries(Object.entries(value).map(([key, rows]) => [key, rows.map(row => row.id === id ? { ...row, ...patch } : row)])); setSnapshot(update); setPending(value => value ? update(value) : null); setSelected(value => value?.id === id ? { ...value, ...patch } : value); };
  const feedback = async (item: NewsFeedItem, kind: NewsFeedbackKind, topicKey?: string, readingToken?: string) => {
    try {
      if (['interested', 'less_topic', 'less_source'].includes(kind) && !config?.learning.enabled) { toast('兴趣学习已关闭，可在配置中开启后记录偏好'); return; }
      const result = await call<{ recorded: boolean; interests: NewsInterestState }>(() => api.news.feedFeedback({ news_id: item.id, kind, source: 'app', topic_key: topicKey, idempotency_key: `${readingSession.current}:${item.id}:${kind}:${topicKey?.slice(0, 35) || ''}:${kind === 'star' || kind === 'unstar' || kind === 'hide' || kind === 'undo_hide' ? crypto.randomUUID() : 'once'}`, ...(readingToken ? { reading_token: readingToken, reading_seconds: 22 } : {}) }));
      if (result.interests) setInterests(result.interests);
      if (kind === 'star' || kind === 'unstar') { const actual = result.recorded ? kind === 'star' : (await call<NewsFeedItem[]>(() => api.news.feedList({ history: true, filter: 'starred', search: item.title, limit: 1000 }))).some(row => row.id === item.id); updateRow(item.id, { is_starred: actual }); }
      if (kind === 'hide' || kind === 'undo_hide') { updateRow(item.id, { hidden: kind === 'hide' }); toast(kind === 'hide' ? '已隐藏；可在“已隐藏”筛选恢复' : '已恢复显示'); }
      if (kind === 'interested') toast('已记录感兴趣，下轮推荐会参考你的反馈');
      if (kind === 'less_topic') toast('已减少这个主题的推荐');
      if (kind === 'less_source') toast('已减少这个来源的推荐');
    } catch (e) { setError(errorText(e)); }
  };
  const openItem = (item: NewsFeedItem) => {
    scrollTop.current = scroller.current?.scrollTop || 0; setSelected(item); void feedback(item, 'open');
    if (!item.is_read) void call(() => api.news.markRead({ id: item.id, read: true })).then(() => updateRow(item.id, { is_read: true })).catch(e => setError(errorText(e)));
  };
  const toggleRead = async (item: NewsFeedItem) => { try { await call(() => api.news.markRead({ id: item.id, read: !item.is_read })); updateRow(item.id, { is_read: !item.is_read }); } catch (e) { setError(errorText(e)); } };
  const remove = async (item: NewsFeedItem) => {
    if (!window.confirm(`删除新闻「${item.title.slice(0, 40)}」？正文、已读与收藏会移除，历史引用保留来源快照；同一内容不会重新收录，删除不可恢复。`)) return;
    try { await call(() => api.news.delete({ id: item.id })); setSnapshot(value => Object.fromEntries(Object.entries(value).map(([key, rows]) => [key, rows.filter(row => row.id !== item.id)]))); setSelected(null); setPending(null); toast('新闻已删除'); } catch (e) { setError(errorText(e)); }
  };
  const correctionRead = async (id: string) => { try { await call(() => api.news.feedDismissCorrection({ id })); setCorrectionItems(value => value.map(row => ({ ...row, corrections: row.corrections.map(c => c.id === id ? { ...c, acknowledged: true } : c) })).filter(row => row.corrections.some(c => !c.acknowledged))); for (const rows of Object.values(snapshot)) for (const row of rows) if (row.corrections.some(c => c.id === id)) updateRow(row.id, { corrections: row.corrections.map(c => c.id === id ? { ...c, acknowledged: true } : c) }); } catch (e) { setError(errorText(e)); } };
  const navigate = (next: 'read' | 'config' | 'progress') => { if (dirty && page === 'config' && next !== 'config' && !window.confirm('配置草稿尚未保存，放弃修改并离开？')) return; scrollTop.current = scroller.current?.scrollTop || scrollTop.current; setDirty(false); setPage(next); };
  const explorationAction = async (action: 'follow' | 'reduce' | 'remove') => { if (!interests?.exploration) return; try { setInterests(await call<NewsInterestState>(() => api.news.feedManageTopic({ key: interests.exploration!.key, name: interests.exploration!.name, action }))); toast(action === 'follow' ? '已关注，下轮更新会搜索这个方向' : action === 'reduce' ? '已减少这个方向' : '候选已移除，可在配置中恢复'); } catch (e) { setError(errorText(e)); } };
  const selectModule = (id: string) => { setModuleId(id); setHistoryLimit(100); scrollTop.current = 0; };
  const enabledModules = config?.modules.filter(m => m.enabled) || [];
  const corrections = [...new Map([...correctionItems, ...Object.values(snapshot).flat()].filter(row => row.is_read && row.corrections.some(c => !c.acknowledged)).map(row => [row.id, row])).values()];
  const active = agent.batches.find(batch => batch.status === 'active');
  return <div className="panel news3 nf-panel">
    {error && <div className="notice error nf-global-error" role="alert"><span>{error}</span><button className="btn slim ghost" onClick={() => setError('')}>关闭提示</button></div>}
    {selected ? <NewsFeedReader item={selected} config={config} learningEpoch={interests?.epoch || 0} onBack={() => setSelected(null)} onFeedback={(item, kind, topic) => void feedback(item, kind, topic)} onRead={(id, token) => { const item = selected?.id === id ? selected : Object.values(snapshotRef.current).flat().find(row => row.id === id); if (item) void feedback(item, 'read', undefined, token); }} onToggleRead={item => void toggleRead(item)} onDelete={item => void remove(item)} onCorrectionRead={id => void correctionRead(id)} /> : page !== 'read' ? <section className="news3-collect nf-config-page" aria-label={page === 'config' ? '新闻配置页' : '新闻采集进度页'}><button className="backlink news3-back" onClick={() => navigate('read')}>返回新闻</button>{page === 'config' ? <NewsCollectionEditor moduleSeed={moduleSeed} onSeedConsumed={() => setModuleSeed(null)} onDirtyChange={setDirty} onSaved={() => void loadConfig()} /> : <NewsAgentControls agent={agent} disabled={dirty} />}</section> : <section className="news3-list" aria-label="新闻列表页">
      <header className="news3-list-head nf-list-head"><div className="nf-titlebar"><div><h1>新闻</h1><p>{active ? '正在核实新进展，现有内容可继续阅读' : agent.batches[0] ? `上轮 ${new Date(agent.batches[0].created_at).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} · 北京时间` : '按模块阅读 AI 整理的重点新闻'}</p></div><div className="nf-actions"><button className="btn slim" disabled={agent.busy} onClick={() => { if (!agent.status?.available) { navigate('progress'); return; } void agent.update(); }}>{active ? '继续查看当前更新' : '更新新闻'}</button><button className="btn slim" onClick={() => navigate('progress')}>采集进度</button><button className="btn slim" onClick={() => navigate('config')}>配置</button></div></div>
      <nav className="nf-module-tabs" aria-label="新闻模块">{[['all', '全部模块'], ...enabledModules.map(m => [m.id, m.name]), ['for_you', '猜你喜欢'], ['history', '历史新闻']].map(([id, name]) => <button className={moduleId === id ? 'active' : ''} key={id} aria-current={moduleId === id ? 'page' : undefined} onClick={() => selectModule(id)}>{name}</button>)}</nav>
      <div className="news3-toolbar"><div className="seg" aria-label="阅读状态">{Object.entries(labels).map(([key, value]) => <button className={`seg-item ${filter === key ? 'active' : ''}`} key={key} onClick={() => setFilter(key as Filter)}>{value}</button>)}</div><label className="news3-search"><IconSearch width={14} height={14} /><input aria-label="搜索新闻" placeholder="搜索已保存的新闻" value={search} onChange={e => setSearch(e.target.value)} /></label></div>
      </header>
      {pending && <div className="nf-update-notice" role="status"><span>有新进展，更新后查看最新精选</span><button className="btn slim" onClick={() => { setSnapshot(pending); setPending(null); }}>应用更新</button></div>}
      <div className="news3-scroll nf-feed-scroll" ref={scroller}>
        {corrections.length > 0 && <aside className="notice nf-correction-list"><strong>你读过的新闻有重要更正</strong>{corrections.map(row => <button key={row.id} className="nf-text-action" onClick={() => openItem(row)}>{row.title}</button>)}</aside>}
        {interests?.events.filter(event => event.reminder_due).map(event => <aside key={event.id} className="notice nf-event-reminder"><span>「{event.name}」近期较少查看，要继续关注吗？</span><button className="btn slim" onClick={() => void call(() => api.news.feedDismissEventReminder({ id: event.id })).then(loadConfig).catch(e => setError(errorText(e)))}>继续关注</button><button className="btn slim" onClick={() => void call(() => api.news.feedUpdateEvent({ id: event.id, status: 'paused', expected_revision: event.revision })).then(loadConfig).catch(e => setError(errorText(e)))}>暂停</button></aside>)}
        {loading ? <div className="nf-loading" role="status">正在读取已保存的新闻…</div> : Object.entries(snapshot).map(([id, sourceRows]) => {
          const module = enabledModules.find(m => m.id === id); const rows = sourceRows.filter(row => filter === 'hidden' ? row.hidden : !row.hidden); const shown = expanded.includes(id) || id === 'history' ? rows : rows.slice(0, module?.headline_count || 5); const name = id === 'for_you' ? '猜你喜欢' : id === 'history' ? '历史新闻' : module?.name || '新闻';
          const noEvents = module?.kind === 'events' && !interests?.events.some(event => event.status === 'active');
          return <section key={id} className="nf-module-group" aria-label={`${name}新闻`}><header className="nf-group-head"><h2>{name}</h2><span>{rows.length} 则{rows.length > shown.length ? ` · 先看 ${shown.length} 则重点` : ''}</span></header>
            {id === 'for_you' && <p className="nf-group-note">{interests?.enabled ? '依据明确关注和近期阅读；公共重要新闻继续保留。' : '学习尚未开启，可在配置中开启；明确关注与探索内容仍可阅读。'}{interests?.exploration ? ` 本轮探索：${interests.exploration.name}。${interests.exploration.reason}` : ''}</p>}
            {id === 'for_you' && interests?.exploration && <aside className="nf-exploration nf-feed-exploration"><strong>发现新方向：{interests.exploration.name}</strong><p>{interests.exploration.reason}</p><div className="nf-actions"><button className="btn slim" onClick={() => void explorationAction('follow')}>关注主题</button><button className="btn slim" onClick={() => { setModuleSeed({ name: interests.exploration!.name, scope: interests.exploration!.scope || interests.exploration!.name }); navigate('config'); }}>加入模块草稿</button><button className="btn slim" onClick={() => void explorationAction('reduce')}>少推荐</button><button className="btn slim" onClick={() => void explorationAction('remove')}>移除候选</button></div></aside>}
            {rows.length === 0 && <div className="empty nf-module-empty">{noEvents ? '当前没有有效时事关注。可在配置中恢复或新增事件。' : query ? '没有匹配的新闻，试试其他关键词。' : filter === 'starred' ? '本模块还没有收藏。' : filter === 'hidden' ? '没有已隐藏的新闻。' : filter === 'unread' ? '暂无未读内容。' : '还没有合格内容，更新后会显示在这里。'}</div>}
            {shown.map(item => <article key={item.id} className={`news3-row nf-news-row ${item.is_read ? 'read' : 'unread'}`}><div className="nf-row-content"><button className="nf-story-open" aria-label={`打开新闻：${item.title}`} onClick={() => openItem(item)}><span className="news3-row-title">{item.title}</span>{item.summary && <span className="news3-row-summary">{item.summary}</span>}</button><div className="news3-row-meta"><span className="ref-badge">{newsSource(item)}</span><time>{newsTime(item)}</time>{item.content_kind === 'brief' && <span className="ref-badge">专题简报</span>}{item.content_kind === 'html' && <span className="ref-badge">快照</span>}{item.is_read && <span>已读</span>}</div>{id === 'for_you' && <p className="nf-reason">{item.topic_keys?.length ? interests?.topics.filter(topic => item.topic_keys?.includes(topic.key)).flatMap(topic => topic.reasons.slice(0, 1)).join('；') || '探索推荐：试读一个可能感兴趣的方向' : '探索推荐：试读一个新方向'}</p>}<div className="nf-row-actions"><button className={`nf-text-action ${item.is_starred ? 'is-starred' : ''}`} aria-pressed={item.is_starred} onClick={() => void feedback(item, item.is_starred ? 'unstar' : 'star')}><IconStar width={12} height={12} />{item.is_starred ? '已收藏' : '收藏'}</button><button className="nf-text-action" onClick={() => void feedback(item, 'interested')}>感兴趣</button>{filter === 'hidden' && <button className="nf-text-action" onClick={() => void feedback(item, 'undo_hide')}>恢复显示</button>}</div></div>{(module?.content.image_policy || config?.content.image_policy) !== 'none' && (module?.content.image_display || config?.content.image_display) !== 'detail_only' && <button className="nf-image-open" aria-label={`查看${item.title}的详情与配图`} onClick={() => openItem(item)}><NewsFeedImage item={item} compact /></button>}</article>)}
            {rows.length > shown.length && <button className="btn nf-expand" onClick={() => setExpanded([...expanded, id])}>展开其余 {rows.length - shown.length} 则</button>}{expanded.includes(id) && rows.length > (module?.headline_count || 5) && <button className="btn nf-expand" onClick={() => setExpanded(expanded.filter(key => key !== id))}>收起更多新闻</button>}{id === 'history' && rows.length >= historyLimit && <button className="btn nf-expand" onClick={() => setHistoryLimit(value => value + 100)}>加载更多历史新闻</button>}
          </section>;
        })}
        {!loading && config?.modules.length === 0 && moduleId === 'all' && <div className="empty">还没有阅读模块，可在配置中新增。</div>}
      </div>
    </section>}
  </div>;
}
