import ActionButton from './ActionButton';
import { IconCheck, IconChevronDown, IconEye, IconEyeOff, IconHeart, IconRefresh, IconTrash } from './icons';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NewsFeedConfig, NewsFeedItem, NewsFeedbackKind } from '../../../../../../packages/core/src/news-types';
import { api, call } from '../api';
import { IconChevronLeft, IconExternal, IconStar } from './icons';
import type { WebViewElement } from '../webview';
import { toast } from './Toast';
import EmbeddedFrame from './EmbeddedFrame';

export const newsTime = (item: NewsFeedItem) => item.published_at ? new Date(item.published_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : item.published_date;
export const newsSource = (item: NewsFeedItem) => item.source_name || (item.source === 'agent' ? 'Agent 提交' : item.source);
const host = (url: string) => { try { return new URL(url).host; } catch { return '原始来源'; } };
const safeImage = (url?: string | null) => { try { const value = new URL(url || ''); return value.protocol === 'https:' && !value.username && !value.password; } catch { return false; } };

export function NewsFeedImage({ item, compact = false }: { item: NewsFeedItem; compact?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [item.image_url]);
  if (!safeImage(item.image_url)) return null;
  return <figure className={compact ? 'nf-image nf-thumbnail' : 'nf-image'}>{failed ? <div className="nf-image-fallback">来源图片暂时无法加载</div> : <img src={item.image_url!} alt={item.image_caption || `${item.title}的来源配图`} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />}{!compact && <figcaption>{item.image_caption || '来源配图'}{item.image_source_url && <ActionButton icon={IconExternal} className="nf-text-action" onClick={() => void call(() => api.news.openUrl({ url: item.image_source_url! })).catch(e => toast((e as Error).message))}>图片来源：{host(item.image_source_url)}</ActionButton>}</figcaption>}</figure>;
}

function useEffectiveReading(item: NewsFeedItem, enabled: boolean, epoch: number, onRead: (id: number, token: string) => void) {
  const content = useRef<HTMLElement | null>(null);
  const report = useRef(onRead); report.current = onRead;
  useEffect(() => {
    if (!enabled) return;
    let disposed = false; let accumulated = 0; let last = Date.now(); let lastAction = Date.now(); let visible = false; let sent = false; let token = ''; let pending = false;
    const element = content.current; if (!element) return;
    const observer = new IntersectionObserver(entries => { visible = entries.some(entry => entry.isIntersecting && entry.intersectionRatio > 0); }, { threshold: [0, 0.1] }); observer.observe(element);
    const action = () => { lastAction = Date.now(); };
    const pause = () => { last = Date.now(); };
    element.addEventListener('scroll', action, { passive: true }); element.addEventListener('wheel', action, { passive: true }); element.addEventListener('pointerdown', action); element.addEventListener('keydown', action);
    document.addEventListener('visibilitychange', pause); window.addEventListener('blur', pause);
    const tick = async () => {
      const now = Date.now(); const delta = Math.min(now - last, 1500); last = now;
      const foreground = document.visibilityState === 'visible' && document.hasFocus() && visible;
      if (disposed || sent || !foreground || now - lastAction > 60000) return;
      accumulated += delta;
      if (!pending) {
        pending = true;
        try { const state = await call<{ visible: boolean; token: string }>(() => api.news.feedReadingState({ id: item.id })); if (disposed) return; if (state.visible) token = state.token; else { accumulated = 0; token = ''; } }
        catch { token = ''; } finally { pending = false; }
      }
      if (accumulated >= 22000 && token && !disposed) { sent = true; report.current(item.id, token); }
    };
    const timer = setInterval(() => void tick(), 1000);
    return () => { disposed = true; observer.disconnect(); clearInterval(timer); element.removeEventListener('scroll', action); element.removeEventListener('wheel', action); element.removeEventListener('pointerdown', action); element.removeEventListener('keydown', action); document.removeEventListener('visibilitychange', pause); window.removeEventListener('blur', pause); };
  }, [item.id, enabled, epoch]);
  return content;
}

function LessRecommendations({ item, onFeedback }: { item: NewsFeedItem; onFeedback: (item: NewsFeedItem, kind: NewsFeedbackKind, topic?: string) => void }) {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null); const menu = useRef<HTMLDivElement>(null); const id = useId();
  const close = (restore = false) => { setPosition(null); if (restore) trigger.current?.focus(); };
  useEffect(() => {
    if (!position) return;
    menu.current?.querySelector('button')?.focus();
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setPosition(null); };
    const dismiss = () => setPosition(null);
    document.addEventListener('pointerdown', outside, true); window.addEventListener('resize', dismiss); window.addEventListener('scroll', dismiss, true);
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', dismiss); window.removeEventListener('scroll', dismiss, true); };
  }, [position]);
  useEffect(() => { setPosition(null); }, [item.id]);
  const show = () => {
    if (position) { close(true); return; }
    const rect = trigger.current!.getBoundingClientRect();
    const height = Math.min(((item.topic_keys || []).length + 1) * 38 + 10, window.innerHeight - 16);
    setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 248)), top: rect.bottom + 6 + height <= window.innerHeight - 8 ? rect.bottom + 6 : Math.max(8, rect.top - height - 6) });
  };
  return <><ActionButton ref={trigger} icon={IconChevronDown} className="btn slim" type="button" aria-haspopup="menu" aria-expanded={!!position} aria-controls={position ? id : undefined} onClick={show} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); if (!position) show(); } }}>减少推荐</ActionButton>
    {position && createPortal(<div ref={menu} id={id} className="cal-actions-menu nf-less-menu" role="menu" aria-label="减少推荐" style={position} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === 'Tab') close();
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button') || []); const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length; buttons[next]?.focus();
      }
    }}>{(item.topic_keys || []).map(key => <button type="button" role="menuitem" key={key} onClick={() => { close(true); onFeedback(item, 'less_topic', key); }}>少推荐「{key}」</button>)}<button type="button" role="menuitem" onClick={() => { close(true); onFeedback(item, 'less_source'); }}>减少这个来源</button></div>, document.body)}</>;
}

export default function NewsFeedReader({ item, config, learningEpoch, backLabel = '返回新闻列表', onBack, onFeedback, onRead, onDelete, onCorrectionRead }: {
  item: NewsFeedItem; config: NewsFeedConfig | null; learningEpoch: number; backLabel?: string; onBack: () => void;
  onFeedback: (item: NewsFeedItem, kind: NewsFeedbackKind, topic?: string) => void;
  onRead: (id: number, token: string) => void;
  onDelete: (item: NewsFeedItem) => void; onCorrectionRead: (id: string) => void;
}) {
  const [embedded, setEmbedded] = useState(false); const [nonce, setNonce] = useState(0); const [sourceStatus, setSourceStatus] = useState('加载中…'); const view = useRef<WebViewElement | null>(null);
  const content = useEffectiveReading(item, !!config?.learning.enabled, learningEpoch, onRead);
  const module = config?.modules.find(m => m.id === item.module_id); const options = { ...config?.content, ...module?.content };
  useEffect(() => { setEmbedded(false); setSourceStatus('加载中…'); }, [item.id]);
  useEffect(() => { const node = view.current; if (!node) return; const ready = () => setSourceStatus('已加载'); const failed = () => setSourceStatus('加载失败，可在浏览器打开原文'); node.addEventListener('dom-ready', ready); node.addEventListener('did-fail-load', failed); return () => { node.removeEventListener('dom-ready', ready); node.removeEventListener('did-fail-load', failed); }; }, [embedded, nonce, item.id]);
  const openSource = (url = item.url) => { onFeedback(item, 'source_open'); void call(() => api.news.openUrl({ url })).catch(e => toast((e as Error).message)); };
  const reloadSource = () => { setSourceStatus('加载中…'); setNonce(n => n + 1); };
  return <section className="news3-detail nf-reader" aria-label="新闻详情页">
    <div className="nf-reader-top"><ActionButton icon={IconChevronLeft} className="backlink news3-back" onClick={onBack}>{backLabel}</ActionButton><span className="nf-note">AI 整理 · 事实与分析分开展示</span></div>
    <article ref={content} className="news3-detail-body nf-reader-content" tabIndex={0} aria-label="新闻正文">
      <h1 className="news3-title">{item.title}</h1><div className="news3-detail-meta"><span className="ref-badge">{newsSource(item)}</span><time>{newsTime(item)}（北京时间）</time>{item.brief && <span className="ref-badge">专题简报 · {item.brief.items.length} 则</span>}{item.content_kind === 'html' && <span className="ref-badge">本地快照</span>}</div>
      <div className="nf-actions nf-reader-actions"><ActionButton icon={IconStar} className={`btn slim ${item.is_starred ? 'primary' : ''}`} aria-pressed={item.is_starred} onClick={() => onFeedback(item, item.is_starred ? 'unstar' : 'star')}>{item.is_starred ? '已收藏' : '收藏'}</ActionButton><ActionButton icon={IconHeart} className="btn slim" onClick={() => onFeedback(item, 'interested')}>感兴趣</ActionButton><LessRecommendations item={item} onFeedback={onFeedback} /><ActionButton icon={item.hidden ? IconEye : IconEyeOff} className="btn slim" onClick={() => { onFeedback(item, item.hidden ? 'undo_hide' : 'hide'); onBack(); }}>{item.hidden ? '恢复显示' : '隐藏这则'}</ActionButton><ActionButton icon={IconTrash} className="btn slim danger" onClick={() => onDelete(item)}>删除新闻</ActionButton></div>
      {item.corrections.map(c => <aside key={c.id} className="notice nf-correction"><strong>重要更正</strong><p>{c.summary}</p><ActionButton icon={IconExternal} className="nf-text-action" onClick={() => openSource(c.evidence_url)}>查看更正依据</ActionButton>{!c.acknowledged && <ActionButton icon={IconCheck} className="btn slim" onClick={() => onCorrectionRead(c.id)}>已了解更正</ActionButton>}<time>{new Date(c.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</time></aside>)}
      <div className="news3-content nf-summary">{item.summary || '此条旧内容尚无摘要，可查看已保存快照或原始来源。'}</div>
      {options.image_policy !== 'none' && <NewsFeedImage item={item} />}
      {item.background && options.show_background !== false && <section className="nf-reading-section"><h2>必要背景</h2><p>{item.background}</p></section>}
      {item.impact && options.show_impact !== false && <section className="nf-reading-section"><h2>影响与后续 <span>分析</span></h2><p>{item.impact}</p></section>}
      {item.brief && <section className="news3-brief"><h2>本期看点</h2><p>{item.brief.overview}</p><ol>{item.brief.items.map((entry, index) => <li key={index}><h3>{entry.title}</h3><p>{entry.summary}</p><div className="news3-brief-source"><time>{new Date(entry.published_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</time><a href={entry.source_url} onClick={e => { e.preventDefault(); openSource(entry.source_url); }}>阅读来源：{entry.source_name || host(entry.source_url)}</a></div></li>)}</ol></section>}
      {item.content_kind === 'html' && item.html_rel && <section className="nf-snapshot"><EmbeddedFrame label="新闻本地快照" className="nf-source-frame" title="已保存的本地快照" meta={sourceStatus} actions={<><ActionButton icon={IconRefresh} className="btn slim ghost" onClick={reloadSource}>重新加载</ActionButton><ActionButton icon={IconExternal} className="btn slim ghost" onClick={() => openSource()}>浏览器打开原文</ActionButton></>}><iframe key={`${item.id}:${nonce}`} className="news3-source-view" title="新闻本地快照" src={`news-file://n/${item.html_rel}`} sandbox="allow-same-origin" onLoad={() => setSourceStatus('已加载')} onError={() => setSourceStatus('加载失败，请重试')} /></EmbeddedFrame></section>}
      {item.content_kind === 'url' && safeImage(item.url) && <details className="nf-source-optional" onToggle={e => { const open = e.currentTarget.open; setEmbedded(open); if (open) setSourceStatus('加载中…'); }}><summary>在 App 内查看原始网页（需要联网）</summary>{embedded && <EmbeddedFrame label="新闻原始网页" className="nf-source-frame" title="原始网页" meta={sourceStatus} actions={<><ActionButton icon={IconRefresh} className="btn slim ghost" onClick={reloadSource}>重新加载</ActionButton><ActionButton icon={IconExternal} className="btn slim ghost" onClick={() => openSource()}>浏览器打开原文</ActionButton></>}><webview key={`${item.id}:${nonce}`} ref={view} className="news3-source-view" src={item.url} partition="news-source" allowpopups={false} /></EmbeddedFrame>}</details>}
    </article>
  </section>;
}
