// 只负责显示切片和重叠布局；视觉结束不会回写业务 endAt。
import type { CalendarItem, CalendarResult, CalendarCollection } from '../../../../../../packages/core/src/runtime-types';
export type { CalendarItem, CalendarResult, CalendarCollection };
export const addDay = (day: string, count: number) => new Date(Date.parse(day + 'T00:00:00Z') + count * 86400000).toISOString().slice(0, 10);
export const dayOfWeek = (day: string) => new Date(day + 'T00:00:00Z').getUTCDay();
export const pad = (n: number) => String(n).padStart(2, '0');
export type AgendaMode = 'day' | 'week' | 'month';
/** 指定日期所在的自然周，固定按周一至周日排列。 */
export function weekDays(day: string): string[] {
  const start = addDay(day, -((dayOfWeek(day) + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => addDay(start, i));
}
/** 明细范围独立于网格翻页；自然周从周一开始，日期运算不受夏令时影响。 */
export function agendaDays(mode: AgendaMode, today: string, selected = today): string[] {
  if (mode === 'day') return [selected];
  if (mode === 'week') return weekDays(today);
  const [year, month] = today.split('-').map(Number);
  return Array.from({ length: new Date(Date.UTC(year, month, 0)).getUTCDate() }, (_, i) => `${today.slice(0, 7)}-${pad(i + 1)}`);
}
export const clockLabel = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(Math.round(minutes % 60))}`;
export function clockAt(value: string | Date, zone: string): { day: string; minute: number; label: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value)).map(p => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute), label: `${parts.hour}:${parts.minute}` };
}
export interface CalendarSlice { item: CalendarItem; day: string; startMinute: number; visualEnd: number; allDay: boolean; continuesBefore: boolean; continuesAfter: boolean; label: string }
export function sliceItems(items: CalendarItem[], days: string[], zone: string): CalendarSlice[] {
  const result: CalendarSlice[] = [];
  for (const item of items) {
    if (item.timeKind === 'all_day') {
      for (const day of days) if (day >= item.startDate && day < item.endDateExclusive) result.push({ item, day, startMinute: 0, visualEnd: 1440, allDay: true, continuesBefore: day > item.startDate, continuesAfter: addDay(day, 1) < item.endDateExclusive, label: '全天' });
      continue;
    }
    const start = clockAt(item.startAt, zone), end = item.endAt ? clockAt(item.endAt, zone) : null;
    const last = item.endAt ? clockAt(new Date(Date.parse(item.endAt) - 1), zone).day : start.day;
    for (const day of days) {
      if (day < start.day || day > last) continue;
      const startMinute = day === start.day ? start.minute : 0;
      let visualEnd = end ? day < end.day ? 1440 : end.minute : Math.min(1440, startMinute + 60);
      // 回拨使同一天的结束钟点早于开始时，保留真实持续时长用于最小可读布局。
      if (end && visualEnd <= startMinute) visualEnd = Math.min(1440, startMinute + Math.max(1, (Date.parse(item.endAt!) - Date.parse(item.startAt)) / 60000));
      result.push({ item, day, startMinute, visualEnd, allDay: false, continuesBefore: day > start.day, continuesAfter: end !== null && day < last,
        label: `${day > start.day ? '续 ' : ''}${clockLabel(startMinute)}${end ? `–${visualEnd === 1440 ? '24:00' : end.label}` : ' · 结束待定'}` });
    }
  }
  return result.sort((a, b) => a.day.localeCompare(b.day) || Number(b.allDay) - Number(a.allDay) || a.startMinute - b.startMinute || a.item.id.localeCompare(b.item.id));
}
export function placeTimed(slices: CalendarSlice[]): Array<CalendarSlice & { col: number; cols: number }> {
  const sorted = [...slices].sort((a, b) => a.startMinute - b.startMinute || a.item.id.localeCompare(b.item.id));
  const result: Array<CalendarSlice & { col: number; cols: number }> = [];
  let cluster: Array<CalendarSlice & { col: number }> = [], ends: number[] = [], clusterEnd = -1;
  const flush = () => { for (const s of cluster) result.push({ ...s, cols: Math.max(1, ends.length) }); cluster = []; ends = []; clusterEnd = -1; };
  for (const slice of sorted) {
    if (cluster.length && slice.startMinute >= clusterEnd) flush();
    let col = ends.findIndex(end => end <= slice.startMinute);
    if (col < 0) { col = ends.length; ends.push(slice.visualEnd); } else ends[col] = slice.visualEnd;
    cluster.push({ ...slice, col }); clusterEnd = Math.max(clusterEnd, slice.visualEnd);
  }
  flush(); return result;
}
export function placeAllDay(slices: CalendarSlice[], days: string[]) {
  const groups = new Map<string, CalendarSlice[]>();
  for (const s of slices.filter(s => s.allDay)) groups.set(s.item.id, [...(groups.get(s.item.id) ?? []), s]);
  const rows: Array<Array<{ item: CalendarItem; start: number; span: number }>> = [];
  for (const group of groups.values()) {
    const start = days.indexOf(group[0].day), span = group.length;
    let row = rows.findIndex(items => items.every(x => x.start + x.span <= start || x.start >= start + span));
    if (row < 0) { row = rows.length; rows.push([]); }
    rows[row].push({ item: group[0].item, start, span });
  }
  return rows;
}
