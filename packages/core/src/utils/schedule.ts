// 固定时刻与浮动墙钟时间共用解析，App/MCP 不依赖各进程 TZ。
import type { DbAdapter } from '../db';
import type { Todo, NewTodoInput, UpdateTodoInput } from '../types';
import { ensureValidDateStr } from './date';

export class RuntimeError extends Error {
  constructor(public readonly code: string, message: string) { super(`${code}：${message}`); }
}
export const runtimeError = (code: string, message: string): never => { throw new RuntimeError(code, message); };
const formatters = new Map<string, Intl.DateTimeFormat>();
export function ensureTimezone(zone: string): string {
  if (typeof zone !== 'string' || /^[+-]/.test(zone)) return runtimeError('CONTRACT_INVALID', '显示时区须为 IANA 名称');
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(); return zone; } catch { return runtimeError('CONTRACT_INVALID', '显示时区不是有效的 IANA 时区'); }
}
export function displayTimezone(db: DbAdapter): string { return String(db.prepare('SELECT display_timezone FROM runtime_settings WHERE id=1').get()?.display_timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone); }
export function wallClock(value: Date | string, zone: string): { date: string; time: string } {
  let formatter = formatters.get(zone);
  if (!formatter) { formatter = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); formatters.set(zone, formatter); }
  const p = Object.fromEntries(formatter.formatToParts(typeof value === 'string' ? new Date(value) : value).map(p => [p.type, p.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
export const dateInZone = (value: Date | string, zone: string) => wallClock(value, zone).date;
export function timestampInZone(value: Date, zone: string): string { const wall = wallClock(value, zone); return `${wall.date}T${wall.time}:${String(value.getUTCSeconds()).padStart(2, '0')}.${String(value.getUTCMilliseconds()).padStart(3, '0')}`; }
export function instant(value: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return runtimeError('EVENT_INVALID', '时刻须包含真实日期与 Z 或时区偏移');
  ensureValidDateStr(value.slice(0, 10));
  const time = value.slice(11, 16); if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return runtimeError('EVENT_INVALID', '时刻的小时或分钟不合法');
  return new Date(value).toISOString();
}
export type Schedule = Pick<Todo, 'due_date' | 'end_date' | 'start_time' | 'end_time' | 'time_mode' | 'scheduled_start_at' | 'scheduled_end_at'>;
const localKeys = ['due_date', 'end_date', 'start_time', 'end_time'] as const;
export function resolveSchedule(input: NewTodoInput | UpdateTodoInput, zone: string, existing?: Todo): Schedule {
  const has = (key: keyof typeof input) => input[key] !== undefined;
  const localChanged = existing && localKeys.some(k => input[k] !== undefined && input[k] !== existing[k]);
  const utcPresent = has('scheduled_start_at') || has('scheduled_end_at');
  let mode = input.time_mode ?? existing?.time_mode ?? 'floating';
  if (!input.time_mode && existing?.time_mode === 'instant' && localChanged && !utcPresent) mode = 'floating';
  if (mode === 'instant') {
    if (input.time_mode === 'instant' && localKeys.some(k => input[k] !== undefined)) return runtimeError('CONTRACT_INVALID', '固定时刻不能同时指定日期或墙钟时间');
    if (localChanged && utcPresent) return runtimeError('CONTRACT_INVALID', '不能同时修改两套权威时间');
    const start = input.scheduled_start_at !== undefined ? input.scheduled_start_at : existing?.scheduled_start_at;
    const end = input.scheduled_end_at !== undefined ? input.scheduled_end_at : existing?.scheduled_end_at ?? null;
    if (!start) return runtimeError('CONTRACT_INVALID', '固定时刻必须有开始时间');
    const s = instant(start), e = end === null ? null : instant(end); if (e && e <= s) return runtimeError('CONTRACT_INVALID', '结束时间必须晚于开始时间');
    const a = wallClock(s, zone), b = e ? wallClock(e, zone) : null;
    return { time_mode: 'instant', scheduled_start_at: s, scheduled_end_at: e, due_date: a.date, start_time: a.time, end_date: b?.date && b.date !== a.date ? b.date : null, end_time: b?.time ?? null };
  }
  if (utcPresent && (input.scheduled_start_at != null || input.scheduled_end_at != null)) return runtimeError('CONTRACT_INVALID', 'UTC 字段只能用于 instant 模式');
  const date = input.due_date !== undefined ? input.due_date : existing?.due_date ?? null;
  const clear = input.due_date === null;
  const endDate = clear ? null : input.end_date !== undefined ? input.end_date : existing?.end_date ?? null;
  const start = clear ? null : input.start_time !== undefined ? input.start_time : existing?.start_time ?? null;
  const end = clear ? null : input.end_time !== undefined ? input.end_time : existing?.end_time ?? null;
  if (date !== null) ensureValidDateStr(date); if (endDate !== null) ensureValidDateStr(endDate);
  if ((start || end || endDate) && !date) return runtimeError('CONTRACT_INVALID', '设置时段时必须选择日期');
  if (endDate && date && endDate < date) return runtimeError('CONTRACT_INVALID', '结束日期不能早于开始日期');
  const re = /^([01]\d|2[0-3]):[0-5]\d$/;
  if ((start !== null && !re.test(start)) || (end !== null && !re.test(end))) return runtimeError('CONTRACT_INVALID', '起止时间格式应为 HH:MM');
  if (end && !start) return runtimeError('CONTRACT_INVALID', '结束时间需要开始时间');
  if (start && end && `${endDate ?? date}T${end}` <= `${date}T${start}`) return runtimeError('CONTRACT_INVALID', '结束时间必须晚于开始时间');
  return { time_mode: 'floating', scheduled_start_at: null, scheduled_end_at: null, due_date: date, end_date: endDate, start_time: start, end_time: end };
}
export function overdue(row: Record<string, unknown>, zone: string, now = new Date()): boolean {
  if (row.status !== 'open' || !row.due_date) return false;
  if (row.time_mode === 'instant' && row.scheduled_end_at) return String(row.scheduled_end_at) <= now.toISOString();
  const wall = wallClock(now, zone); const date = String(row.end_date ?? row.due_date);
  return row.end_time ? `${date}T${row.end_time}` <= `${wall.date}T${wall.time}` : date < wall.date;
}


/** 两种 SQLite 驱动的忙错误外形不同，对外仍使用同一可重试代码。 */
export function runtimeErrorInfo(error: unknown): { code: string; message: string; retryable: boolean } {
  const row = error && typeof error === 'object' ? error as { code?: unknown; errcode?: unknown } : {};
  const nativeCode = String(row.code ?? 'CONTRACT_INVALID');
  const code = nativeCode.startsWith('SQLITE_BUSY') || (typeof row.errcode === 'number' && (row.errcode & 255) === 5) ? 'SQLITE_BUSY' : nativeCode;
  return { code, message: error instanceof Error ? error.message : String(error), retryable: code === 'SQLITE_BUSY' };
}
