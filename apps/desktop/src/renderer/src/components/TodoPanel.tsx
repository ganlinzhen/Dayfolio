// 待办工作区：按需展开新增、日期筛选、分组排序与完整行内编辑。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, call } from '../api';
import type { CalendarCollection } from '../../../../../../packages/core/src';
import EmptyState from './EmptyState';
import { toast } from './Toast';
import { IconCalendar, IconPlus, IconSearch, IconX } from './icons';
import TodoSchedule, { type TodoScheduleValue } from './TodoSchedule';
import CheckinPanel from './CheckinPanel';
import { addDays, GROUP_ORDER, groupOf, matchesDate, mergeTags, scheduleChanged, scheduleInput, scheduleOf, sortTodos, visibleTags, type DateFilter, type TodoSort } from './todo-view';
import './todo-panel.css';

export interface Todo {
  id: number;
  title: string;
  notes: string;
  priority: 'high' | 'medium' | 'low';
  status: 'open' | 'done';
  due_date: string | null;
  start_time: string | null;
  end_time: string | null;
  end_date: string | null;
  time_mode: 'floating'|'instant';
  scheduled_start_at: string|null;
  scheduled_end_at: string|null;
  revision: number;
  source_status: string|null;
  source_time_kind: string|null;
  collection_id: string | null;
  tags: string[];
  source: string;
  completed_at: string | null;
  is_overdue: boolean;
}


type StatusFilter = 'open' | 'done' | 'all';
type EditDraft = TodoScheduleValue & { original: Todo; title: string; notes: string; priority: Todo['priority']; tags: string };
const PRIORITIES: Record<Todo['priority'], string> = { high: '高优先级', medium: '中优先级', low: '低优先级' };
const DATE_FILTERS: { value: DateFilter; label: string }[] = [
  { value: 'all', label: '全部日期' }, { value: 'today', label: '今天' },
  { value: 'overdue', label: '已逾期' }, { value: 'week', label: '未来 7 天' }, { value: 'unscheduled', label: '无日期' },
];
const todayLocal = () => new Date().toLocaleDateString('sv-SE');
const defaultSchedule = (today: string): TodoScheduleValue => ({ due: today, dateOnly: false, start: '', end: '', endDate: '' });

export default function TodoPanel() {
  const [displayToday, setDisplayToday] = useState(todayLocal);
  const [showRecords, setShowRecords] = useState(false);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [collections, setCollections] = useState<CalendarCollection[]>([]);
  const [status, setStatus] = useState<StatusFilter>('open');
  const [priority, setPriority] = useState('');
  const [collectionId, setCollectionId] = useState('');
  const [search, setSearch] = useState('');
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const [sort, setSort] = useState<TodoSort>('date');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState('');
  const [newPriority, setNewPriority] = useState<Todo['priority']>('medium');
  const [schedule, setSchedule] = useState<TodoScheduleValue>(() => defaultSchedule(todayLocal()));
  const [tags, setTags] = useState('');
  const [notes, setNotes] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [moreFields, setMoreFields] = useState(false);
  const [editing, setEditing] = useState<EditDraft | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [editError, setEditError] = useState('');
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const requestId = useRef(0);
  const titleRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const editTrigger = useRef<HTMLElement | null>(null);
  const initializedDate = useRef(false);

  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    try {
      const [categories, overview] = await Promise.all([
        call<CalendarCollection[]>(() => api.calendar.listCollections()), call<{ date: string }>(() => api.today.get()),
      ]);
      if (id !== requestId.current) return;
      const selected = categories.some(c => c.id === collectionId) ? collectionId : '';
      if (selected !== collectionId) setCollectionId(selected);
      const list = await call<Todo[]>(() => api.todos.list({ status, priority: priority || undefined, search: search.trim() || undefined, collection_id: selected || undefined }));
      if (id !== requestId.current) return;
      setTodos(list); setCollections(categories); setDisplayToday(overview.date); setLoaded(true); setError('');
      if (!initializedDate.current) {
        initializedDate.current = true;
        setSchedule(prev => prev.due === todayLocal() && !prev.start ? { ...prev, due: overview.date } : prev);
      }
    } catch (e) { if (id === requestId.current) setError((e as Error).message); }
    finally { if (id === requestId.current) setLoading(false); }
  }, [status, priority, search, collectionId]);
  const refreshLatest = useRef(refresh);
  refreshLatest.current = refresh;

  useEffect(() => {
    // 筛选一变即使旧请求失效，防止防抖窗口内旧结果覆盖新条件。
    requestId.current++; setLoading(true);
    const timer = setTimeout(() => void refresh(), search ? 200 : 0);
    return () => { clearTimeout(timer); requestId.current++; };
  }, [refresh, search]);
  useEffect(() => {
    const update = () => void refreshLatest.current();
    const timer = setInterval(update, 60_000);
    window.addEventListener('dayfolio:changed', update);
    window.addEventListener('focus', update);
    return () => { clearInterval(timer); window.removeEventListener('dayfolio:changed', update); window.removeEventListener('focus', update); };
  }, []);
  useEffect(() => {
    if (showRecords) return;
    const keydown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      if (e.key === '/' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key.toLowerCase() === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); titleRef.current?.focus(); }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [showRecords]);

  // 使用 ref 同步上锁，连点和回车也不会重复写入；错误留在当前上下文。
  const mutate = async (action: () => Promise<void>, fail: (message: string) => void = setError) => {
    if (locked.current) return;
    locked.current = true; setBusy(true);
    try { await action(); await refreshLatest.current(); }
    catch (e) { const message = (e as Error).message; if (message.includes("REVISION_CONFLICT")) await refreshLatest.current(); fail(message); }
    finally { locked.current = false; setBusy(false); }
  };
  const resetComposer = () => {
    setTitle(''); setTags(''); setNotes(''); setNewPriority('medium'); setSchedule(defaultSchedule(displayToday));
    setFormError(''); setExpanded(false); setMoreFields(false);
  };
  const add = () => {
    setExpanded(true); setFormError('');
    if (!title.trim()) { setFormError('先写下要做的事。'); titleRef.current?.focus(); return; }
    void mutate(async () => {
      const timing = scheduleInput(schedule);
      await call(() => api.todos.add({ title: title.trim(), priority: newPriority, ...timing, tags: mergeTags(tags), notes }));
      resetComposer(); toast('已添加待办');
    }, setFormError);
  };
  const toggle = (t: Todo) => void mutate(async () => {
    await call(() => t.status === 'open' ? api.todos.complete({ id: t.id }) : api.todos.reopen({ id: t.id }));
    toast(t.status === 'open' ? '已完成待办' : '已重新打开待办', { label: '撤销', run: () => void mutate(async () => {
      await call(() => t.status === 'open' ? api.todos.reopen({ id: t.id }) : api.todos.complete({ id: t.id }));
    }) });
  });
  const remove = (t: Todo) => void mutate(async () => {
    await call(() => api.todos.delete({ id: t.id })); setDeleteId(null);
    let restored = false;
    toast(`已删除「${t.title.slice(0, 24)}」`, { label: '撤销', run: () => {
      if (restored) return;
      void mutate(async () => {
        const created = await call<Todo>(() => api.todos.add({
          title: t.title, notes: t.notes, priority: t.priority, tags: t.tags,
          ...(t.time_mode === 'instant' ? { time_mode: t.time_mode, scheduled_start_at: t.scheduled_start_at, scheduled_end_at: t.scheduled_end_at }
            : { due_date: t.due_date, end_date: t.end_date, start_time: t.start_time, end_time: t.end_time }),
          ...(!t.source_time_kind ? { collection_id: t.collection_id } : {}),
        }));
        restored = true;
        if (t.status === 'done') await call(() => api.todos.complete({ id: created.id }));
        toast('已重建独立待办；来源关联不会恢复');
      });
    } }, 6500);
  });
  const startEdit = (t: Todo, trigger: HTMLElement) => {
    if (busy) return;
    editTrigger.current = trigger; setDeleteId(null); setEditError('');
    setEditing({ original: t, title: t.title, notes: t.notes, priority: t.priority, tags: visibleTags(t.tags).join('，'), ...scheduleOf(t) });
  };
  const closeEdit = () => { const id = editing?.original.id; setEditing(null); setEditError(''); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-todo-id="${id}"] .todo-title`)?.focus()); };
  const saveEdit = () => {
    if (!editing) return;
    if (!editing.title.trim()) { setEditError('待办标题不能为空。'); return; }
    setEditError('');
    void mutate(async () => {
      // 只在用户改了排期时提交时间字段，保留固定时刻与来源跟随语义。
      const timing = scheduleChanged(editing.original, editing) ? scheduleInput(editing) : {};
      await call(() => api.todos.update({ id: editing.original.id, expected_revision: editing.original.revision, title: editing.title.trim(), notes: editing.notes, priority: editing.priority, tags: mergeTags(editing.tags, editing.original.tags), ...timing }));
      closeEdit(); toast('已保存待办');
    }, setEditError);
  };

  const filtered = useMemo(() => todos.filter(t => matchesDate(t, dateFilter, displayToday)), [todos, dateFilter, displayToday]);
  const groups = useMemo(() => {
    const map = new Map<string, Todo[]>();
    for (const t of sortTodos(filtered, sort)) { const key = groupOf(t, displayToday); const items = map.get(key) ?? []; items.push(t); map.set(key, items); }
    return GROUP_ORDER.filter(key => map.has(key)).map(key => [key, map.get(key)!] as const);
  }, [filtered, sort, displayToday]);
  const hasFilters = !!(search.trim() || priority || collectionId || dateFilter !== 'all');
  const clearFilters = () => { setSearch(''); setPriority(''); setCollectionId(''); setDateFilter('all'); };
  const visibleCount = (filter: DateFilter) => todos.filter(t => matchesDate(t, filter, displayToday)).length;

  if (showRecords) return <CheckinPanel onBack={() => { setShowRecords(false); void refreshLatest.current(); }} />;

  return <div className="panel work-panel todo-workspace" role="region" aria-label="待办">
    <header className="panel-head todo-toolbar" aria-label="待办筛选">
      <div className="seg" aria-label="待办状态">
        {(['open', 'done', 'all'] as const).map(s => <button key={s} className={`seg-item ${status === s ? 'active' : ''}`} aria-pressed={status === s} onClick={() => setStatus(s)}>{s === 'open' ? '未完成' : s === 'done' ? '已完成' : '全部'}</button>)}
      </div>
      <div className="searchbox">
        <IconSearch /><input ref={searchRef} placeholder="搜索标题或备注" aria-label="搜索待办" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { setSearch(''); e.currentTarget.blur(); } }} />
        {search ? <button className="icon-btn" aria-label="清除搜索" onClick={() => setSearch('')}><IconX width={13} height={13} /></button> : <kbd aria-hidden="true">/</kbd>}
      </div>
      <button className="btn" onClick={() => setShowRecords(true)}>记录</button>
    </header>

    <form className={`composer todo-composer-v2 ${expanded ? 'expanded' : ''}`} onSubmit={e => { e.preventDefault(); add(); }} onKeyDown={e => {
      if (e.key === 'Escape' && !busy) { e.preventDefault(); setExpanded(false); titleRef.current?.blur(); }
      if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault();
    }}>
      <div className="todo-composer-line">
        <IconPlus className="composer-icon" />
        <input ref={titleRef} className="composer-input" aria-label="待办标题" placeholder="接下来要做什么？" value={title} disabled={busy} onFocus={() => setExpanded(true)} onChange={e => setTitle(e.target.value)} aria-invalid={!!formError} aria-describedby={formError ? 'todo-add-error' : undefined} />
        <button type="submit" className="btn primary" disabled={busy || !title.trim()}>{busy ? '处理中…' : '添加待办'}</button>
      </div>
      {expanded && <div className="todo-composer-details">
        <div className="todo-quick-dates" aria-label="快速安排日期">
          <span>安排在</span>
          {[{ label: '今天', date: displayToday }, { label: '明天', date: addDays(displayToday, 1) }, { label: '暂不安排', date: '' }].map(item => <button key={item.label} type="button" className="btn ghost slim" aria-pressed={schedule.due === item.date} disabled={busy} onClick={() => setSchedule(prev => ({ ...prev, due: item.date, endDate: '', ...(item.date ? {} : { dateOnly: true, start: '', end: '' }) }))}>{item.label}</button>)}
        </div>
        <fieldset disabled={busy} className="todo-schedule-fieldset"><legend className="sr-only">新增待办排期</legend><TodoSchedule showLabels value={schedule} onChange={value => { setSchedule(value); setFormError(''); }} /></fieldset>
        <div className="todo-composer-options">
          <label className="todo-field-inline">优先级 <select className="chip-select" aria-label="优先级" value={newPriority} disabled={busy} onChange={e => setNewPriority(e.target.value as Todo['priority'])}>{Object.entries(PRIORITIES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <button className="btn ghost slim" type="button" aria-expanded={moreFields} aria-controls="todo-add-more" onClick={() => setMoreFields(!moreFields)}>备注与标签{notes || tags ? ' · 已填写' : ''}</button>
          <span className="spacer" /><button type="button" className="btn ghost slim" disabled={busy} onClick={resetComposer}>取消新增</button>
        </div>
        {moreFields && <div className="todo-extra-fields" id="todo-add-more">
          <label>备注<textarea value={notes} disabled={busy} placeholder="补充背景、链接或执行步骤" onChange={e => setNotes(e.target.value)} /></label>
          <label>标签<input value={tags} disabled={busy} placeholder="用逗号分隔，如 工作，周报" onChange={e => setTags(e.target.value)} /></label>
        </div>}
        <p className="todo-form-hint">时间段需填写开始时间；尚未确定钟点可选「仅日期」。回车添加，Esc 收起并保留草稿。</p>
      </div>}
      {formError && <div id="todo-add-error" className="notice error" role="alert">{formError}</div>}
    </form>

    <div className="todo-filterbar">
      <div className="todo-date-filters" aria-label="筛选安排日期">
        {DATE_FILTERS.map(item => <button key={item.value} className={`todo-date-filter ${dateFilter === item.value ? 'active' : ''}`} aria-pressed={dateFilter === item.value} onClick={() => setDateFilter(item.value)}>{item.label}<span>{visibleCount(item.value)}</span></button>)}
      </div>
      <div className="todo-secondary-filters">
        <select className="filter-select" aria-label="筛选优先级" value={priority} onChange={e => setPriority(e.target.value)}><option value="">全部优先级</option>{Object.entries(PRIORITIES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        <select className="filter-select todo-category-filter" aria-label="筛选待办分类" value={collectionId} onChange={e => setCollectionId(e.target.value)}><option value="">全部分类</option>{collections.filter(c => c.id !== 'builtin.local').map(c => <option key={c.id} value={c.id}>{c.title}{c.archived ? ' · 已归档' : ''}</option>)}</select>
        <label className="todo-sort">组内排序<select className="filter-select" aria-label="待办排序" value={sort} onChange={e => setSort(e.target.value as TodoSort)}><option value="date">时间先后</option><option value="priority">优先级</option><option value="newest">最近添加</option></select></label>
      </div>
    </div>
    <div className="todo-results" role="status" aria-live="polite"><span>{loading ? '正在更新…' : `${filtered.length} 项${status === 'open' ? '未完成' : status === 'done' ? '已完成' : '待办'}`}{hasFilters && !loading ? ' · 已筛选' : ''}</span>{hasFilters && <button className="btn ghost slim" onClick={clearFilters}>清除筛选</button>}<span className="spacer" /><span className="todo-key-hint">N 新增 · / 搜索</span></div>
    {error && <div className="notice error" role="alert">{error}<button className="btn slim" onClick={() => void refresh()}>重试</button></div>}
    {todos.length >= 500 && <p className="notice">当前最多显示 500 条匹配记录；日期筛选、计数和排序作用于这些记录，可通过关键词、分类或优先级缩小范围。</p>}
    <div className="todo-groups" aria-busy={loading}>
      {!loaded && loading ? <div className="todo-loading" aria-label="正在加载待办">{[0, 1, 2].map(n => <div key={n} />)}</div> : filtered.length === 0 && !loading && !error ? <EmptyState icon={search.trim() ? <IconSearch width={18} height={18} /> : <IconCalendar width={18} height={18} />} title={hasFilters ? '当前条件下没有待办' : status === 'done' ? '完成的待办会留在这里' : status === 'open' ? '待办已清空，给自己留点空闲' : '从一件小事开始'} hint={hasFilters ? '调整日期、分类或关键词，也可以一键清除筛选。' : status === 'done' ? '勾选待办左侧圆钮，即可留下完成记录。' : '写下接下来要做的事，给它安排一个合适的时间。'} action={<button className="btn slim" onClick={hasFilters ? clearFilters : () => titleRef.current?.focus()}>{hasFilters ? '清除筛选' : '添加第一条待办'}</button>} /> : groups.map(([group, items]) => <section key={group} className="group todo-group">
        <button className={`group-label todo-group-toggle ${group === '已逾期' ? 'danger' : ''}`} aria-expanded={!collapsed.has(group)} onClick={() => setCollapsed(prev => { const next = new Set(prev); if (next.has(group)) next.delete(group); else next.add(group); return next; })}><span className="todo-chevron" aria-hidden="true">{collapsed.has(group) ? '›' : '⌄'}</span>{group}<span className="group-count">{items.length}</span></button>
        {!collapsed.has(group) && items.map(t => <article key={t.id} data-todo-id={t.id} className={`todo-card ${t.status === 'done' ? 'done' : ''} ${editing?.original.id === t.id ? 'is-editing' : ''}`}>
          <div className="todo-card-main">
            <button className={`check ${t.status === 'done' ? 'checked' : ''} ${t.priority}`} disabled={busy} onClick={() => toggle(t)} aria-label={`${t.status === 'open' ? '完成待办' : '重新打开待办'}：${t.title}`} aria-pressed={t.status === 'done'}>{t.status === 'done' && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true"><path d="M4 12l5 5L20 6" /></svg>}</button>
            {editing?.original.id === t.id ? <textarea rows={2} className="inline-input todo-edit-title" aria-label="编辑待办标题" value={editing.title} disabled={busy} onChange={e => setEditing({ ...editing, title: e.target.value })} onKeyDown={e => { if (e.nativeEvent.isComposing) return; if (e.key === 'Enter') { e.preventDefault(); saveEdit(); } if (e.key === 'Escape' && !busy) closeEdit(); }} autoFocus /> : <>
              <button className="todo-title" title="编辑待办" disabled={busy} onClick={e => startEdit(t, e.currentTarget)}>{t.title}</button>
              <button className="icon-btn todo-delete" aria-label={`删除待办「${t.title.slice(0, 20)}」`} disabled={busy} onClick={() => setDeleteId(deleteId === t.id ? null : t.id)} title="删除待办"><IconX width={14} height={14} /></button>
            </>}
          </div>
          {editing?.original.id === t.id ? <div className="todo-inline-editor" onKeyDown={e => { if (e.nativeEvent.isComposing) return; if (e.key === 'Escape' && !busy) closeEdit(); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveEdit(); } }}>
            <fieldset disabled={busy} className="todo-schedule-fieldset"><legend className="sr-only">编辑待办排期</legend><TodoSchedule showLabels editing value={editing} onChange={value => setEditing({ ...editing, ...value })} /></fieldset>
            <div className="todo-extra-fields"><label>备注<textarea aria-label="编辑待办备注" value={editing.notes} disabled={busy} onChange={e => setEditing({ ...editing, notes: e.target.value })} placeholder="补充背景、链接或执行步骤" /></label><label>标签<input aria-label="编辑待办标签" value={editing.tags} disabled={busy} onChange={e => setEditing({ ...editing, tags: e.target.value })} placeholder="用逗号分隔" /></label></div>
            {t.source_time_kind && <p className="todo-form-hint">修改标题或排期后将按个人安排保存，后续来源更新不会覆盖。</p>}
            {editError && <div className="notice error" role="alert">{editError}{editError.includes('REVISION_CONFLICT') && <button className="btn slim" disabled={busy} onClick={() => { const latest = todos.find(item => item.id === t.id); if (latest) startEdit(latest, editTrigger.current!); }}>载入最新内容（放弃草稿）</button>}</div>}
            <div className="todo-editor-actions"><label className="todo-field-inline">优先级<select className="chip-select" aria-label="编辑优先级" value={editing.priority} disabled={busy} onChange={e => setEditing({ ...editing, priority: e.target.value as Todo['priority'] })}>{Object.entries(PRIORITIES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><span className="spacer" /><button className="btn slim" disabled={busy} onClick={closeEdit}>取消</button><button className="btn primary slim" disabled={busy} onClick={saveEdit}>{busy ? '保存中…' : '保存待办'}</button></div>
          </div> : <>
            {t.notes && <p className="todo-notes-preview">{t.notes}</p>}
            <div className="todo-card-meta">
              {t.due_date ? <span className={`todo-meta ${t.is_overdue ? 'danger' : ''}`}><IconCalendar width={12} height={12} /><time dateTime={t.due_date}>{t.due_date}{t.start_time ? ` ${t.start_time}${t.end_time ? `–${t.end_date && t.end_date !== t.due_date ? t.end_date + ' ' : ''}${t.end_time}` : ' · 结束待定'}` : ` · 仅日期${t.end_date ? ' 至 ' + t.end_date : ''}`}</time></span> : <span className="todo-meta">无日期</span>}
              <span className={`prio ${t.priority}`}>{PRIORITIES[t.priority]}</span>
              {t.collection_id && t.collection_id !== 'builtin.todo' && collections.some(c => c.id === t.collection_id) && <span className="tag todo-category">{collections.find(c => c.id === t.collection_id)!.title}</span>}
              {visibleTags(t.tags).filter(tag => tag !== collections.find(c => c.id === t.collection_id)?.title).map(tag => <span key={tag} className="tag">{tag}</span>)}
              {t.source === 'mcp' && <span className="origin">AI 创建</span>}{t.source === 'plan' && !t.tags.includes('学习计划') && <span className="origin">学习计划</span>}
              {t.source_status === 'cancelled' && <span className="tag">来源已取消</span>}{t.source_time_kind === 'tbd' && <span className="tag">来源时间待定</span>}
              {t.source.startsWith('tool:') && <button className="btn ghost slim todo-source" onClick={() => window.dispatchEvent(new CustomEvent('dayfolio:openTodo', { detail: { id: t.id } }))}>来源详情</button>}
            </div>
          </>}
          {deleteId === t.id && <div className="todo-delete-confirm" role="group" aria-label="确认删除待办"><span>删除这条待办？{t.source !== 'app' ? '来源关联不会随撤销恢复。' : '删除后可短暂撤销。'}</span><button className="btn slim" disabled={busy} onClick={() => setDeleteId(null)}>保留</button><button className="btn slim danger" disabled={busy} onClick={() => remove(t)}>确认删除</button></div>}
        </article>)}
      </section>)}
    </div>
  </div>;
}
