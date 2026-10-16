// 日历服务：个人本地日程 CRUD + 区间聚合（今日页月视图一次拉全）
// 不做重复日程与参与人；跨天用 end_date（含当天），start_time 为空即全天。
import type { DbAdapter } from '../db';
import { mapCalendarEvent } from '../db';
import { CALENDAR_COLORS, type CalendarEvent, type CalendarEventPatch, type CalendarRangeAgenda, type NewCalendarEventInput } from '../types';
import { addDays, ensureValidDateStr, nowIso } from '../utils/date';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** 区间聚合一次允许的最大天数：防无界查询 */
export const CALENDAR_RANGE_MAX_DAYS = 100;

/** 事件在区间查询里的排序：开始日 → 全天优先 → 开始时间 → id */
const EVENT_ORDER = 'date ASC, (start_time IS NULL) DESC, start_time ASC, id ASC';

function ensureValidTime(value: string, field: string): string {
  if (!TIME_RE.test(value)) throw new Error(`时间格式错误："${value}"（${field} 应为 HH:MM，00:00–23:59）`);
  return value;
}

/** 完整校验一条日程（add 与 update 合并后共用）；返回整理后的字段 */
function validateEvent(input: {
  title: string;
  date: string;
  end_date: string | null;
  start_time: string | null;
  end_time: string | null;
  color: string;
}) {
  const title = input.title.trim();
  if (!title) throw new Error('日程标题不能为空');
  if (title.length > 200) throw new Error('日程标题过长（≤200 字）');
  const date = ensureValidDateStr(input.date);
  const endDate = input.end_date ? ensureValidDateStr(input.end_date) : null;
  if (endDate && endDate < date) throw new Error(`结束日期 ${endDate} 早于开始日期 ${date}`);
  const startTime = input.start_time ? ensureValidTime(input.start_time, '开始时间') : null;
  const endTime = input.end_time ? ensureValidTime(input.end_time, '结束时间') : null;
  if (startTime === null && endTime !== null) throw new Error('全天日程不能只填结束时间（请先填开始时间或清空结束时间）');
  if (startTime !== null && endTime !== null && endTime <= startTime && date === (endDate ?? date)) {
    throw new Error(`结束时间 ${endTime} 不晚于开始时间 ${startTime}`);
  }
  if (!CALENDAR_COLORS.includes(input.color as (typeof CALENDAR_COLORS)[number])) {
    throw new Error(`未知日程颜色 "${input.color}"，可用：${CALENDAR_COLORS.join('/')}`);
  }
  return { title, date, endDate, startTime, endTime, color: input.color as (typeof CALENDAR_COLORS)[number] };
}

export function createCalendarService(db: DbAdapter, queries?: import('../ontology/query').QueryService) {
  const get = (id: number): CalendarEvent | null => {
    const row = queries ? queries.get({ version: 1, objectType: 'calendar_event', id }) : db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
    return row ? mapCalendarEvent(row) : null;
  };

  const getExisting = (id: number): CalendarEvent => {
    const ev = get(id);
    if (!ev) throw new Error(`日程 #${id} 不存在`);
    return ev;
  };

  const add = (input: NewCalendarEventInput): CalendarEvent => {
    const v = validateEvent({
      title: String(input.title ?? ''),
      date: String(input.date ?? ''),
      end_date: input.end_date ?? null,
      start_time: input.start_time ?? null,
      end_time: input.end_time ?? null,
      color: input.color ?? 'blue',
    });
    const now = nowIso();
    const res = db.prepare(
      `INSERT INTO calendar_events (title, date, end_date, start_time, end_time, note, color, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(v.title, v.date, v.endDate, v.startTime, v.endTime, input.note ?? '', v.color, input.source === 'mcp' ? 'mcp' : 'app', now, now);
    return getExisting(Number(res.lastInsertRowid));
  };

  const update = (id: number, patch: CalendarEventPatch): CalendarEvent => {
    const cur = getExisting(id);
    const v = validateEvent({
      title: patch.title !== undefined ? String(patch.title) : cur.title,
      date: patch.date !== undefined ? String(patch.date) : cur.date,
      end_date: patch.end_date !== undefined ? patch.end_date : cur.end_date,
      start_time: patch.start_time !== undefined ? patch.start_time : cur.start_time,
      end_time: patch.end_time !== undefined ? patch.end_time : cur.end_time,
      color: patch.color !== undefined ? patch.color : cur.color,
    });
    db.prepare(
      `UPDATE calendar_events SET title=?, date=?, end_date=?, start_time=?, end_time=?, note=?, color=?, updated_at=? WHERE id=?`,
    ).run(v.title, v.date, v.endDate, v.startTime, v.endTime, patch.note !== undefined ? patch.note : cur.note, v.color, nowIso(), id);
    return getExisting(id);
  };

  const remove = (id: number): void => {
    getExisting(id);
    db.prepare('DELETE FROM calendar_events WHERE id = ?').run(id);
  };

  /** 区间查询（含跨天相交）。from/to 缺省时不设界；search 按标题/备注模糊匹配 */
  const list = (opts: { from?: string; to?: string; search?: string; limit?: number } = {}): CalendarEvent[] => {
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    if (opts.from) {
      where.push('COALESCE(end_date, date) >= ?');
      params.push(ensureValidDateStr(opts.from));
    }
    if (opts.to) {
      where.push('date <= ?');
      params.push(ensureValidDateStr(opts.to));
    }
    if (opts.search) {
      where.push('(title LIKE ? OR note LIKE ?)');
      params.push(`%${opts.search}%`, `%${opts.search}%`);
    }
    params.push(opts.limit && opts.limit > 0 ? Math.min(opts.limit, 500) : 500);
    return db
      .prepare(`SELECT * FROM calendar_events WHERE ${where.join(' AND ')} ORDER BY ${EVENT_ORDER} LIMIT ?`)
      .all(...params)
      .map(mapCalendarEvent);
  };

  /** 月视图/区间聚合：区间相交日程 + 每日到期待办、学习条目与每日打卡状态 */
  const rangeAgenda = (opts: { from: string; to: string }): CalendarRangeAgenda => {
    const from = ensureValidDateStr(opts.from);
    const to = ensureValidDateStr(opts.to);
    if (to < from) throw new Error(`区间结束 ${to} 早于开始 ${from}`);
    if (Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1 > CALENDAR_RANGE_MAX_DAYS) {
      throw new Error(`区间过长：一次最多聚合 ${CALENDAR_RANGE_MAX_DAYS} 天`);
    }
    const events = list({ from, to });
    const days: CalendarRangeAgenda['days'] = {};
    const todoRows = db
      .prepare('SELECT id, title, priority, status, due_date, end_date, start_time, end_time FROM todos WHERE COALESCE(end_date,due_date)>=? AND due_date<=? ORDER BY id')
      .all(from, to);
    const itemRows = db
      .prepare(
        `SELECT pi.id, pi.content, pi.item_type, pi.status, sp.title AS plan_title, pi.date
         FROM plan_items pi LEFT JOIN study_plans sp ON sp.id = pi.plan_id
         WHERE pi.date BETWEEN ? AND ? ORDER BY pi.date, pi.sort_order, pi.id`,
      )
      .all(from, to);
    const checkedDates = new Set(
      db.prepare("SELECT date FROM checkins WHERE ref_type = 'day' AND date BETWEEN ? AND ?").all(from, to).map((r) => String(r.date)),
    );
    const dayOf = (d: string) => (days[d] ??= { todos: [], plan_items: [], checked_in: false });
    for (const t of todoRows) {
      for(let day=String(t.due_date)<from?from:String(t.due_date);day<=String(t.end_date??t.due_date)&&day<=to;day=addDays(day,1))dayOf(day).todos.push({
        id: Number(t.id),
        title: String(t.title),
        priority: t.priority as 'high' | 'medium' | 'low',
        status: t.status as 'open' | 'done',
        start_time: (t.start_time as string | null) ?? null,
        end_time: (t.end_time as string | null) ?? null,
      });
    }
    for (const it of itemRows) {
      dayOf(String(it.date)).plan_items.push({
        id: Number(it.id),
        content: String(it.content),
        item_type: it.item_type as 'learn' | 'review' | 'practice' | 'rest',
        status: it.status as 'pending' | 'done' | 'skipped',
        plan_title: String(it.plan_title ?? ''),
      });
    }
    for (const d of checkedDates) dayOf(d).checked_in = true;
    return { from, to, events, days };
  };

  return { add, update, remove, get, list, rangeAgenda };
}

export type CalendarService = ReturnType<typeof createCalendarService>;
