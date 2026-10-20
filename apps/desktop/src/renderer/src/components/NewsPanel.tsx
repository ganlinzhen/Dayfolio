// 新闻面板（agent-only）：任务/规则/结果/收藏的持久展示。
// - App 不抓取 RSS、不配置新闻源或凭证、无任何定时抓取入口；
// - 新闻由 AI 助手经 MCP 认领「新闻任务」后提交（带原始来源链接与摘要），离线时任务保持待执行；
// - 新闻按发布时间倒序，滚动到底部自动分页加载；
// - 内容两种形态：'url' 详情页内嵌来源网页；'html' 用 agent 提交的本地快照展示
//   （X/Twitter 等无法内嵌的来源；快照经 news-file:// 协议在 iframe 中加载，可外开原文）；
// - 旧新闻与收藏（is_starred）全部保留；已读/收藏为用户本地操作，与 MCP 共享同一状态。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, call } from '../api';
import EmbeddedFrame from './EmbeddedFrame';
import NewsCollectionEditor from './NewsCollectionEditor';
import type { NewsBrief } from '../../../../../../packages/core/src/types';
import { IconExternal, IconRefresh, IconSearch, IconStar, IconTrash, IconX } from './icons';
import { toast } from './Toast';
import type { WebViewElement } from '../webview';

interface NewsRow {
  id: number;
  source: string;
  title: string;
  url: string;
  summary: string;
  published_date: string;
  published_at: string | null;
  is_read: boolean;
  is_starred: boolean;
  task_id: number | null;
  source_name: string | null;
  content_kind: 'url' | 'html' | 'brief';
  brief: NewsBrief | null;
  html_rel: string | null;
}
interface NewsTask {
  id: number;
  title: string;
  instructions: string;
  max_items: number;
  window_hours: number;
  status: 'pending' | 'claimed' | 'completed' | 'cancelled';
  created_by: string;
  claimed_by: string | null;
  claim_expires_at: string | null;
  attempts: number;
  inserted_count: number;
  accepted_count: number;
  remaining: number;
  completed_at: string | null;
  completed_note: string | null;
  last_error: string | null;
  created_at: string;
}
type Filter = 'all' | 'unread' | 'starred';
type SourceStatus = 'idle' | 'loading' | 'ready' | 'failed';

const PAGE_SIZE = 30;

const STATUS_LABEL: Record<NewsTask['status'], string> = {
  pending: '等待 AI',
  claimed: '核实中',
  completed: '已完成',
  cancelled: '已取消',
};

const sourceBadge = (n: NewsRow): string => {
  if (n.source === 'agent') return n.source_name || 'Agent 提交';
  if (n.source === 'x') return 'X';
  return n.source;
};

/** 新闻发布时间统一按北京时间展示；入库时间使用 UTC ISO 字符串。 */
const publishedTime = (n: NewsRow): string => {
  if (!n.published_at) return n.published_date;
  const timestamp = Date.parse(n.published_at);
  if (Number.isNaN(timestamp)) return n.published_date;
  return new Date(timestamp + 8 * 60 * 60_000).toISOString().slice(0, 16).replace('T', ' ');
};

/** 内嵌原文只放行干净的 HTTPS 地址；其他来源保留外部打开入口 */
const isEmbeddableSource = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
};
const sourceHost = (url: string): string => {
  try { return new URL(url).host; } catch { return '原文'; }
};

const publishedSortValue = (n: NewsRow): number => {
  const timestamp = Date.parse(n.published_at ?? `${n.published_date}T23:59:59+08:00`);
  return Number.isNaN(timestamp) ? 0 : timestamp;
};

export default function NewsPanel() {
  const [items, setItems] = useState<NewsRow[]>([]);
  const [tasks, setTasks] = useState<NewsTask[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [taskFilter, setTaskFilter] = useState<number | null>(null); // 选中任务 → 只看该任务结果
  const [selected, setSelected] = useState<NewsRow | null>(null);
  const [sourceStatus, setSourceStatus] = useState<SourceStatus>('idle');
  const [sourceNonce, setSourceNonce] = useState(0);
  const [error, setError] = useState('');
  const [collectOpen, setCollectOpen] = useState(false);
  const [promptDirty, setPromptDirty] = useState(false);
  const leaveCollection = () => {
    if (promptDirty && !window.confirm('采集提示词尚未保存，放弃修改并返回新闻？')) return;
    setPromptDirty(false); setCollectOpen(false);
  };
  useEffect(() => {
    if (!promptDirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [promptDirty]);
  // 新建采集请求（用户在 App 发起；同一 core 硬校验，执行仍由 agent 经 MCP 认领）
  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState({ title: '', instructions: '', max_items: 10, window_hours: 24 });
  const [creating, setCreating] = useState(false);
  const [createdHint, setCreatedHint] = useState(0); // 刚创建的任务 id，短暂提示「等待助手认领」
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const savedScroll = useRef(0);
  const sourceViewRef = useRef<WebViewElement | null>(null);

  // 返回列表时恢复滚动位置：selected 变为 null 的提交之后直设 + 短延时重试（防未及布局丢赋值）
  useEffect(() => {
    if (selected) return;
    const top = savedScroll.current;
    if (top > 0 && listScrollRef.current) {
      listScrollRef.current.scrollTop = top;
      const timer = setTimeout(() => {
        if (listScrollRef.current) listScrollRef.current.scrollTop = top;
      }, 50);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // 切换新闻时重置内嵌原文状态；同一新闻标记已读不会触发重新加载
  useEffect(() => {
    setSourceStatus(selected ? 'loading' : 'idle');
  }, [selected?.id, selected?.url]);

  // webview 事件在 DOM 元素上派发；错误只看主 frame，取消加载不算失败
  useEffect(() => {
    const view = sourceViewRef.current;
    if (!selected || !view) return;
    // Electron webview 的 shadow DOM 内部 iframe 默认只有 150px 高；显式建立高度链
    const fixGuestViewport = () => {
      const style = view.shadowRoot?.querySelector('style');
      if (!style || style.dataset.todoDeskViewport === 'fixed') return;
      style.dataset.todoDeskViewport = 'fixed';
      style.textContent += ':host{display:block;width:100%;height:100%}:host iframe{width:100% !important;height:100% !important;flex:none !important;border:0 !important}';
    };
    fixGuestViewport();
    const markLoading = () => setSourceStatus('loading');
    const markReady = () => {
      fixGuestViewport();
      setSourceStatus('ready');
    };
    const markFailed = (event: Event) => {
      const detail = event as Event & { errorCode?: number; isMainFrame?: boolean };
      if (detail.isMainFrame === false || detail.errorCode === -3) return;
      setSourceStatus('failed');
    };
    view.addEventListener('did-attach', fixGuestViewport);
    view.addEventListener('did-start-loading', markLoading);
    view.addEventListener('did-navigate', markReady);
    view.addEventListener('dom-ready', markReady);
    view.addEventListener('did-fail-load', markFailed);
    return () => {
      view.removeEventListener('did-start-loading', markLoading);
      view.removeEventListener('did-navigate', markReady);
      view.removeEventListener('dom-ready', markReady);
      view.removeEventListener('did-fail-load', markFailed);
      view.removeEventListener('did-attach', fixGuestViewport);
    };
  }, [selected?.id, selected?.url, sourceNonce]);

  const refreshTasks = useCallback(async () => {
    const list = await call<NewsTask[]>(() => api.news.tasks({}));
    setTasks(list);
  }, []);

  const fetchNewsPage = useCallback(async (offset: number, append: boolean) => {
    const list = await call<NewsRow[]>(() =>
      api.news.list({
        task_id: taskFilter ?? undefined,
        search: search || undefined,
        filter,
        limit: PAGE_SIZE + 1,
        offset,
      }),
    );
    const more = list.length > PAGE_SIZE;
    const page = more ? list.slice(0, PAGE_SIZE) : list;
    setHasMore(more);
    if (!append) {
      setItems(page);
      return;
    }
    setItems((prev) => {
      const merged = new Map(prev.map((item) => [item.id, item]));
      for (const item of page) merged.set(item.id, item);
      return [...merged.values()].sort((a, b) => publishedSortValue(b) - publishedSortValue(a) || b.id - a.id);
    });
  }, [taskFilter, search, filter]);

  const refreshList = useCallback(async () => {
    await fetchNewsPage(0, false);
  }, [fetchNewsPage]);
  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore || selected || collectOpen) return;
    setLoadingMore(true);
    void fetchNewsPage(items.length, true)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoadingMore(false));
  }, [loadingMore, hasMore, selected, collectOpen, fetchNewsPage, items.length]);

  useEffect(() => { void refreshTasks().catch((e: Error) => setError(e.message)); }, [refreshTasks]);
  useEffect(() => { void refreshList().catch((e: Error) => setError(e.message)); }, [refreshList]);

  // 去掉手动刷新按钮后，窗口重新聚焦时静默同步本地库；App 仍不联网抓取
  useEffect(() => {
    const syncOnFocus = () => {
      void refreshList().catch(() => {});
      void refreshTasks().catch(() => {});
    };
    window.addEventListener('focus', syncOnFocus);
    return () => window.removeEventListener('focus', syncOnFocus);
  }, [refreshList, refreshTasks]);

  // 滚动接近列表底部时预加载下一页，避免等用户完全触底
  useEffect(() => {
    const sentinel = loadMoreRef.current;
    const scroller = listScrollRef.current;
    if (!sentinel || !scroller) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries.some((entry) => entry.isIntersecting)) loadMore(); },
      { root: scroller, rootMargin: '160px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore]);

  const activeTask = useMemo(() => tasks.find((t) => t.id === taskFilter) ?? null, [tasks, taskFilter]);
  const pendingCount = useMemo(() => tasks.filter((t) => t.status === 'pending' || t.status === 'claimed').length, [tasks]);

  // ---------- 阅读详情 ----------
  const openItem = (n: NewsRow) => {
    savedScroll.current = listScrollRef.current?.scrollTop ?? 0;
    setSelected(n);
    if (!n.is_read) {
      // 阅读即已读（真实行为，持久化；列表与 MCP 共享）
      void call<NewsRow>(() => api.news.markRead({ id: n.id, read: true }))
        .then((row) => {
          setItems((prev) => prev.map((x) => (x.id === row.id ? row : x)));
          setSelected((prev) => (prev?.id === row.id ? row : prev));
        })
        .catch(() => {});
    }
  };
  const backToList = () => {
    setSelected(null);
    // 滚动恢复在 selected 变化的 effect 里做：那里已过 React 提交，列表确已重新可见
  };
  const reloadSource = () => {
    setSourceStatus('loading');
    setSourceNonce((n) => n + 1);
  };
  const toggleStar = (n: NewsRow) => {
    void call<NewsRow>(() => api.news.markStarred({ id: n.id, starred: !n.is_starred }))
      .then((row) => {
        setItems((prev) => prev.map((x) => (x.id === row.id ? row : x)));
        setSelected((prev) => (prev && prev.id === row.id ? row : prev));
      })
      .catch((e: Error) => setError(e.message));
  };
  const toggleRead = (n: NewsRow) => {
    void call<NewsRow>(() => api.news.markRead({ id: n.id, read: !n.is_read }))
      .then((row) => {
        setItems((prev) => prev.map((x) => (x.id === row.id ? row : x)));
        setSelected((prev) => (prev && prev.id === row.id ? row : prev));
      })
      .catch((e: Error) => setError(e.message));
  };

  // ---------- 删除（用户手动确认，不可恢复；core 单事务 + 指纹防回流） ----------
  const removeItem = (n: NewsRow) => {
    const ok = window.confirm(
      `删除新闻「${n.title.slice(0, 40)}」？\n\n删除不可恢复：正文与收藏/已读状态一并移除；引用它的自媒体选题/素材会保留各自成果与来源快照；之后同一链接或同一事件的新闻不会被再次收录，且不返还 AI 采集任务的收录名额。`,
    );
    if (!ok) return;
    void call<{ deleted: boolean }>(() => api.news.delete({ id: n.id }))
      .then((res) => {
        if (!res.deleted) return; // 幂等：并发或重复请求已删 → 静默
        setItems((prev) => prev.filter((x) => x.id !== n.id));
        // 当前详情被删 → 回列表；滚动恢复沿用 selected 变化的 effect（savedScroll 仍在）
        setSelected((prev) => (prev && prev.id === n.id ? null : prev));
        toast('已删除该新闻（不可恢复）');
        void refreshList().catch(() => {});
        void refreshTasks().catch(() => {}); // 任务卡的「已收录」计数随之更新
      })
      .catch((e: Error) => setError(e.message));
  };

  // ---------- 任务：创建（用户发起，core 硬校验）/ 取消 ----------
  const createTaskSubmit = () => {
    if (creating) return;
    setCreating(true);
    void call<NewsTask>(() =>
      api.news.createTask({
        title: draft.title,
        instructions: draft.instructions.trim() || undefined,
        max_items: Number(draft.max_items) || undefined,
        window_hours: Number(draft.window_hours) || undefined,
      }),
    )
      .then((task) => {
        setFormOpen(false);
        setDraft({ title: '', instructions: '', max_items: 10, window_hours: 24 });
        setCreatedHint(task.id);
        setTimeout(() => setCreatedHint(0), 6000);
        setError('');
        void refreshTasks().catch(() => {});
      })
      .catch((e: Error) => setError(e.message)) // 硬校验错误原样透传（core 统一规则）
      .finally(() => setCreating(false));
  };

  const cancelTask = (t: NewsTask) => {
    void call<NewsTask>(() => api.news.cancelTask({ id: t.id }))
      .then(() => refreshTasks())
      .catch((e: Error) => setError(e.message));
  };

  // ---------- AI 采集请求：展示用户关心的目标、进度与结果，执行协议细节留在帮助文档 ----------
  const requestStatusHint = (t: NewsTask): string => {
    if (t.status === 'pending') return '等待下一次 AI 会话认领；App 不会自动联网或唤醒助手。';
    if (t.status === 'claimed') return t.claimed_by ? `${t.claimed_by} 正在搜索并核实来源。` : 'AI 正在搜索并核实来源。';
    if (t.status === 'cancelled') return '请求已取消；已收录的内容会保留在新闻库。';
    return t.inserted_count > 0 ? '结果已进入新闻库，可点击下方按钮查看。' : '时间窗内没有找到合格新闻。';
  };

  const requestCard = (t: NewsTask) => (
    <article key={t.id} className={`news3-request ${taskFilter === t.id ? 'active' : ''}`} aria-label={`AI 采集请求：${t.title}`}>
      <header className="news3-request-top">
        <span className={`news3-request-status s-${t.status}`}>{STATUS_LABEL[t.status]}</span>
        <span className="mono news3-request-count">
          {t.status === 'completed' && t.inserted_count === 0 ? '未收录新闻' : `已收录 ${t.inserted_count} 篇`}
          <span>上限 {t.max_items} 篇</span>
        </span>
      </header>
      <h3 className="news3-request-title">{t.title}</h3>
      {t.instructions && <p className="news3-request-instructions">要求：{t.instructions}</p>}
      <div className="mono news3-request-meta">
        <span>最近 {t.window_hours} 小时</span>
        <span>{t.created_by === 'app' ? '来自 App' : '来自 AI'}</span>
      </div>
      <p className="news3-request-hint">{requestStatusHint(t)}</p>
      <footer className="news3-request-actions">
        {t.inserted_count > 0 && (
          <button
            className="btn slim"
            onClick={() => { if (promptDirty && !window.confirm('采集提示词尚未保存，放弃修改并查看结果？')) return; setPromptDirty(false); setTaskFilter(t.id); setSelected(null); setCollectOpen(false); }}
          >查看 {t.inserted_count} 篇</button>
        )}
        {t.status === 'pending' && (
          <button className="btn slim ghost" onClick={() => cancelTask(t)}>取消请求</button>
        )}
      </footer>
    </article>
  );

  const collectPage = (
    <>
      <header className="news3-collect-head">
        <div>
          <h2 className="news3-collect-title">AI 采集</h2>
          <p className="news3-collect-desc">给 AI 助手一份新闻采集要求。App 不联网抓取；助手下次连接时搜索、核实来源，并把结果写入新闻库。</p>
        </div>
        <button className="btn slim primary" disabled={creating} onClick={() => setFormOpen((v) => !v)}>{formOpen ? '收起表单' : '新建采集'}</button>
      </header>
      <NewsCollectionEditor onCreated={() => { void refreshTasks().catch((e: Error) => setError(e.message)); }} onDirtyChange={setPromptDirty} />
      {createdHint > 0 && (
        <p className="mono news3-agent-hint" data-testid="created-hint">
          采集请求已创建，等待下一次 AI 会话执行。
        </p>
      )}
      {formOpen && (
        <div className="news3-request-form" role="form" aria-label="新建 AI 采集请求">
          <input
            aria-label="采集主题"
            placeholder="例如：AI 领域最近 24 小时重要新闻"
            value={draft.title}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
          />
          <textarea
            aria-label="给 AI 的要求"
            placeholder="关注方向、语言、排除项（可选）"
            rows={3}
            value={draft.instructions}
            onChange={(e) => setDraft((d) => ({ ...d, instructions: e.target.value }))}
          />
          <div className="news3-request-form-row">
            <label>最多收录 <input type="number" aria-label="最多收录条数" min={1} max={11} value={draft.max_items} onChange={(e) => setDraft((d) => ({ ...d, max_items: Number(e.target.value) }))} /> 篇</label>
            <label>只看最近 <input type="number" aria-label="时间范围小时" min={1} max={720} value={draft.window_hours} onChange={(e) => setDraft((d) => ({ ...d, window_hours: Number(e.target.value) }))} /> 小时</label>
          </div>
          <div className="news3-request-form-row">
            <button className="btn slim primary" disabled={creating || !draft.title.trim()} onClick={createTaskSubmit}>{creating ? '创建中…' : '创建采集请求'}</button>
            <button className="btn slim ghost" onClick={() => setFormOpen(false)}>取消</button>
          </div>
          <p className="mono news3-agent-hint">创建后不会立即联网。下一次 AI 助手连接 Dayfolio 时，会按这里的要求搜索、打开来源页面核实后提交。</p>
        </div>
      )}
      <div className="news3-request-list">
        {tasks.length === 0 && !formOpen && (
          <div className="news3-request-empty">
            <strong>还没有采集请求</strong>
            <span>写清主题、时间范围和最多收录篇数。它不是待办，也不会让 App 自动联网。</span>
          </div>
        )}
        {tasks.map(requestCard)}
      </div>
      <p className="mono news3-agent-hint">
        待执行的请求会一直保留；下次助手会话自动接力。每个请求累计最多入库 11 条，新闻库的历史展示不受这个上限影响。
      </p>
    </>
  );

  const detail = selected;
  const detailBody = (
    <div className="news3-detail-body">
      {detail ? (
        <>
          <h2 className="news3-title">{detail.title}</h2>
          <div className="news3-detail-meta mono">
            <span className="ref-badge">{sourceBadge(detail)}</span>
            {detail.brief && <span className="ref-badge">专题简报 · {detail.brief.items.length} 则</span>}
            {detail.content_kind === 'html' && <span className="ref-badge">本地快照</span>}
            {publishedTime(detail)}
            <span className="spacer" />
            <button className={`icon-btn ${detail.is_starred ? 'starred' : ''}`} title={detail.is_starred ? '取消收藏' : '收藏'} onClick={() => toggleStar(detail)}>
              <IconStar width={14} height={14} />
            </button>
            <button className="btn slim ghost" onClick={() => toggleRead(detail)}>{detail.is_read ? '标为未读' : '标为已读'}</button>
            <button className="btn slim danger ghost" title="删除这条新闻（不可恢复）" onClick={() => removeItem(detail)}>删除</button>
          </div>
          {/* 只展示真实入库的内容（agent 核实后的摘要），绝不伪造全文 */}
          <div className="news3-content">{detail.summary || '（这条内容没有可用摘要，点下方原文入口查看来源页面）'}</div>
          {detail.brief ? (
            <article className="news3-brief" aria-label="专题简报正文">
              <h3>本期看点</h3><p className="news3-brief-overview">{detail.brief.overview}</p>
              <ol>{detail.brief.items.map((entry, index) => <li key={`${index}:${entry.source_url}`}>
                <h3>{entry.title}</h3><p>{entry.summary}</p>
                <div className="news3-brief-source">
                  <span>{publishedTime({ ...detail, published_at: entry.published_at })}（北京时间）</span>
                  <a href={entry.source_url} onClick={(event) => {
                    event.preventDefault();
                    void call(() => api.news.openUrl({ url: entry.source_url })).catch((e: Error) => setError(e.message));
                  }}>阅读来源：{entry.source_name || sourceHost(entry.source_url)} <IconExternal width={12} height={12} /></a>
                </div>
              </li>)}</ol>
            </article>
          ) : detail.content_kind === 'html' && detail.html_rel ? (
            <EmbeddedFrame
              label="新闻本地快照内嵌阅读"
              className="news-source-embed"
              title="本地快照"
              meta={
                <span className={`news3-source-status s-${sourceStatus}`}>
                  {sourceStatus === 'loading' ? '加载中…' : sourceStatus === 'ready' ? '已加载' : sourceStatus === 'failed' ? '加载失败' : ''}
                </span>
              }
              actions={
                <>
                <button className="btn slim ghost" onClick={reloadSource} title="重新加载本地快照">
                  <IconRefresh width={13} height={13} />重新加载
                </button>
                <button className="btn slim ghost" onClick={() => void call(() => api.news.openUrl({ url: detail.url }))}>
                  <IconExternal width={13} height={13} />打开原文
                </button>
                </>
              }
            >
              {/* X/Twitter 等来源无法内嵌网页，改用 agent 提交的本地快照（news-file:// 协议，圈定在库旁 news 目录） */}
              <iframe
                key={`snap:${detail.id}:${detail.html_rel}:${sourceNonce}`}
                className="tool-iframe news3-source-view"
                title={`本地快照 · ${detail.title.slice(0, 30)}`}
                src={`news-file://n/${detail.html_rel}`}
                onLoad={() => setSourceStatus('ready')}
              />
            </EmbeddedFrame>
          ) : isEmbeddableSource(detail.url) ? (
            <EmbeddedFrame
              label="新闻原文内嵌阅读"
              className="news-source-embed"
              title={`原文 · ${sourceHost(detail.url)}`}
              meta={
                <span className={`news3-source-status s-${sourceStatus}`}>
                  {sourceStatus === 'loading' ? '加载中…' : sourceStatus === 'ready' ? '已加载' : sourceStatus === 'failed' ? '加载失败' : ''}
                </span>
              }
              actions={
                <>
                <button className="btn slim ghost" onClick={reloadSource} title="重新加载来源页面">
                  <IconRefresh width={13} height={13} />重新加载
                </button>
                <button className="btn slim ghost" onClick={() => void call(() => api.news.openUrl({ url: detail.url }))}>
                  <IconExternal width={13} height={13} />打开原文
                </button>
                </>
              }
            >
              <webview
                key={`view:${detail.id}:${detail.url}:${sourceNonce}`}
                ref={sourceViewRef}
                className="news3-source-view"
                src={detail.url}
                partition="news-source"
                allowpopups={false}
              />
            </EmbeddedFrame>
          ) : (
            <div className="news3-source-fallback">
              <span>这条来源不是 HTTPS 页面，不能内嵌显示。</span>
              <button className="btn" onClick={() => void call(() => api.news.openUrl({ url: detail.url }))}>
                <IconExternal width={13} height={13} />打开原文
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="news3-empty">从列表选择一条内容开始阅读</div>
      )}
    </div>
  );

  return (
    <div className="panel news3">
      {selected ? (
        <section className="news3-detail" aria-label="新闻详情页">
          <button className="backlink news3-back" onClick={backToList}>← 返回列表</button>
          {error && <div className="notice error" onClick={() => setError('')}>{error}</div>}
          {detailBody}
        </section>
      ) : collectOpen ? (
        <section className="news3-collect" aria-label="AI 采集页">
          <button className="backlink news3-back" onClick={leaveCollection}>← 返回新闻</button>
          {error && <div className="notice error" onClick={() => setError('')}>{error}</div>}
          {collectPage}
        </section>
      ) : (
      <section className="news3-list" aria-label="新闻列表页">
        <header className="news3-list-head">
          <div className="news3-toolbar">
            <div className="seg">
              {([['all', '全部'], ['unread', '未读'], ['starred', '收藏']] as Array<[Filter, string]>).map(([f, label]) => (
                <button key={f} className={`seg-item ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>{label}</button>
              ))}
            </div>
            <div className="news3-search">
              <IconSearch width={13} height={13} />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索库内新闻（本地查询，不联网）" aria-label="库内搜索" />
            </div>
            <button className="btn slim primary" onClick={() => { setSelected(null); setCollectOpen(true); }}>
              AI 采集{pendingCount ? ` · ${pendingCount}` : ''}
            </button>
          </div>
          {activeTask && (
            <div className="news3-collection-filter mono">
              来自采集：{activeTask.title} · {activeTask.inserted_count} 篇
              <button className="icon-btn" aria-label="清除任务过滤" onClick={() => setTaskFilter(null)}><IconX width={12} height={12} /></button>
            </div>
          )}
        </header>
        {error && <div className="notice error" onClick={() => setError('')}>{error}</div>}
        <div className="news3-scroll" ref={listScrollRef}>
          {items.length === 0 && <div className="empty">没有匹配的内容{filter === 'starred' ? '；收藏后会在「收藏」里出现' : ''}</div>}
          {items.map((n) => (
            // 行内含删除按钮，不能整体用 <button>（交互元素不可嵌套）：改为 role=button 的行容器
            <div
              key={n.id}
              className={`news3-row ${n.is_read ? 'read' : 'unread'}`}
              role="button"
              tabIndex={0}
              aria-label={`打开新闻：${n.title.slice(0, 30)}`}
              onClick={() => openItem(n)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  openItem(n);
                }
              }}
            >
              <span className="news3-unread-dot" title={n.is_read ? '已读' : '未读'} />
              <span className="news3-row-main">
                <span className="news3-row-title">{n.title}</span>
                {n.summary && n.summary !== n.title && <span className="news3-row-summary">{n.summary}</span>}
                <span className="news3-row-meta mono">
                  <span className="ref-badge">{sourceBadge(n)}</span>
                  {n.brief && <span className="ref-badge">专题简报 · {n.brief.items.length} 则</span>}
                  {n.content_kind === 'html' && <span className="ref-badge">快照</span>}
                  {publishedTime(n)}
                </span>
              </span>
              <span className={`news3-star ${n.is_starred ? 'on' : ''}`} title={n.is_starred ? '已收藏' : ''}><IconStar width={12} height={12} /></span>
              <button
                className="icon-btn subtle news3-row-del"
                aria-label={`删除新闻「${n.title.slice(0, 20)}」`}
                title="删除（不可恢复）"
                onClick={(e) => {
                  e.stopPropagation();
                  removeItem(n);
                }}
              >
                <IconTrash width={13} height={13} />
              </button>
            </div>
          ))}
          <div ref={loadMoreRef} className="news3-load-more mono" aria-live="polite">
            {loadingMore ? '正在加载更多…' : hasMore ? '继续下拉自动加载' : '已显示全部新闻'}
          </div>
        </div>
      </section>
      )}
    </div>
  );
}
