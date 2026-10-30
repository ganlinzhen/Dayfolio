import ActionButton from './ActionButton';
import { IconRefresh } from './icons';
// 今日页：日历置顶（周/月视图）+ 逾期待办行动列表
// 2026-10-14 起头部日期条、统计条与手动「每日打卡」入口移除，打开即是日历
import { useCallback, useState } from 'react';
import { api, call } from '../api';
import CalendarSection from './CalendarSection';
import { useRuntimeRefresh } from './useRuntimeRefresh';
import EmptyState from './EmptyState';
import type { Todo } from './TodoPanel';

interface Overview {
  date: string;
  overdue_todos: Todo[];
}

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

  useRuntimeRefresh(refresh);

  const completeTodo = async (id: number) => {
    await call(() => api.todos.complete({ id }));
    await refresh();
  };

  if (!ov)
    return (
      <div className="panel work-panel" role="region" aria-label="今日">
        {error ? (
          <EmptyState
            title="今日概览加载失败"
            hint={error}
            action={<ActionButton icon={IconRefresh} className="btn" onClick={() => void refresh()}>重试</ActionButton>}
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

  return (
    <div className="panel work-panel today-panel" role="region" aria-label="今日">
      {/* 日历置顶：周视图默认，工具栏含今天/翻页/周月切换/新建日程 */}
      <CalendarSection today={ov.date} />

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
              {t.source_status==='cancelled' && <span className="tag">来源已取消</span>}
              {t.start_time && <span className="todo-meta mono">{t.start_time}{t.end_time?`–${t.end_date&&t.end_date!==t.due_date?t.end_date+' ':''}${t.end_time}`:' · 结束待定'}</span>}
                  {t.due_date && (
                    <span className="todo-meta mono danger">
                      {t.due_date}{t.start_time ? ` ${t.start_time}${t.end_time?'–'+(t.end_date&&t.end_date!==t.due_date?t.end_date+' ':'')+t.end_time:' · 结束待定'}` : ''}{overdueDays > 0 ? ` · 逾期 ${overdueDays} 天` : ''}
                    </span>
                  )}
                  {t.tags.filter((tag) => !/^plan:\d+$/.test(tag)).map((tag) => <span key={tag} className="tag">{tag}</span>)}
                </div>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}
