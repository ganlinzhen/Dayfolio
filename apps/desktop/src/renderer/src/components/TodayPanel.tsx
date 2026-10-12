// 今日仪表盘：逾期/今日到期/今日学习/打卡状态一屏看全（Codex 风格）
import { useCallback, useEffect, useState } from 'react';
import { api, call } from '../api';
import EmptyState from './EmptyState';
import { IconCalendar, IconItemType } from './icons';
import type { Todo } from './TodoPanel';

interface PlanItemToday {
  id: number;
  date: string;
  content: string;
  item_type: 'learn' | 'review' | 'practice' | 'rest';
  status: 'pending' | 'done' | 'skipped';
  plan_title: string;
}

interface Overview {
  date: string;
  overdue_todos: Todo[];
  due_today_todos: Todo[];
  completed_today_todos: Todo[];
  today_plan_items: PlanItemToday[];
  streak: number;
  summary_text: string;
  summary: { todo_done_count: number; plan_item_done_count: number; manual_checkin_count: number };
}

const TYPE_LABEL: Record<string, string> = { learn: '学习', review: '复习', practice: '练习', rest: '休息' };
const PRIORITY_LABEL: Record<Todo['priority'], string> = { high: '高', medium: '中', low: '低' };

export default function TodayPanel() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      setOv(await call<Overview>(() => api.today.get({})));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const completeTodo = async (id: number) => {
    await call(() => api.todos.complete({ id }));
    await refresh();
  };
  const doneItem = async (id: number) => {
    await call(() => api.plans.updateItemStatus({ id, status: 'done' }));
    await refresh();
  };
  const dayCheckin = async () => {
    await call(() => api.checkins.checkin({ ref_type: 'day' }));
    await refresh();
  };

  if (!ov)
    return (
      <div className="panel">
        {error ? (
          <EmptyState
            title="今日概览加载失败"
            hint={error}
            action={<button className="btn" onClick={() => void refresh()}>重试</button>}
          />
        ) : (
          <div className="skel-wrap">
            <div className="skel" style={{ width: 96, height: 26 }} />
            <div className="skel" style={{ width: '62%', height: 14 }} />
            <div className="skel-row"><div className="skel" /><div className="skel" /><div className="skel" /></div>
          </div>
        )}
      </div>
    );

  const dayChecked = ov.summary.manual_checkin_count > 0;
  const planPending = ov.today_plan_items.filter((i) => i.status === 'pending');

  return (
    <div className="panel">
      <header className="panel-head">
        <h1>今日</h1>
        <div className="head-meta mono">{ov.date}</div>
      </header>
      <p className="sub">{ov.summary_text}</p>

      {/* 概览数字 */}
      <div className="stat-row">
        <div className="stat">
          <div className="stat-num serif">{ov.summary.todo_done_count}</div>
          <div className="stat-label">今日完成待办</div>
        </div>
        <div className="stat">
          <div className="stat-num serif">
            {ov.summary.plan_item_done_count}/{ov.today_plan_items.length}
          </div>
          <div className="stat-label">今日学习打卡</div>
        </div>
        <div className="stat">
          <div className="stat-num serif">{ov.streak}</div>
          <div className="stat-label">连续打卡天数</div>
        </div>
        <div className="stat">
          <button className={`btn ${dayChecked ? '' : 'primary'}`} disabled={dayChecked} onClick={() => void dayCheckin()}>
            {dayChecked ? '今日已打卡' : '每日打卡'}
          </button>
        </div>
      </div>

      {ov.overdue_todos.length > 0 && (
        <div className="notice warn">
          <IconCalendar />
          {ov.overdue_todos.length} 项待办已逾期
        </div>
      )}
      {error && <div className="notice error">{error}</div>}

      {ov.overdue_todos.length > 0 && (
        <section className="group">
          <div className="group-label mono danger">
            已逾期<span className="group-count">{ov.overdue_todos.length}</span>
          </div>
          {ov.overdue_todos.map((t) => {
            const overdueDays = t.due_date ? Math.round((Date.parse(ov.date) - Date.parse(t.due_date)) / 86400000) : 0;
            return (
              <div key={t.id} className="todo-card">
                <div className="todo-card-main">
                  <button className={`check ${t.priority}`} onClick={() => void completeTodo(t.id)} title="完成" />
                  <span className="todo-title">{t.title}</span>
                </div>
                <div className="todo-card-meta">
                  <span className={`prio ${t.priority}`}>{PRIORITY_LABEL[t.priority]}</span>
                  {t.due_date && (
                    <span className="todo-meta mono danger">
                      {t.due_date}{overdueDays > 0 ? ` · 逾期 ${overdueDays} 天` : ''}
                    </span>
                  )}
                  {t.tags.map((tag) => <span key={tag} className="tag">{tag}</span>)}
                </div>
              </div>
            );
          })}
        </section>
      )}

      <section className="group">
        <div className="group-label mono">
          今天到期<span className="group-count">{ov.due_today_todos.length}</span>
        </div>
        {ov.due_today_todos.length === 0 && <div className="sub row-pad">今天没有到期事项</div>}
        {ov.due_today_todos.map((t) => (
          <div key={t.id} className="todo-card">
            <div className="todo-card-main">
              <button className={`check ${t.priority}`} onClick={() => void completeTodo(t.id)} title="完成" />
              <span className="todo-title">{t.title}</span>
            </div>
            <div className="todo-card-meta">
              <span className={`prio ${t.priority}`}>{PRIORITY_LABEL[t.priority]}</span>
              {t.tags.map((tag) => <span key={tag} className="tag">{tag}</span>)}
            </div>
          </div>
        ))}
      </section>

      <section className="group">
        <div className="group-label mono">
          今日学习<span className="group-count">{planPending.length} 待打卡</span>
        </div>
        {ov.today_plan_items.length === 0 && <div className="sub row-pad">今天没有学习安排</div>}
        {ov.today_plan_items.map((it) => (
          <div key={it.id} className={`todo-card study-card ${it.status}`}>
            <div className="todo-card-main">
              <button
                className={`check ${it.status === 'done' ? 'checked' : ''}`}
                onClick={() => it.status !== 'done' && void doneItem(it.id)}
                title={it.status === 'done' ? '已完成' : '打卡'}
              >
                {it.status === 'done' && (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                    <path d="M4 12l5 5L20 6" />
                  </svg>
                )}
              </button>
              <IconItemType type={it.item_type} className="type-icon" />
              <span className="todo-title">{it.content}</span>
            </div>
            <div className="todo-card-meta">
              <span className="todo-meta mono">{it.plan_title} · {TYPE_LABEL[it.item_type]}</span>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
