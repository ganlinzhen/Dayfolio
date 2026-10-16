// 墙钟时间仅在日历投影时转换；不会回写 floating 业务字段。
import { ensureValidDateStr } from './date';
import { ensureTimezone, runtimeError, wallClock } from './schedule';

/** 重复钟点选较早时刻；夏令时缺口采用向前平移的兼容消歧。 */
export function zonedInstant(date: string, time: string, zone: string): string {
  ensureValidDateStr(date); ensureTimezone(zone);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return runtimeError('CONTRACT_INVALID', '墙钟时间格式应为 HH:MM');
  const wanted = Date.parse(`${date}T${time}:00Z`);
  const offsets = new Set<number>();
  for (let hour = -36; hour <= 36; hour += 6) {
    const utc = wanted + hour * 3600000;
    const wall = wallClock(new Date(utc), zone);
    offsets.add(Date.parse(`${wall.date}T${wall.time}:00Z`) - utc);
  }
  const candidates = [...offsets].map(offset => wanted - offset).sort((a, b) => a - b);
  const local = (utc: number) => { const w = wallClock(new Date(utc), zone); return Date.parse(`${w.date}T${w.time}:00Z`); };
  const exact = candidates.find(utc => local(utc) === wanted);
  const forward = candidates.filter(utc => local(utc) > wanted).sort((a, b) => local(a) - local(b))[0];
  const result = exact ?? forward;
  if (result === undefined) return runtimeError('CONTRACT_INVALID', '该墙钟时间不能转换为显示时区');
  return new Date(result).toISOString();
}
