// 今日页日历区块：周视图（默认）与月视图 + 当日明细 + 日程增删改（Codex 风格）
// 数据一次拉全（rangeAgenda）：日程 + 每日到期待办/学习条目/打卡状态叠加显示
// 布局参考飞书日历：周视图=列头(今天圆标)+全天区+时间网格(当前时刻红线+点空档建日程)
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, call } from '../api';
import {
  IconChevronLeft,
  IconChevronRight,
  IconClock,
  IconPencil,
  IconPlus,
  IconTrash,
} from './icons';

export interface CalEvent {
  id: number;
  title: string;
  date: string;
  end_date: string | null;
  start_time: string | null;
  end_time: string | null;
  note: string;
  color: string;
  source: string;
}

interface AgendaDay {
  todos: Array<{ id: number; title: string; priority: 'high' | 'medium' | 'low'; status: 'open' | 'done'; start_time: string | null; end_time: string | null }>;
  plan_items: Array<{ id: number; content: string; item_type: 'learn' | 'review' | 'practice' | 'rest'; status: 'pending' | 'done' | 'skipped'; plan_title: string }>;
  checked_in: boolean;
}

interface Agenda {
  from: string;
  to: string;
  events: CalEvent[];
  days: Record<string, AgendaDay | undefined>;
}

type ViewMode = 'week' | 'month';
const COLORS = ['blue', 'green', 'violet', 'amber', 'rose', 'slate'] as const;
const COLOR_LABEL: Record<string, string> = { blue: '蓝', green: '绿', violet: '紫', amber: '黄', rose: '红', slate: '灰' };
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const TYPE_LABEL: Record<string, string> = { learn: '学习', review: '复习', practice: '练习', rest: '休息' };
const PRIORITY_LABEL: Record<string, string> = { high: '高', medium: '中', low: '低' };
/** 月格子里每天最多直列的事件条数，超出折叠为 +N */
const CELL_MAX_EVENTS = 2;
/** 周视图时间网格：每小时像素高度与容器可视高度 */
const HOUR_H = 44;
const GRID_VIEW_H = 480;
const VIEW_STORE = 'dayfolio.calView';

const pad = (n: number) => String(n).padStart(2, '0');
const keyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayKey = () => keyOf(new Date());
const dowOf = (day: string) => new Date(`${day}T00:00:00`).getDay();
const addDaysKey = (day: string, n: number) => {
  const [y, m, d] = day.split('-').map(Number);
  return keyOf(new Date(y, m - 1, d + n));
};
/** 周日开头的一周（与月视图列序一致） */
const weekStartOf = (day: string) => addDaysKey(day, -dowOf(day));
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const minToTime = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

/** 事件是否落在某天（跨天区间含两端） */
const eventOnDay = (ev: CalEvent, day: string) => ev.date <= day && (ev.end_date ?? ev.date) >= day;
const isMultiDay = (ev: CalEvent) => !!ev.end_date && ev.end_date > ev.date;

interface FormState {
  id: number | null;
  title: string;
  date: string;
  endDate: string;
  allDay: boolean;
  startTime: string;
  endTime: string;
  color: string;
  note: string;
}

const emptyForm = (date: string, startTime = '', endTime = ''): FormState => ({
  id: null, title: '', date, endDate: '', allDay: !startTime, startTime, endTime, color: 'blue', note: '',
});

/** 周视图一天内的定时事件布局：重叠事件并排分列（贪心列分配 + 连通簇内计列数） */
function layoutTimedEvents(evs: CalEvent[]): Array<{ ev: CalEvent; col: number; cols: number }> {
  const sorted = [...evs].sort(
    (a, b) => toMin(a.start_time ?? '00:00') - toMin(b.start_time ?? '00:00') || a.id - b.id,
  );
  const out: Array<{ ev: CalEvent; col: number; cols: number }> = [];
  let cluster: Array<{ ev: CalEvent; col: number }> = [];
  let colEnds: number[] = [];
  let clusterEnd = -1;
  const flush = () => {
    if (!cluster.length) return;
    for (const item of cluster) out.push({ ...item, cols: Math.max(colEnds.length, 1) });
    cluster = [];
    colEnds = [];
    clusterEnd = -1;
  };
  for (const ev of sorted) {
    const s = toMin(ev.start_time ?? '00:00');
    const e = ev.end_time ? toMin(ev.end_time) : Math.min(s + 60, 24 * 60);
    if (cluster.length && s >= clusterEnd) flush();
    let col = colEnds.findIndex((end) => end <= s);
    if (col === -1) {
      col = colEnds.length;
      colEnds.push(e);
    } else {
      colEnds[col] = e;
    }
    cluster.push({ ev, col });
    clusterEnd = Math.max(clusterEnd, e);
  }
  flush();
  return out;
}

/** 全天/跨天事件排进 7 列：按天区间贪心分配行，返回行列表 */
function layoutAllDayWeek(evs: CalEvent[], weekDays: string[]): Array<Array<{ ev: CalEvent; startIdx: number; span: number }>> {
  const rows: Array<Array<{ ev: CalEvent; startIdx: number; span: number }>> = [];
  const sorted = [...evs].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  for (const ev of sorted) {
    const start = ev.date < weekDays[0] ? 0 : weekDays.indexOf(ev.date);
    const lastDay = ev.end_date ?? ev.date;
    const end = lastDay > weekDays[6] ? 6 : weekDays.indexOf(lastDay);
    if (start < 0 || end < 0 || start > end) continue; // 防御：不在本周
    const span = end - start + 1;
    let row = rows.findIndex((items) => items.every((it) => it.startIdx + it.span <= start || it.startIdx >= start + span));
    if (row === -1) {
      rows.push([]);
      row = rows.length - 1;
    }
    rows[row].push({ ev, startIdx: start, span });
  }
  return rows;
}

export default function CalendarSection({ today }: { today: string }) {
  const [mode, setMode] = useState<ViewMode>(() =>
    localStorage.getItem(VIEW_STORE) === 'month' ? 'month' : 'week',
  );
  const [anchor, setAnchor] = useState(today);
  const [selected, setSelected] = useState(today);
  const [agenda, setAgenda] = useState<Agenda | null>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  /** 当前视图覆盖的日期区间：月=整月网格（含邻月补格），周=周日..周六 */
  const grid = useMemo(() => {
    if (mode === 'week') {
      const start = weekStartOf(anchor);
      return { keys: Array.from({ length: 7 }, (_, i) => addDaysKey(start, i)) };
    }
    const [y, m] = anchor.split('-').map(Number);
    const offset = new Date(y, m - 1, 1).getDay();
    const daysInMonth = new Date(y, m, 0).getDate();
    const cells = Math.ceil((offset + daysInMonth) / 7) * 7;
    const start = new Date(y, m - 1, 1 - offset);
    return { keys: Array.from({ length: cells }, (_, i) => keyOf(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))) };
  }, [mode, anchor]);

  const refresh = useCallback(async () => {
    try {
      setAgenda(await call<Agenda>(() => api.calendar.rangeAgenda({ from: grid.keys[0], to: grid.keys[grid.keys.length - 1] })));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [grid.keys]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 切换视图/区间后选中日不在网格内时，回到锚点当月 1 号
  useEffect(() => {
    if (selected < grid.keys[0] || selected > grid.keys[grid.keys.length - 1]) {
      const [y, m] = anchor.split('-').map(Number);
      setSelected(mode === 'week' ? weekStartOf(anchor) : `${y}-${pad(m)}-01`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid.keys]);

  // 周视图回到可视区：本周含今天时，把当前时刻定位到网格可视高度的中间
  useEffect(() => {
    if (mode !== 'week' || !scrollRef.current) return;
    if (!grid.keys.includes(today)) return;
    const nowMin = now.getHours() * 60 + now.getMinutes();
    scrollRef.current.scrollTop = Math.max(0, (nowMin / 60) * HOUR_H - GRID_VIEW_H / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, grid.keys]);

  const shiftView = (dir: 1 | -1) =>
    setAnchor(mode === 'week' ? addDaysKey(anchor, dir * 7) : (() => {
      const [y, m] = anchor.split('-').map(Number);
      const d = new Date(y, m - 1 + dir, 1);
      return keyOf(d);
    })());
  const goToday = () => {
    const t = todayKey();
    setAnchor(t);
    setSelected(t);
  };
  const selectDay = (day: string) => {
    setSelected(day);
    setAnchor(day);
  };
  const switchMode = (m: ViewMode) => {
    setMode(m);
    localStorage.setItem(VIEW_STORE, m);
  };

  const openCreate = (date = selected, startTime = '', endTime = '') => {
    setFormError('');
    setForm(emptyForm(date, startTime, endTime));
  };
  const openEdit = (ev: CalEvent) => {
    setFormError('');
    setForm({
      id: ev.id,
      title: ev.title,
      date: ev.date,
      endDate: ev.end_date ?? '',
      allDay: ev.start_time === null,
      startTime: ev.start_time ?? '',
      endTime: ev.end_time ?? '',
      color: ev.color,
      note: ev.note,
    });
  };

  const saveForm = async () => {
    if (!form) return;
    if (!form.title.trim()) {
      setFormError('请填写日程标题');
      return;
    }
    if (!form.date) {
      setFormError('请选择日期');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        title: form.title.trim(),
        date: form.date,
        end_date: form.endDate || null,
        start_time: form.allDay ? null : form.startTime || null,
        end_time: form.allDay || !form.endTime ? null : form.endTime,
        color: form.color,
        note: form.note,
      };
      const editId = form.id; // 提前取出：闭包内不做 null 收窄
      if (editId === null) await call(() => api.calendar.add(payload));
      else await call(() => api.calendar.update({ id: editId, ...payload }));
      setForm(null);
      setFormError('');
      if (selected !== form.date) setSelected(form.date);
      await refresh();
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const removeEvent = async (ev: CalEvent) => {
    try {
      await call(() => api.calendar.delete({ id: ev.id }));
      if (form?.id === ev.id) setForm(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  /** 编辑表单里的删除按钮：按 form.id 找回当前事件 */
  const removeFormEvent = () => {
    if (form?.id == null) return;
    const ev = agenda?.events.find((e) => e.id === form.id);
    if (ev) void removeEvent(ev);
  };

  /** 周视图点击空白时段：按点击位置换算 30 分钟粒度时段，预填新建表单 */
  const createAtSlot = (day: string, e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const minutes = Math.max(0, Math.min(24 * 60 - 1, ((e.clientY - rect.top) / HOUR_H) * 60));
    const snapped = Math.floor(minutes / 30) * 30;
    const end = Math.min(snapped + 60, 24 * 60 - 1);
    if (selected !== day) setSelected(day);
    openCreate(day, minToTime(snapped), minToTime(end));
  };

  const eventsOfSelected = (agenda?.events ?? []).filter((ev) => eventOnDay(ev, selected));
  const dayInfo = agenda?.days[selected];
  const selectedDow = WEEK[dowOf(selected)];
  const anchorMonthLabel = (() => {
    if (mode === 'month') {
      const [y, m] = anchor.split('-').map(Number);
      return `${y}年${m}月`;
    }
    const first = grid.keys[0];
    const last = grid.keys[6];
    const [fy, fm, fd] = first.split('-').map(Number);
    const [, lm, ld] = last.split('-').map(Number);
    return fm === lm ? `${fy}年${fm}月${fd}日 - ${ld}日` : `${fy}年${fm}月${fd}日 - ${lm}月${ld}日`;
  })();
  const todayDowCol = dowOf(today);

  // 周视图派生数据
  const weekDays = grid.keys;
  const allDayRows = useMemo(
    () => (mode === 'week' && agenda ? layoutAllDayWeek(agenda.events.filter((ev) => ev.start_time === null || isMultiDay(ev)), weekDays) : []),
    [mode, agenda, weekDays],
  );
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const nowLineTop = (nowMinutes / 60) * HOUR_H;

  return (
    <section className="group cal-section" aria-label="日历">
      <div className="cal-toolbar">
        <button className="btn slim" onClick={goToday}>今天</button>
        <button className="icon-btn" aria-label={mode === 'week' ? '上一周' : '上一月'} onClick={() => shiftView(-1)}><IconChevronLeft width={15} height={15} /></button>
        <button className="icon-btn" aria-label={mode === 'week' ? '下一周' : '下一月'} onClick={() => shiftView(1)}><IconChevronRight width={15} height={15} /></button>
        <span className="cal-title serif">{anchorMonthLabel}</span>
        <span className="spacer" />
        <div className="cal-mode-switch" role="tablist" aria-label="视图切换">
          <button role="tab" aria-selected={mode === 'week'} className={mode === 'week' ? 'on' : ''} onClick={() => switchMode('week')}>周</button>
          <button role="tab" aria-selected={mode === 'month'} className={mode === 'month' ? 'on' : ''} onClick={() => switchMode('month')}>月</button>
        </div>
        <button className="btn primary slim" onClick={() => openCreate()}><IconPlus width={13} height={13} />新建日程</button>
      </div>

      {error && <div className="notice error">{error}</div>}

      {mode === 'week' ? (
        <div className="cal-weekview">
          {/* 列头：周几 + 日期（今天圆形标记），点击选中该天 */}
          <div className="cal-week-head">
            <span className="cal-axis-head mono">时间</span>
            {weekDays.map((day) => {
              const info = agenda?.days[day];
              const metaBits = [
                info?.todos.length ? `待办${info.todos.length}` : null,
                info?.plan_items.length ? `学${info.plan_items.length}` : null,
              ].filter(Boolean) as string[];
              return (
                <button key={day} className={`cal-wd-col ${day === today ? 'today-col' : ''} ${day === selected ? 'sel-col' : ''}`} onClick={() => selectDay(day)} aria-label={day}>
                  <span className="cal-wd-text">周{WEEK[dowOf(day)]}</span>
                  <span className={`cal-num ${day === today ? 'today-num' : ''}`}>{Number(day.slice(8))}</span>
                  {metaBits.length > 0 && <span className="cal-day-meta mono">{metaBits.join('·')}</span>}
                </button>
              );
            })}
          </div>
          {/* 全天/跨天事件区（跨列色条） */}
          <div className="cal-allday">
            <span className="cal-axis-head mono">全天</span>
            <div className="cal-allday-lane" style={{ height: Math.max(allDayRows.length, 1) * 26 }}>
              {allDayRows.length === 0 && <span className="cal-allday-empty" />}
              {allDayRows.map((row, ri) =>
                row.map(({ ev, startIdx, span }) => (
                  <button
                    key={`${ri}-${ev.id}`}
                    className={`cal-allday-chip ${ev.color}`}
                    style={{ left: `calc(${(startIdx / 7) * 100}% + 2px)`, width: `calc(${(span / 7) * 100}% - 4px)`, top: ri * 26 + 2, height: 22 }}
                    onClick={() => openEdit(ev)}
                    title={`${ev.title}${ev.start_time ? ` ${ev.start_time}` : ''}`}
                  >
                    <i className={`cal-dot ${ev.color}`} />
                    <span className="cal-ev-text">{ev.start_time && !isMultiDay(ev) ? `${ev.start_time} ` : ''}{ev.title}</span>
                  </button>
                )),
              )}
            </div>
          </div>
          {/* 时间网格：刻度轴与 7 天列同在一个滚动容器里，滚动时刻度同步移动 */}
          <div className="cal-weekgrid">
            <div className="cal-scroll" ref={scrollRef}>
              <div className="cal-scroll-inner" style={{ height: 24 * HOUR_H }}>
                <div className="cal-axis">
                  {Array.from({ length: 24 }, (_, h) => (
                    <div key={h} className="cal-axis-tick" style={{ top: h * HOUR_H }}>
                      {h % 2 === 0 && <span className="mono">{pad(h)}:00</span>}
                    </div>
                  ))}
                </div>
                <div className="cal-daycols">
                  {weekDays.map((day) => {
                    const timed = (agenda?.events ?? []).filter((ev) => ev.date === day && ev.start_time !== null && !isMultiDay(ev));
                    const placed = layoutTimedEvents(timed);
                    return (
                      <div
                        key={day}
                        className={`cal-col ${day === today ? 'today-col-bg' : ''}`}
                        onClick={(e) => createAtSlot(day, e)}
                        role="gridcell"
                        aria-label={`${day}时间网格`}
                      >
                        {placed.map(({ ev, col, cols }) => {
                          const start = toMin(ev.start_time!);
                          const end = ev.end_time ? toMin(ev.end_time) : Math.min(start + 60, 24 * 60);
                          const top = (start / 60) * HOUR_H;
                          const height = Math.max(((end - start) / 60) * HOUR_H, 20);
                          return (
                            <button
                              key={ev.id}
                              className={`cal-evt-block ${ev.color}`}
                              style={{ top, height, left: `calc(${(col / cols) * 100}% + 1px)`, width: `calc(${(1 / cols) * 100}% - 2px)` }}
                              onClick={(e) => { e.stopPropagation(); openEdit(ev); }}
                              title={`${ev.start_time}${ev.end_time ? `–${ev.end_time}` : ''} ${ev.title}`}
                            >
                              <span className="cal-evt-block-time mono">{ev.start_time}{ev.end_time ? `–${ev.end_time}` : ''}</span>
                              <span className="cal-evt-block-title">{ev.title}</span>
                            </button>
                          );
                        })}
                      </div>
                    );
                  })}
                  {grid.keys.includes(today) && (
                    <div className="cal-nowline" style={{ top: nowLineTop }} aria-hidden>
                      <span className="cal-nowtime mono">{minToTime(nowMinutes)}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="cal-week" aria-hidden>
            {WEEK.map((w, i) => (
              <span key={w} className={`cal-wd mono ${i === todayDowCol ? 'today-col' : ''}`}>周{w}</span>
            ))}
          </div>
          <div className="cal-grid" role="grid" aria-label={`${anchorMonthLabel}月视图`}>
            {grid.keys.map((day) => {
              const dayNum = Number(day.slice(8));
              const [ay, am] = anchor.split('-').map(Number);
              const inMonth = Number(day.slice(5, 7)) === am;
              const evs = (agenda?.events ?? []).filter((ev) => eventOnDay(ev, day));
              const shown = evs.slice(0, CELL_MAX_EVENTS);
              const more = evs.length - shown.length;
              const info = agenda?.days[day];
              const metaParts = [
                info?.todos.length ? `待办${info.todos.length}` : null,
                info?.plan_items.length ? `学习${info.plan_items.length}` : null,
              ].filter(Boolean);
              return (
                <button
                  key={day}
                  role="gridcell"
                  className={[
                    'cal-cell',
                    inMonth ? '' : 'out',
                    day === today ? 'today' : '',
                    day === selected ? 'sel' : '',
                  ].filter(Boolean).join(' ')}
                  aria-label={`${day}`}
                  aria-pressed={day === selected}
                  onClick={() => selectDay(day)}
                >
                  <span className="cal-num">{dayNum}</span>
                  {shown.map((ev) => (
                    <span key={ev.id} className="cal-ev">
                      <i className={`cal-dot ${ev.color}`} />
                      <span className="cal-ev-text">
                        {ev.start_time && ev.date === day ? `${ev.start_time} ` : ''}
                        {ev.title}
                      </span>
                    </span>
                  ))}
                  {more > 0 && <span className="cal-more mono">+{more}</span>}
                  {metaParts.length > 0 && <span className="cal-day-meta mono">{metaParts.join(' · ')}</span>}
                </button>
              );
            })}
          </div>
        </>
      )}

      {/* 当日明细 */}
      <div className="cal-day">
        <div className="cal-day-head">
          <span className="cal-day-title serif">{Number(selected.slice(5, 7))}月{Number(selected.slice(8))}日</span>
          <span className="mono">周{selectedDow} · {selected}</span>
          {dayInfo?.checked_in && <span className="cal-badge">已打卡</span>}
          {selected === today && <span className="cal-badge today-badge">今天</span>}
        </div>

        {form && (
          <div className="cal-form" aria-label={form.id === null ? '新建日程' : '编辑日程'}>
            <div className="cal-form-row">
              <input
                className="inline-input cal-title-input"
                placeholder="日程标题"
                aria-label="日程标题"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && void saveForm()}
                autoFocus
              />
            </div>
            <div className="cal-form-row">
              <label className="cal-field">日期<input className="chip-date" type="date" aria-label="开始日期" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></label>
              <label className="cal-field">结束<input className="chip-date" type="date" aria-label="结束日期" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} /></label>
              <label className="cal-check"><input type="checkbox" checked={form.allDay} onChange={(e) => setForm({ ...form, allDay: e.target.checked })} />全天</label>
              <label className="cal-field">开始<input className="cal-time" type="time" aria-label="开始时间" disabled={form.allDay} value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} /></label>
              <label className="cal-field">结束<input className="cal-time" type="time" aria-label="结束时间" disabled={form.allDay} value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} /></label>
            </div>
            <div className="cal-form-row">
              <span className="cal-colors" role="radiogroup" aria-label="颜色">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={form.color === c}
                    aria-label={COLOR_LABEL[c]}
                    title={COLOR_LABEL[c]}
                    className={`cal-color-btn ${form.color === c ? 'on' : ''}`}
                    onClick={() => setForm({ ...form, color: c })}
                  >
                    <i className={`cal-dot ${c}`} />
                  </button>
                ))}
              </span>
              <input
                className="inline-input cal-note-input"
                placeholder="备注（可选）"
                aria-label="日程备注"
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
              />
            </div>
            {formError && <div className="notice error">{formError}</div>}
            <div className="cal-form-row">
              <button className="btn primary slim" disabled={saving} onClick={() => void saveForm()}>
                {saving ? '保存中…' : form.id === null ? '创建日程' : '保存修改'}
              </button>
              <button className="btn slim" onClick={() => { setForm(null); setFormError(''); }}>取消</button>
              {form.id !== null && (
                <button className="btn slim danger-btn" onClick={removeFormEvent}>
                  <IconTrash width={13} height={13} />删除
                </button>
              )}
            </div>
          </div>
        )}

        {eventsOfSelected.length === 0 && !form && (
          <div className="sub cal-empty">这一天没有日程{mode === 'week' ? '，点时间网格的空档即可按时段新建' : selected >= today ? '，点右上「新建日程」安排一件事' : ''}。</div>
        )}
        {eventsOfSelected.map((ev) => {
          const isStart = ev.date === selected;
          const timeLabel = !isStart
            ? '继续'
            : ev.start_time
              ? `${ev.start_time}${ev.end_time ? `–${ev.end_time}` : ''}`
              : '全天';
          return (
            <div key={ev.id} className={`cal-ev-row ${isStart ? '' : 'cont'}`}>
              <i className={`cal-dot ${ev.color}`} />
              <span className="cal-ev-time mono">{timeLabel}</span>
              <span className="cal-ev-title">{ev.title}</span>
              {ev.end_date && ev.end_date > ev.date && isStart && (
                <span className="cal-ev-until mono">至{Number(ev.end_date.slice(8))}日</span>
              )}
              {ev.source === 'mcp' && <span className="cal-badge">AI</span>}
              {ev.note && <span className="cal-ev-note">{ev.note}</span>}
              <span className="spacer" />
              <button className="icon-btn subtle" aria-label={`编辑日程「${ev.title.slice(0, 20)}」`} title="编辑" onClick={() => openEdit(ev)}>
                <IconPencil width={13} height={13} />
              </button>
              <button className="icon-btn subtle" aria-label={`删除日程「${ev.title.slice(0, 20)}」`} title="删除" onClick={() => void removeEvent(ev)}>
                <IconTrash width={13} height={13} />
              </button>
            </div>
          );
        })}

        {dayInfo && dayInfo.todos.length > 0 && (
          <div className="cal-sub-group">
            <div className="cal-sub-label mono">当日到期待办<span className="group-count">{dayInfo.todos.length}</span></div>
            {dayInfo.todos.map((t) => (
              <div key={t.id} className="cal-row">
                <span className={`prio ${t.priority}`}>{PRIORITY_LABEL[t.priority]}</span>
                <span className={`cal-row-title ${t.status === 'done' ? 'done' : ''}`}>{t.title}</span>
                <span className="todo-meta mono">{t.start_time ? `${t.start_time}–${t.end_time}` : '仅日期'}</span>
                {t.status === 'done' && <span className="cal-badge">已完成</span>}
              </div>
            ))}
          </div>
        )}
        {dayInfo && dayInfo.plan_items.length > 0 && (
          <div className="cal-sub-group">
            <div className="cal-sub-label mono">当日学习<span className="group-count">{dayInfo.plan_items.length}</span></div>
            {dayInfo.plan_items.map((it) => (
              <div key={it.id} className="cal-row">
                <span className="cal-type">{TYPE_LABEL[it.item_type]}</span>
                <span className={`cal-row-title ${it.status === 'done' ? 'done' : ''}`}>{it.content}</span>
                <span className="mono cal-plan">{it.plan_title}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="cal-legend mono">
        <span><IconClock width={12} height={12} />{mode === 'week' ? '点时间网格空档按时段新建；重叠日程自动并排。' : '格子里「待办 n · 学习 n」来自到期待办与学习计划；'}日历展示的是同一份日程数据。</span>
      </div>
    </section>
  );
}
