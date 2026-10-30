import ActionButton from './ActionButton';
import { IconRefresh } from './icons';
// 今日、本周、本月明细独立查询完整区间，保留统一分类、完成状态与业务详情入口。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { addDay, agendaDays, dayOfWeek, sliceItems, type AgendaMode, type CalendarItem, type CalendarResult } from './calendar-view';
import { loadCalendarPages } from './calendar-pages';
import { useRuntimeRefresh } from './useRuntimeRefresh';

const MODES = [{ mode: 'day', label: '今日' }, { mode: 'week', label: '本周' }, { mode: 'month', label: '本月' }] as const;
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const KIND = { todo: '待办', plan_item: '学习', calendar_event: '日程', external_subscription: '订阅' };
const COLORS = ['blue', 'green', 'violet', 'amber', 'rose', 'slate'];
const dayTitle = (day: string) => `${Number(day.slice(5, 7))}月${Number(day.slice(8))}日`;

interface Props {
  today: string;
  selected: string;
  mode: AgendaMode;
  zone: string;
  revision?: number;
  onModeChange: (mode: AgendaMode) => void;
  onOpen: (item: CalendarItem, element: HTMLElement, time: string) => void;
}

export default function CalendarAgenda({ today, selected, mode, zone, revision, onModeChange, onOpen }: Props) {
  const days = useMemo(() => agendaDays(mode, today, selected), [mode, today, selected]);
  const queryKey = `${days[0]}/${days[days.length - 1]}/${zone}/${revision}`;
  const [snapshot, setSnapshot] = useState<{ key: string; result: CalendarResult } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const sequence = useRef(0);
  const tabs = useRef<HTMLDivElement>(null);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    if (!zone) return;
    setLoading(true); setError(''); setSnapshot(null);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await loadCalendarPages(input => api.calendar.queryItems(input), { fromDate: days[0], toDateExclusive: addDay(days[days.length - 1], 1), displayTimezone: zone });
        if (request !== sequence.current) return;
        setSnapshot({ key: queryKey, result }); setLoading(false); return;
      } catch (e) {
        if (request !== sequence.current) return;
        if ((e as { code?: string }).code === 'REVISION_CONFLICT' && attempt < 2) continue;
        setError((e as Error).message); setLoading(false); return;
      }
    }
  }, [days, zone, queryKey]);
  useEffect(() => { void refresh(); return () => { sequence.current++; }; }, [refresh]);
  useRuntimeRefresh(refresh);
  const result = snapshot?.key === queryKey ? snapshot.result : null;
  const busy = loading || (!result && !error);
  const slices = useMemo(() => sliceItems(result?.items ?? [], days, zone || 'UTC'), [result, days, zone]);
  const groups = days.map(day => ({ day, slices: slices.filter(slice => slice.day === day) })).filter(group => group.slices.length);
  const colorOf = (item: CalendarItem) => {
    const color = result?.itemColors?.[item.id] ?? result?.collections.find(c => c.id === item.collectionId)?.color ?? 'blue';
    return COLORS.includes(color) ? color : 'blue';
  };
  const title = mode === 'day' ? dayTitle(selected) : mode === 'week' ? '本周' : '本月';
  return <div className="cal-day" aria-busy={busy}>
    <div className="cal-day-head">
      <div className="cal-agenda-summary">
        <span className="cal-day-title serif">{title}</span>
        <span className="mono">{mode === 'day' ? `周${WEEK[dayOfWeek(selected)]} · ${selected}` : `${days[0]} 至 ${days[days.length - 1]}`} · {result ? `${result.items.length} 项` : '…'}</span>
        {mode === 'day' && selected === today && <span className="cal-badge today-badge">今天</span>}
      </div>
      <div className="cal-mode-switch cal-agenda-tabs" ref={tabs} role="tablist" aria-label="事项时间范围">
        {MODES.map(({ mode: value, label }, index) => <button key={value} id={`cal-agenda-tab-${value}`} role="tab" aria-selected={mode === value} aria-controls="cal-agenda-content" tabIndex={mode === value ? 0 : -1} className={mode === value ? 'on' : ''} onClick={() => onModeChange(value)} onKeyDown={event => {
          const next = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : null;
          if (next === null) return;
          event.preventDefault(); onModeChange(MODES[next].mode); tabs.current?.querySelectorAll('button')[next]?.focus();
        }}>{label}</button>)}
      </div>
    </div>
    <div id="cal-agenda-content" role="tabpanel" aria-labelledby={`cal-agenda-tab-${mode}`} tabIndex={0}>
      {busy && <p className="sub cal-empty" role="status">正在读取事项…</p>}
      {error && <div className="notice error" role="alert">{error}<ActionButton icon={IconRefresh} className="btn slim" onClick={() => void refresh()}>重试</ActionButton></div>}
      {!busy && !error && !slices.length && <p className="sub cal-empty">{mode === 'day' ? '这一天' : title}没有已显示的安排。可在更多菜单的「管理分类」中调整显示，或新建日程。</p>}
      {groups.map(group => <div className="cal-agenda-group" key={group.day}>
        {mode !== 'day' && <h4 className="cal-agenda-date">{dayTitle(group.day)} <span className="mono">周{WEEK[dayOfWeek(group.day)]} · {group.day}</span>{group.day === today && <span className="cal-badge today-badge">今天</span>}</h4>}
        <div className="cal-agenda-cards">{group.slices.map(s => <div key={s.item.id} className="cal-ev-row cal-agenda-card" data-calendar-kind={s.item.kind} data-item-id={s.item.id} data-status={s.item.status}>
          <div className="cal-agenda-card-main"><i className={`cal-dot ${colorOf(s.item)}`}/><button className="cal-item-open cal-ev-title" onClick={event => onOpen(s.item, event.currentTarget, `${s.day} ${s.label} (${zone})`)}>{s.item.title}</button></div>
          <div className="cal-agenda-card-meta">
            <span className="cal-ev-time mono">{s.label}</span><span className="cal-badge">{KIND[s.item.kind]}</span>
            {s.item.status !== 'scheduled' && <span className="cal-badge">{s.item.status === 'done' ? '已完成' : s.item.status === 'skipped' ? '已跳过' : '未完成'}</span>}
            {s.item.sourceStatus === 'cancelled' && <span className="cal-badge">来源已取消</span>}
            <span>{result?.collections.find(c => c.id === s.item.collectionId)?.title}</span>
          </div>
        </div>)}</div>
      </div>)}
    </div>
  </div>;
}
