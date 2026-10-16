// 本地时区日期工具（统一使用 YYYY-MM-DD 字符串，字典序即时间序）

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 当前本地日期 YYYY-MM-DD */
export function todayStr(): string {
  return toDateStr(new Date());
}

export function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 日期字符串加 n 天（n 可为负） */
export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return toDateStr(dt);
}

/** 校验必须是真实存在的日期，格式 YYYY-MM-DD，通过则原样返回 */
export function ensureValidDateStr(s: string): string {
  if (!DATE_RE.test(s)) {
    throw new Error(`日期格式错误："${s}"，应为 YYYY-MM-DD`);
  }
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
    throw new Error(`日期不存在："${s}"`);
  }
  return s;
}

/** 相对日期别名 → 距今天数（供 parseDateInput 用） */
const DATE_INPUT_ALIASES: Record<string, number> = {
  today: 0, '今天': 0, '当日': 0,
  tomorrow: 1, '明天': 1, '次日': 1,
  '后天': 2, day_after_tomorrow: 2,
  yesterday: -1, '昨天': -1,
};

/**
 * 宽松日期解析（agent 输入友好）：支持 today/tomorrow/yesterday 及中文别名
 * 「今天/明天/后天/昨天」，其余按 YYYY-MM-DD 严格校验；一律返回绝对日期。
 */
export function parseDateInput(s: string, baseDate = todayStr()): string {
  const trimmed = s.trim();
  const offset = DATE_INPUT_ALIASES[trimmed.toLowerCase()] ?? DATE_INPUT_ALIASES[trimmed];
  if (offset !== undefined) return addDays(baseDate, offset);
  return ensureValidDateStr(trimmed);
}

/** 当前本地时间完整时间戳（格式 YYYY-MM-DDTHH:mm:ss.sss，本地时区，保证日期前缀与本地日期一致） */
export function nowIso(): string {
  return localIso(new Date());
}

/** 指定时刻的本地时间戳（同 nowIso 格式；offsetMs 相对现在，可为负） */
export function isoAfter(offsetMs: number): string {
  return localIso(new Date(Date.now() + offsetMs));
}

function localIso(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  );
}
