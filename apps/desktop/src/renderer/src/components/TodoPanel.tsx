// 待办面板：搜索、日期分组、逾期横幅、行内编辑（Codex 风格）
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, call } from '../api';
import EmptyState from './EmptyState';
import { toast } from './Toast';
import { IconCalendar, IconPlus, IconSearch, IconX } from './icons';
import TodoSchedule, { type TodoScheduleValue } from './TodoSchedule';
import CheckinPanel from './CheckinPanel';

export interface Todo {
  id: number;
  title: string;
  notes: string;
  priority: 'high' | 'medium' | 'low';
  status: 'open' | 'done';
  due_date: string | null;
  start_time: string | null;
  end_time: string | null;
  tags: string[];
  source: string;
  completed_at: string | null;
  is_overdue: boolean;
}

type StatusFilter = 'open' | 'done' | 'all';

const SOURCE_LABEL: Record<string, string> = { app: '', mcp: 'AI', plan: '计划' };
const PRIORITY_LABEL: Record<Todo['priority'], string> = { high: '高', medium: '中', low: '低' };

function todayLocal(): string {
  return new Date().toLocaleDateString('sv-SE');
}

/** 按截止日期分组 */
function groupOf(t: Todo): string {
  if (t.status === 'done') return '已完成';
  if (!t.due_date) return '无日期';
  const today = todayLocal();
  if (t.is_overdue) return '已逾期';
  if (t.due_date === today) return '今天';
  if (t.due_date <= addDays(today, 3)) return '未来 3 天';
  return '稍后';
}

const GROUP_ORDER = ['已逾期', '今天', '未来 3 天', '稍后', '无日期', '已完成'];

function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return dt.toLocaleDateString('sv-SE');
}

export default function TodoPanel() {
  const [showRecords, setShowRecords] = useState(false);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [status, setStatus] = useState<StatusFilter>('open');
  const [priority, setPriority] = useState('');
  const [search, setSearch] = useState('');
  const [title, setTitle] = useState('');
  const [newPriority, setNewPriority] = useState<'high' | 'medium' | 'low'>('medium');
  const [schedule, setSchedule] = useState<TodoScheduleValue>({ due: todayLocal(), dateOnly: false, start: '', end: '' });
  const [tags, setTags] = useState('');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<({ id: number; title: string } & TodoScheduleValue) | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await call<Todo[]>(() =>
        api.todos.list({
          status,
          priority: priority || undefined,
          search: search.trim() || undefined,
        }),
      );
      setTodos(list);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [status, priority, search]);

  useEffect(() => {
    const t = setTimeout(() => void refresh(), search ? 200 : 0);
    return () => clearTimeout(t);
  }, [refresh, search]);

  useEffect(() => {
    const timer = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const scheduleInput = (value: TodoScheduleValue) => {
    if (!value.dateOnly && (!value.due || !value.start || !value.end)) throw new Error('请选择日期并填写开始时间和结束时间，或切换为「仅日期」');
    return { due_date: value.due || null, start_time: value.dateOnly ? null : value.start, end_time: value.dateOnly ? null : value.end };
  };

  const add = async () => {
    if (!title.trim()) {
      // 空提交：轻微脉冲提示输入框，而不是无响应
      const el = document.querySelector('.composer');
      el?.classList.remove('composer-pulse');
      void (el as HTMLElement | null)?.offsetWidth; // 重置动画
      el?.classList.add('composer-pulse');
      return;
    }
    try {
      const timing = scheduleInput(schedule);
      await call(() =>
        api.todos.add({
          title,
          priority: newPriority,
          ...timing,
          tags: tags.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
        }),
      );
      setTitle('');
      setError('');
      setTags('');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const toggle = async (t: Todo) => {
    await call(() => (t.status === 'open' ? api.todos.complete({ id: t.id }) : api.todos.reopen({ id: t.id })));
    await refresh();
  };

  const remove = async (t: Todo) => {
    await call(() => api.todos.delete({ id: t.id }));
    await refresh();
    toast(
      `已删除「${t.title.slice(0, 24)}」`,
      {
        label: '撤销',
        run: () => {
          void call(() =>
            api.todos.add({
              title: t.title,
              notes: t.notes,
              priority: t.priority,
              due_date: t.due_date,
              start_time: t.start_time,
              end_time: t.end_time,
              tags: t.tags,
            }),
          ).then(() => refresh());
        },
      },
    );
  };

  const saveEdit = async () => {
    if (!editing) return;
    try {
      const timing = scheduleInput(editing);
      await call(() => api.todos.update({ id: editing.id, title: editing.title, ...timing }));
      setEditing(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const groups = useMemo(() => {
    const map = new Map<string, Todo[]>();
    for (const t of todos) {
      const g = groupOf(t);
      map.set(g, [...(map.get(g) ?? []), t]);
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => [g, map.get(g)!] as const);
  }, [todos]);

  if (showRecords) return <CheckinPanel onBack={() => { setShowRecords(false); void refresh(); }} />;

  return (
    <div className="panel work-panel" role="region" aria-label="待办">
      {/* 筛选 */}
      <header className="panel-head todo-toolbar" aria-label="待办筛选">
        <div className="seg">
          {(['open', 'done', 'all'] as StatusFilter[]).map((s) => (
            <button key={s} className={`seg-item ${status === s ? 'active' : ''}`} onClick={() => setStatus(s)}>
              {s === 'open' ? '未完成' : s === 'done' ? '已完成' : '全部'}
            </button>
          ))}
        </div>
        <select className="filter-select" aria-label="筛选优先级" value={priority} onChange={(e) => setPriority(e.target.value)}>
          <option value="">全部优先级</option>
          <option value="high">高优先级</option>
          <option value="medium">中优先级</option>
          <option value="low">低优先级</option>
        </select>
        <span className="head-meta mono">{todos.length} 项{status === 'open' ? '未完成' : status === 'done' ? '已完成' : '待办'}</span>
        <span className="spacer" />
        <div className="searchbox">
          <IconSearch />
          <input placeholder="搜索待办" aria-label="搜索待办" value={search} onChange={(e) => setSearch(e.target.value)} />
          {search && (
            <button className="icon-btn" aria-label="清除搜索" onClick={() => setSearch('')}>
              <IconX width={13} height={13} />
            </button>
          )}
        </div>
        <button className="btn" onClick={() => setShowRecords(true)}>记录</button>
      </header>

      {/* 新增：一行式 */}
      <div className="composer todo-composer">
        <IconPlus className="composer-icon" />
        <input
          className="composer-input"
          placeholder="添加一条待办，回车保存"
          aria-label="待办标题"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
        />
        <select className="chip-select" aria-label="优先级" value={newPriority} onChange={(e) => setNewPriority(e.target.value as never)}>
          <option value="high">高</option>
          <option value="medium">中</option>
          <option value="low">低</option>
        </select>
        <TodoSchedule value={schedule} onChange={setSchedule} />
        <input
          className="chip-tags"
          placeholder="标签"
          aria-label="标签，逗号分隔"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
        />
        <button className="btn primary" onClick={() => void add()}>添加待办</button>
      </div>

      {error && <div className="notice error">{error}</div>}

      <div className="todo-groups">
        {todos.length === 0 && (search.trim() ? (
          <EmptyState
            icon={<IconSearch width={18} height={18} />}
            title={`没有匹配「${search.trim()}」的待办`}
            hint="换个关键词，或清除搜索查看全部待办。"
            action={<button className="btn slim" onClick={() => setSearch('')}>清除搜索</button>}
          />
        ) : status === 'open' ? (
          <EmptyState
            icon={<IconCalendar width={18} height={18} />}
            title="没有未完成的待办"
            hint="在上方输入一行即可添加；也可以在 zcode 中让 AI 通过 MCP 代加。"
          />
        ) : status === 'done' ? (
          <EmptyState
            icon={<IconCalendar width={18} height={18} />}
            title="还没有已完成的待办"
            hint="勾选待办左侧的圆钮，完成的记录会出现在这里。"
          />
        ) : (
          <EmptyState
            icon={<IconCalendar width={18} height={18} />}
            title="还没有待办"
            hint="在上方输入一行即可添加；也可以在 zcode 中让 AI 通过 MCP 代加。"
          />
        ))}
        {groups.map(([group, items]) => (
          <section key={group} className="group">
            <div className={`group-label mono ${group === '已逾期' ? 'danger' : ''}`}>
              {group}
              <span className="group-count">{items.length}</span>
            </div>
            {items.map((t) => (
              <div key={t.id} className={`todo-card ${t.status === 'done' ? 'done' : ''}`}>
                <div className="todo-card-main">
                  <button
                    className={`check ${t.status === 'done' ? 'checked' : ''} ${t.priority}`}
                    onClick={() => void toggle(t)}
                    title={t.status === 'open' ? '完成' : '重新打开'}
                  >
                    {t.status === 'done' && (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                        <path d="M4 12l5 5L20 6" />
                      </svg>
                    )}
                  </button>
                  {editing?.id === t.id ? (
                    <input
                      className="inline-input"
                      value={editing.title}
                      onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveEdit();
                        if (e.key === 'Escape') setEditing(null);
                      }}
                      autoFocus
                    />
                  ) : (
                    <>
                      <span className="todo-title" role="button" tabIndex={0}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditing({ id: t.id, title: t.title, due: t.due_date ?? '', dateOnly: !t.start_time, start: t.start_time ?? '', end: t.end_time ?? '' }); } }}
                        onClick={() => setEditing({ id: t.id, title: t.title, due: t.due_date ?? '', dateOnly: !t.start_time, start: t.start_time ?? '', end: t.end_time ?? '' })}>
                        {t.title}
                      </span>
                      <button className="icon-btn subtle" aria-label={`删除待办「${t.title.slice(0, 20)}」`} onClick={() => void remove(t)} title="删除">
                        <IconX width={14} height={14} />
                      </button>
                    </>
                  )}
                </div>
                {editing?.id === t.id ? (
                  <div className="todo-card-meta" onKeyDown={(e) => { if (e.key === 'Enter') void saveEdit(); if (e.key === 'Escape') setEditing(null); }}>
                    <TodoSchedule editing value={editing} onChange={(value) => setEditing({ ...editing, ...value })} />
                    <button className="btn primary slim" onClick={() => void saveEdit()}>保存</button>
                    <button className="btn slim" onClick={() => setEditing(null)}>取消</button>
                  </div>
                ) : (
                  <div className="todo-card-meta">
                    <span className={`prio ${t.priority}`}>{PRIORITY_LABEL[t.priority]}</span>
                    {t.due_date && (
                      <span className={`todo-meta mono ${t.is_overdue ? 'danger' : t.due_date === todayLocal() ? 'accent' : ''}`}>
                        {t.due_date}{t.start_time ? ` ${t.start_time}–${t.end_time}` : ' · 仅日期'}
                      </span>
                    )}
                    {t.tags.filter((tag) => !/^plan:\d+$/.test(tag)).map((tag) => (
                      <span key={tag} className="tag">{tag}</span>
                    ))}
                    {SOURCE_LABEL[t.source] && !(t.source === 'plan' && t.tags.includes('学习计划')) && <span className="origin mono">{SOURCE_LABEL[t.source]}</span>}
                  </div>
                )}
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
