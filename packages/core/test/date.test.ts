// 日期工具：parseDateInput 相对别名解析
import { describe, expect, it } from 'vitest';
import { addDays, parseDateInput, todayStr } from '../src/utils/date';

describe('parseDateInput 相对日期别名', () => {
  it('today/今天 → 今天；大小写不敏感', () => {
    expect(parseDateInput('today')).toBe(todayStr());
    expect(parseDateInput('TODAY')).toBe(todayStr());
    expect(parseDateInput('今天')).toBe(todayStr());
    expect(parseDateInput('  今天 ')).toBe(todayStr());
  });

  it('明天/后天/昨天 → 相应偏移', () => {
    expect(parseDateInput('tomorrow')).toBe(addDays(todayStr(), 1));
    expect(parseDateInput('明天')).toBe(addDays(todayStr(), 1));
    expect(parseDateInput('后天')).toBe(addDays(todayStr(), 2));
    expect(parseDateInput('yesterday')).toBe(addDays(todayStr(), -1));
    expect(parseDateInput('昨天')).toBe(addDays(todayStr(), -1));
  });

  it('绝对日期原样返回（真实日期）', () => {
    expect(parseDateInput('2026-10-08')).toBe('2026-10-08');
  });

  it('非法输入报错', () => {
    expect(() => parseDateInput('不合法日期')).toThrow();
    expect(() => parseDateInput('2026-02-30')).toThrow();
    expect(() => parseDateInput('')).toThrow();
  });
});
