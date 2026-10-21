import { describe, expect, it } from 'vitest';
import { sliceItems, placeTimed, placeAllDay, type CalendarItem, type CalendarResult } from '../src/renderer/src/components/calendar-view';
import { loadCalendarPages } from '../src/renderer/src/components/calendar-pages';
import { slotMinute, draftEnd, draftTimes } from '../src/renderer/src/components/calendar-draft';
const event = (id: string, startAt: string, endAt: string | null): CalendarItem => ({ id, title: id, collectionId: 'builtin.todo', kind: 'todo', timeKind: 'timed', startAt, endAt, startDate: null, endDateExclusive: null, status: 'open', sourceStatus: null, target: { objectType: 'todo', id }, allowedActions: ['open'] });
const days = ['2026-11-01', '2026-11-02'];
describe('日历草稿时间边界', () => {
  it('空白位置按 15 分钟向下取整，并限制在当天', () => {
    expect(slotMinute(-10)).toBe(0);
    expect(slotMinute(9 * 60 + 29)).toBe(9 * 60 + 15);
    expect(slotMinute(1500)).toBe(1425);
  });
  it('拖动至少保留 15 分钟，吸附刻度且不越过当天末尾', () => {
    expect(draftEnd(540, 520)).toBe(555);
    expect(draftEnd(540, 578)).toBe(585);
    expect(draftEnd(1425, 1500)).toBe(1440);
  });
  it('24:00 保存为次日零点，其他时段不产生跨日日期', () => {
    expect(draftTimes({day:'2026-12-31',start:1425,end:1440})).toEqual({date:'2026-12-31',start:'23:45',end:'00:00',endDate:'2027-01-01'});
    expect(draftTimes({day:'2026-12-31',start:540,end:555})).toEqual({date:'2026-12-31',start:'09:00',end:'09:15',endDate:''});
  });
});
describe('统一日历显示切片', () => {
  it('跨午夜是两个定时切片，未知结束只保留视觉高度且不写业务结束', () => {
    const cross = event('cross', '2026-11-01T23:30:00Z', '2026-11-02T01:30:00Z'), unknown = event('unknown', '2026-11-02T03:00:00Z', null);
    const slices = sliceItems([cross, unknown], days, 'Europe/London');
    expect(slices).toHaveLength(3); expect(slices[0]).toMatchObject({ startMinute: 1410, visualEnd: 1440, allDay: false, continuesAfter: true });
    expect(slices[1]).toMatchObject({ startMinute: 0, visualEnd: 90, continuesBefore: true });
    expect(slices[2]).toMatchObject({ visualEnd: 240, label: '03:00 · 结束待定' }); expect(unknown.endAt).toBeNull();
    expect(sliceItems([event('midnight', '2026-11-01T22:00:00Z', '2026-11-02T00:00:00Z')], days, 'UTC')).toHaveLength(1);
  });
  it('分类过滤后的重叠布局重新计算，不留下空列', () => {
    const a = event('a', '2026-11-01T08:00:00Z', '2026-11-01T10:00:00Z'), b = event('b', '2026-11-01T09:00:00Z', null);
    expect(placeTimed(sliceItems([a, b], days, 'UTC')).map(s => s.cols)).toEqual([2, 2]);
    expect(placeTimed(sliceItems([a], days, 'UTC'))[0].cols).toBe(1);
  });
  it('全天跨列与夏令时回拨的真实定时区分', () => {
    const all: CalendarItem = { ...event('all', '', null), timeKind: 'all_day', startAt: null, endAt: null, startDate: days[0], endDateExclusive: '2026-11-03' };
    const bars = placeAllDay(sliceItems([all], days, 'UTC'), days); expect(bars[0][0]).toMatchObject({ start: 0, span: 2 });
    const fold = event('fold', '2026-10-25T00:45:00Z', '2026-10-25T01:20:00Z');
    const slice = sliceItems([fold], ['2026-10-25'], 'Europe/London')[0]; expect(slice.visualEnd - slice.startMinute).toBe(35);
  });
  it('收齐超过一页项目，分页变更拒绝混合快照', async () => {
    const result = (revision: number, nextCursor: string | null, id: string): CalendarResult => ({ revision, items: [event(id, '2026-11-01T00:00:00Z', null)], nextCursor, truncated: nextCursor !== null, collections: [], countsByDay: { '2026-11-01': 2 } });
    let calls = 0;
    const full = await loadCalendarPages(async p => ({ ok: true, data: p.cursor ? result(1, null, 'b') : result(++calls, 'next', 'a') }), { fromDate: days[0], toDateExclusive: days[1], displayTimezone: 'UTC' });
    expect(full.items).toHaveLength(2); expect(full.countsByDay[days[0]]).toBe(2);
    await expect(loadCalendarPages(async p => ({ ok: true, data: p.cursor ? result(2, null, 'b') : result(1, 'next', 'a') }), { fromDate: days[0], toDateExclusive: days[1], displayTimezone: 'UTC' })).rejects.toThrow('日历已变化');
  });
});
