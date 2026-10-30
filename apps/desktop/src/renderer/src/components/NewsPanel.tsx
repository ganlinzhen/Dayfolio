import ActionButton from './ActionButton';
import { IconChart, IconChevronDown, IconEye, IconHeart, IconPause, IconPlus, IconSettings, IconX } from './icons';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { NewsDailyEdition, NewsDailyEditionPage, NewsFeedConfig, NewsFeedItem, NewsFeedbackKind, NewsInterestState } from '../../../../../../packages/core/src/news-types';
import { api, call } from '../api';
import NewsCollectionEditor from './NewsCollectionEditor';
import NewsAgentControls, { useNewsAgent } from './NewsAgentControls';
import NewsFeedReader, { NewsFeedImage, newsSource, newsTime } from './NewsFeedReader';
import { compactEditionSummary } from './news-edition-summary';
import { IconChevronLeft, IconRefresh, IconSearch, IconStar } from './icons';
import { toast } from './Toast';
import './news-feed.css';

type Filter = 'all' | 'unread' | 'starred' | 'hidden';
type Page = 'read' | 'config' | 'progress';
const labels: Record<Filter, string> = { all: '全部', unread: '未读', starred: '收藏', hidden: '已隐藏' };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const shortDateLabel = (date: string) => `${date.slice(5, 7)}.${date.slice(8, 10)}`;
const timeLabel = (stamp: string) => new Date(stamp).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit' });
const unique = <T extends { id: number | string }>(items: T[]): T[] => [...new Map(items.map(item => [item.id, item])).values()];
function NewsEditionTag({ edition }: { edition: Pick<NewsDailyEdition, 'date' | 'module_id' | 'module_name'> }) {
  const label = `${edition.date} ${edition.module_name}`;
  return <span className="nf-edition-tag" data-module-id={edition.module_id} title={label} aria-label={label}>{shortDateLabel(edition.date)}｜{edition.module_name}</span>;
}
const retainOrder = <T extends { id: number | string }>(previous: T[], incoming: T[]): T[] => {
  const next = new Map(incoming.map(item => [item.id, item]));
  return [...previous.filter(item => next.has(item.id)).map(item => next.get(item.id)!), ...incoming.filter(item => !previous.some(old => old.id === item.id))];
};

export default function NewsPanel() {
  const [config, setConfig] = useState<NewsFeedConfig | null>(null);
  const [interests, setInterests] = useState<NewsInterestState | null>(null);
  const [corrections, setCorrections] = useState<NewsFeedItem[]>([]);
  const [editions, setEditions] = useState<NewsDailyEdition[]>([]);
  const [homeFilter, setHomeFilter] = useState<Filter>('all');
  const [homeSearch, setHomeSearch] = useState('');
  const [homeQuery, setHomeQuery] = useState('');
  const [homeLimit, setHomeLimit] = useState(40);
  const [homeHasMore, setHomeHasMore] = useState(false);
  const [homeLoading, setHomeLoading] = useState(true);
  const [editionId, setEditionId] = useState<string | null>(null);
  const [editionPage, setEditionPage] = useState<NewsDailyEditionPage | null>(null);
  const [editionFilter, setEditionFilter] = useState<Filter>('all');
  const [editionSearch, setEditionSearch] = useState('');
  const [editionQuery, setEditionQuery] = useState('');
  const [editionLoading, setEditionLoading] = useState(false);
  const [selected, setSelected] = useState<NewsFeedItem | null>(null);
  const [page, setPage] = useState<Page>('read');
  const [dirty, setDirty] = useState(false);
  const [moduleSeed, setModuleSeed] = useState<{ name: string; scope: string } | null>(null);
  const [error, setError] = useState('');
  const scroller = useRef<HTMLDivElement | null>(null);
  const scroll = useRef({ home: 0, edition: 0 });
  const restore = useRef<'home' | 'edition' | null>(null);
  const homeAnchor = useRef<{ id: string; top: number } | null>(null);
  const homeGeneration = useRef(0), editionGeneration = useRef(0);
  const editionCriteria = useRef(''), homeCriteria = useRef('');
  const readingSession = useRef(crypto.randomUUID());
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const viewRef = useRef({ page, editionId }); viewRef.current = { page, editionId };

  useEffect(() => { const timer = setTimeout(() => setHomeQuery(homeSearch.trim()), 250); return () => clearTimeout(timer); }, [homeSearch]);
  useEffect(() => { const timer = setTimeout(() => setEditionQuery(editionSearch.trim()), 250); return () => clearTimeout(timer); }, [editionSearch]);
  const rememberHomeAnchor = () => {
    const node = scroller.current;
    if (!node || viewRef.current.editionId || selectedRef.current || viewRef.current.page !== 'read') return;
    if (node.scrollTop < 8) { homeAnchor.current = null; return; }
    const top = node.getBoundingClientRect().top;
    const row = [...node.querySelectorAll<HTMLElement>('[data-edition-id]')].find(item => item.getBoundingClientRect().bottom > top);
    homeAnchor.current = row ? { id: row.dataset.editionId!, top: row.getBoundingClientRect().top - top } : null;
  };
  const loadConfig = useCallback(async () => {
    const [value, profile, corrected] = await Promise.all([
      call<NewsFeedConfig>(() => api.news.feedConfig()), call<NewsInterestState>(() => api.news.feedInterests()),
      call<NewsFeedItem[]>(() => api.news.feedList({ history: true, corrections_only: true, limit: 500 })),
    ]);
    setConfig(previous => JSON.stringify(previous) === JSON.stringify(value) ? previous : value);
    setInterests(profile); setCorrections(corrected.filter(item => !item.hidden));
  }, []);
  useEffect(() => { void loadConfig().catch(error => { setError(errorText(error)); setHomeLoading(false); }); }, [loadConfig]);
  const fetchEditions = useCallback(async () => {
    const pages = await Promise.all(Array.from({ length: Math.ceil(homeLimit / 40) }, (_, index) => call<NewsDailyEdition[]>(() => api.news.feedDailyEditions({ filter: homeFilter, search: homeQuery || undefined, limit: 40, offset: index * 40 }))));
    return { items: unique(pages.flat()), hasMore: pages.at(-1)?.length === 40 };
  }, [homeFilter, homeQuery, homeLimit]);
  const fetchEdition = useCallback(async () => {
    if (!editionId) return null;
    // 先收齐当前匹配成员，再维持已展示顺序；仅查前五条会被新的重点排序挤走。
    const first = await call<NewsDailyEditionPage>(() => api.news.feedDailyEdition({ id: editionId, filter: editionFilter, search: editionQuery || undefined, limit: 100, offset: 0 }));
    const pages = [first, ...await Promise.all(Array.from({ length: Math.max(0, Math.ceil(first.total / 100) - 1) }, (_, index) => call<NewsDailyEditionPage>(() => api.news.feedDailyEdition({ id: editionId, filter: editionFilter, search: editionQuery || undefined, limit: 100, offset: (index + 1) * 100 }))))];
    const items = unique(pages.flatMap(value => value.items));
    return { ...pages[0], items, has_more: items.length < pages[0].total };
  }, [editionId, editionFilter, editionQuery]);
  const displayEdition = useCallback((previous: NewsDailyEditionPage | null, incoming: NewsDailyEditionPage, preserve: boolean) => {
    const ordered = preserve && previous?.edition.id === incoming.edition.id ? retainOrder(previous.items, incoming.items) : incoming.items;
    const items = ordered;
    return { ...incoming, items, has_more: items.length < incoming.total };
  }, []);
  useEffect(() => {
    const generation = ++homeGeneration.current;
    const criteria = JSON.stringify([homeFilter, homeQuery]);
    if (homeCriteria.current !== criteria) setHomeLoading(true);
    homeCriteria.current = criteria;
    void fetchEditions().then(value => { if (generation !== homeGeneration.current) return; setEditions(value.items); setHomeHasMore(value.hasMore); }).catch(error => { if (generation === homeGeneration.current) setError(errorText(error)); }).finally(() => { if (generation === homeGeneration.current) setHomeLoading(false); });
  }, [fetchEditions, homeFilter, homeQuery]);
  useEffect(() => {
    const generation = ++editionGeneration.current;
    if (!editionId) { editionCriteria.current = ''; setEditionLoading(false); return; }
    const criteria = JSON.stringify([editionId, editionFilter, editionQuery]);
    const preserve = editionCriteria.current === criteria; editionCriteria.current = criteria;
    if (!preserve) setEditionLoading(true);
    void fetchEdition().then(value => { if (generation === editionGeneration.current && value) setEditionPage(previous => displayEdition(previous, value, preserve)); }).catch(error => { if (generation === editionGeneration.current) setError(errorText(error)); }).finally(() => { if (generation === editionGeneration.current) setEditionLoading(false); });
  }, [editionId, editionFilter, editionQuery, fetchEdition, displayEdition]);
  const refresh = useCallback(async () => {
    const hg = homeGeneration.current, eg = editionGeneration.current;
    try {
      const [home, current, profile, corrected] = await Promise.all([fetchEditions(), fetchEdition(), call<NewsInterestState>(() => api.news.feedInterests()), call<NewsFeedItem[]>(() => api.news.feedList({ history: true, corrections_only: true, limit: 500 }))]);
      if (hg === homeGeneration.current) { rememberHomeAnchor(); setEditions(home.items); setHomeHasMore(home.hasMore); }
      if (eg === editionGeneration.current && current?.edition.id === viewRef.current.editionId) setEditionPage(previous => displayEdition(previous, current, true));
      setInterests(profile); setCorrections(corrected.filter(item => !item.hidden));
    } catch (error) { setError(errorText(error)); }
  }, [fetchEditions, fetchEdition, displayEdition]);
  useEffect(() => { const timer = setInterval(() => void refresh(), 15000); const focus = () => void refresh(); window.addEventListener('focus', focus); return () => { clearInterval(timer); window.removeEventListener('focus', focus); }; }, [refresh]);
  const agent = useNewsAgent(() => { void refresh(); });
  useLayoutEffect(() => {
    const node = scroller.current; if (!node || selected || page !== 'read') return;
    if (restore.current) { node.scrollTop = scroll.current[restore.current]; restore.current = null; }
    if (!editionId && homeAnchor.current) {
      const anchor = homeAnchor.current;
      const row = [...node.querySelectorAll<HTMLElement>('[data-edition-id]')].find(value => value.dataset.editionId === anchor.id);
      if (row) node.scrollTop += row.getBoundingClientRect().top - node.getBoundingClientRect().top - anchor.top;
      homeAnchor.current = null;
    }
  }, [selected, page, editionId, editions, editionPage]);
  const backFromArticle = () => { restore.current = editionId ? 'edition' : 'home'; setSelected(null); };
  const backToHome = () => { scroll.current.edition = scroller.current?.scrollTop || 0; restore.current = 'home'; setEditionId(null); setEditionPage(null); };
  useEffect(() => { const escape = (event: KeyboardEvent) => { if (event.key !== 'Escape' || document.querySelector('.embed-frame.is-fullscreen')) return; if (selected) backFromArticle(); else if (editionId && page === 'read') backToHome(); }; window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape); }, [selected, editionId, page]);
  const updateRow = (id: number, patch: Partial<NewsFeedItem>) => {
    setEditionPage(value => value ? { ...value, items: value.items.map(item => item.id === id ? { ...item, ...patch } : item) } : value);
    setSelected(value => value?.id === id ? { ...value, ...patch } : value);
  };
  const feedback = async (item: NewsFeedItem, kind: NewsFeedbackKind, topicKey?: string, readingToken?: string) => {
    try {
      if (['interested', 'less_topic', 'less_source'].includes(kind) && !config?.learning.enabled) { toast('兴趣学习已关闭，可在配置中开启后记录偏好'); return; }
      const result = await call<{ recorded: boolean; interests: NewsInterestState }>(() => api.news.feedFeedback({ news_id: item.id, kind, source: 'app', topic_key: topicKey, idempotency_key: `${readingSession.current}:${item.id}:${kind}:${topicKey?.slice(0, 35) || ''}:${['star', 'unstar', 'hide', 'undo_hide'].includes(kind) ? crypto.randomUUID() : 'once'}`, ...(readingToken ? { reading_token: readingToken, reading_seconds: 22 } : {}) }));
      setInterests(result.interests);
      if (kind === 'star' || kind === 'unstar') { const actual = result.recorded ? kind === 'star' : (await call<NewsFeedItem[]>(() => api.news.feedList({ history: true, filter: 'starred', search: item.title, limit: 500 }))).some(value => value.id === item.id); updateRow(item.id, { is_starred: actual }); }
      if (kind === 'hide' || kind === 'undo_hide') { updateRow(item.id, { hidden: kind === 'hide' }); toast(kind === 'hide' ? '已隐藏；可在“已隐藏”筛选恢复' : '已恢复显示'); }
      if (kind === 'interested') toast('已记录感兴趣，下轮推荐会参考你的反馈');
      if (kind === 'less_topic') toast('已减少这个主题的推荐');
      if (kind === 'less_source') toast('已减少这个来源的推荐');
      void refresh();
    } catch (error) { setError(errorText(error)); }
  };
  const openItem = (item: NewsFeedItem) => {
    scroll.current[editionId ? 'edition' : 'home'] = scroller.current?.scrollTop || 0; setSelected(item); void feedback(item, 'open');
    if (!item.is_read) void call(() => api.news.markRead({ id: item.id, read: true })).then(() => { updateRow(item.id, { is_read: true }); void refresh(); }).catch(error => setError(errorText(error)));
  };
  const openEdition = (edition: NewsDailyEdition) => {
    scroll.current.home = scroller.current?.scrollTop || 0; rememberHomeAnchor(); scroll.current.edition = 0;
    setEditionPage(null); setEditionFilter(homeFilter); setEditionSearch(homeSearch); setEditionQuery(homeQuery); setEditionId(edition.id); restore.current = 'edition';
  };
  const openCorrection = async (item: NewsFeedItem) => {
    try { const matches = await call<NewsDailyEdition[]>(() => api.news.feedDailyEditions({ search: item.title, limit: 20 })); if (matches[0]) { scroll.current.home = scroller.current?.scrollTop || 0; scroll.current.edition = 0; setEditionId(matches[0].id); setEditionFilter('all'); setEditionSearch(''); setEditionQuery(''); } openItem(item); }
    catch (error) { setError(errorText(error)); }
  };
  const toggleRead = async (item: NewsFeedItem) => { try { await call(() => api.news.markRead({ id: item.id, read: !item.is_read })); updateRow(item.id, { is_read: !item.is_read }); void refresh(); } catch (error) { setError(errorText(error)); } };
  const remove = async (item: NewsFeedItem) => {
    if (!window.confirm(`删除新闻「${item.title.slice(0, 40)}」？正文、已读与收藏会移除，历史引用保留来源快照；同一内容不会重新收录，删除不可恢复。`)) return;
    try { await call(() => api.news.delete({ id: item.id })); setEditionPage(value => value ? { ...value, items: value.items.filter(row => row.id !== item.id) } : value); backFromArticle(); toast('新闻已删除'); void refresh(); } catch (error) { setError(errorText(error)); }
  };
  const correctionRead = async (id: string) => { try { await call(() => api.news.feedDismissCorrection({ id })); setCorrections(value => value.map(item => ({ ...item, corrections: item.corrections.map(correction => correction.id === id ? { ...correction, acknowledged: true } : correction) })).filter(item => item.corrections.some(correction => !correction.acknowledged))); const item = selectedRef.current; if (item) updateRow(item.id, { corrections: item.corrections.map(correction => correction.id === id ? { ...correction, acknowledged: true } : correction) }); void refresh(); } catch (error) { setError(errorText(error)); } };
  const navigate = (next: Page) => {
    if (dirty && page === 'config' && next !== 'config' && !window.confirm('配置草稿尚未保存，放弃修改并离开？')) return;
    if (page === 'read') scroll.current[editionId ? 'edition' : 'home'] = scroller.current?.scrollTop || 0;
    if (next === 'read') restore.current = editionId ? 'edition' : 'home';
    setDirty(false); setPage(next);
  };
  const explorationAction = async (action: 'follow' | 'reduce' | 'remove') => { if (!interests?.exploration) return; try { setInterests(await call<NewsInterestState>(() => api.news.feedManageTopic({ key: interests.exploration!.key, name: interests.exploration!.name, action }))); toast(action === 'follow' ? '已关注，下轮更新会搜索这个方向' : action === 'reduce' ? '已减少这个方向' : '候选已移除，可在配置中恢复'); } catch (error) { setError(errorText(error)); } };
  const active = agent.batches.find(batch => batch.status === 'active');
  const current = editionId ? editionPage?.edition : null;
  const filter = editionId ? editionFilter : homeFilter, search = editionId ? editionSearch : homeSearch;
  const rows = editionPage?.items || [];
  const loading = editionId ? editionLoading : homeLoading;
  const setFilter = (value: Filter) => { if (editionId) { setEditionFilter(value); } else { setHomeFilter(value); setHomeLimit(40); } if (scroller.current) scroller.current.scrollTop = 0; };
  const setSearch = (value: string) => { if (editionId) { setEditionSearch(value); } else { setHomeSearch(value); setHomeLimit(40); } };

  return <div className="panel news3 nf-panel">
    {error && <div className="notice error nf-global-error" role="alert"><span>{error}</span><ActionButton icon={IconX} className="btn slim ghost" onClick={() => setError('')}>关闭提示</ActionButton></div>}
    {selected ? <NewsFeedReader item={selected} config={config} learningEpoch={interests?.epoch || 0} backLabel={editionId ? '返回新闻列表' : '返回每日汇总'} onBack={backFromArticle} onFeedback={(item, kind, topic) => void feedback(item, kind, topic)} onRead={(id, token) => { const item = selectedRef.current; if (item?.id === id) void feedback(item, 'read', undefined, token); }} onDelete={item => void remove(item)} onCorrectionRead={id => void correctionRead(id)} /> : page !== 'read' ? <section className="news3-collect nf-config-page" aria-label={page === 'config' ? '新闻配置页' : '新闻采集进度页'}><ActionButton icon={IconChevronLeft} className="backlink news3-back" onClick={() => navigate('read')}>{editionId ? '返回新闻列表' : '返回每日汇总'}</ActionButton>{page === 'config' ? <NewsCollectionEditor moduleSeed={moduleSeed} onSeedConsumed={() => setModuleSeed(null)} onDirtyChange={setDirty} onSaved={() => void loadConfig()} /> : <NewsAgentControls agent={agent} disabled={dirty} />}</section> : <section className="news3-list" aria-label={editionId ? '模块新闻列表页' : '每日模块汇总页'}>
      <header className="news3-list-head nf-list-head">
        {editionId && <div className="nf-edition-navigation"><ActionButton icon={IconChevronLeft} className="backlink news3-back" onClick={backToHome}>返回每日汇总</ActionButton><div className="nf-edition-heading" data-edition-revision={current?.revision}><h1>{current ? <NewsEditionTag edition={current} /> : '正在读取模块…'}</h1>{current && <span className="nf-edition-count">共 {current.news_count} 则新闻{current.matching_count !== current.news_count ? ` · 匹配 ${current.matching_count} 则` : ''}</span>}</div></div>}
        <div className="nf-titlebar news3-toolbar nf-daily-toolbar">
          <div className="seg" aria-label="阅读状态">{Object.entries(labels).map(([key, value]) => <button className={`seg-item ${filter === key ? 'active' : ''}`} key={key} onClick={() => setFilter(key as Filter)}>{value}</button>)}</div>
          <label className="news3-search"><IconSearch width={14} height={14} /><input aria-label="搜索新闻" placeholder={editionId ? '搜索本期新闻' : '搜索已保存的新闻'} value={search} onChange={event => setSearch(event.target.value)} /></label>
          <div className="nf-actions"><ActionButton icon={IconRefresh} className="btn slim" disabled={agent.busy || !!active} onClick={() => { if (!agent.status?.available) { navigate('progress'); return; } void agent.update(); }}>{active ? '正在更新' : '更新新闻'}</ActionButton><ActionButton icon={IconChart} className="btn slim" onClick={() => navigate('progress')}>采集进度</ActionButton><ActionButton icon={IconSettings} className="btn slim" onClick={() => navigate('config')}>配置</ActionButton></div>
        </div>
      </header>
      <div className="news3-scroll nf-feed-scroll" ref={scroller}>
        {!editionId && corrections.length > 0 && <aside className="notice nf-correction-list"><strong>你读过的新闻有重要更正</strong>{corrections.map(item => <button key={item.id} className="nf-text-action" onClick={() => void openCorrection(item)}>{item.title}</button>)}</aside>}
        {!editionId && interests?.events.filter(event => event.reminder_due).map(event => <aside key={event.id} className="notice nf-event-reminder"><span>「{event.name}」近期较少查看，要继续关注吗？</span><ActionButton icon={IconHeart} className="btn slim" onClick={() => void call(() => api.news.feedDismissEventReminder({ id: event.id })).then(loadConfig).catch(error => setError(errorText(error)))}>继续关注</ActionButton><ActionButton icon={IconPause} className="btn slim" onClick={() => void call(() => api.news.feedUpdateEvent({ id: event.id, status: 'paused', expected_revision: event.revision })).then(loadConfig).catch(error => setError(errorText(error)))}>暂停</ActionButton></aside>)}
        {loading ? <div className="nf-loading" role="status">正在读取已保存的内容…</div> : !editionId ? <>
          {editions.map(edition => <article className="nf-edition-row" data-edition-id={edition.id} key={edition.id}>
            <button className="nf-edition-open" aria-label={`打开${edition.date}${edition.module_name}每日汇总`} onClick={() => openEdition(edition)}>
              <p className={`nf-edition-summary ${edition.summary ? '' : 'nf-summary-pending'}`}><NewsEditionTag edition={edition} /><span className="nf-edition-copy">{edition.summary ? compactEditionSummary(edition.summary, edition.module_name) : (edition.summary_status === 'stale' ? '重点内容有变化，等待重新整理总结。' : edition.news_count ? (active ? '新闻已收录，重点总结正在整理。' : '新闻已收录，重点总结待整理。') : (active ? '正在收集本期新闻。' : '本期暂未收录合格新闻。'))}</span></p>
              <div className="nf-edition-meta"><span>共 {edition.news_count} 则新闻</span>{edition.unread_count > 0 && <span>{edition.unread_count} 则未读</span>}{edition.matching_count !== edition.news_count && <span>匹配 {edition.matching_count} 则</span>}{edition.summary && edition.summary_status === 'stale' && <span className="nf-note">有新进展，重点总结待更新</span>}<span className="nf-edition-time">更新于 {timeLabel(edition.updated_at)}</span><span className="nf-edition-enter">查看本期新闻</span></div>
            </button>
          </article>)}
          {editions.length === 0 && <div className="empty nf-module-empty">{homeQuery || homeFilter !== 'all' ? '没有符合筛选条件的每日汇总。可以调整筛选或搜索关键词。' : '更新新闻后，每天每个模块会在这里保留一条重点总结。'}</div>}
          {homeHasMore && <ActionButton icon={IconChevronDown} className="btn nf-expand" onClick={() => setHomeLimit(value => value + 40)}>加载更多汇总</ActionButton>}
        </> : <>
          {current?.module_id === 'for_you' && interests?.exploration && <aside className="nf-exploration nf-feed-exploration"><strong>发现新方向：{interests.exploration.name}</strong><p>{interests.exploration.reason}</p><div className="nf-actions"><ActionButton icon={IconHeart} className="btn slim" onClick={() => void explorationAction('follow')}>关注主题</ActionButton><ActionButton icon={IconPlus} className="btn slim" onClick={() => { setModuleSeed({ name: interests.exploration!.name, scope: interests.exploration!.scope || interests.exploration!.name }); navigate('config'); }}>加入模块草稿</ActionButton><ActionButton icon={IconChevronDown} className="btn slim" onClick={() => void explorationAction('reduce')}>少推荐</ActionButton><ActionButton icon={IconX} className="btn slim" onClick={() => void explorationAction('remove')}>移除候选</ActionButton></div></aside>}
          {rows.map(item => <article key={item.id} className={`news3-row nf-news-row ${item.is_read ? 'read' : 'unread'}`}>
            <div className="nf-row-content">
              <button className="nf-story-open" aria-label={`打开新闻：${item.title}`} onClick={() => openItem(item)}><span className="news3-row-title">{item.title}</span>{item.summary && <span className="news3-row-summary">{item.summary}</span>}</button>
              {current?.module_id === 'for_you' && <p className="nf-reason">{item.topic_keys?.length ? interests?.topics.filter(topic => item.topic_keys?.includes(topic.key)).flatMap(topic => topic.reasons.slice(0, 1)).join('；') || '探索推荐：试读一个可能感兴趣的方向' : '探索推荐：试读一个新方向'}</p>}
            </div>
            {(config?.modules.find(module => module.id === item.module_id)?.content.image_policy || config?.content.image_policy) !== 'none' && (config?.modules.find(module => module.id === item.module_id)?.content.image_display || config?.content.image_display) !== 'detail_only' && <button className="nf-image-open" aria-label={`查看${item.title}的详情与配图`} onClick={() => openItem(item)}><NewsFeedImage item={item} compact /></button>}
            <div className="nf-row-footer">
              <div className="news3-row-meta"><span className="ref-badge nf-source-badge" title={newsSource(item)}>{newsSource(item)}</span><time title={newsTime(item)}>{newsTime(item)}</time>{item.is_read && <span>已读</span>}</div>
              <div className="nf-row-actions"><ActionButton icon={IconStar} className={`nf-text-action ${item.is_starred ? 'is-starred' : ''}`} aria-pressed={item.is_starred} onClick={() => void feedback(item, item.is_starred ? 'unstar' : 'star')}>{item.is_starred ? '已收藏' : '收藏'}</ActionButton><ActionButton icon={IconHeart} className="nf-text-action" onClick={() => void feedback(item, 'interested')}>感兴趣</ActionButton>{filter === 'hidden' && <ActionButton icon={IconEye} className="nf-text-action" onClick={() => void feedback(item, 'undo_hide')}>恢复显示</ActionButton>}</div>
            </div>
          </article>)}
          {rows.length === 0 && <div className="empty nf-module-empty">{editionQuery || filter !== 'all' ? '本期没有符合筛选条件的新闻。' : '本期暂未收录合格新闻，整理结果会自动显示。'}</div>}
        </>}
      </div>
    </section>}
  </div>;
}
