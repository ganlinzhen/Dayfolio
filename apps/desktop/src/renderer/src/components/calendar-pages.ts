import type { CalendarQuery, CalendarResult } from '../../../../../../packages/core/src/runtime-types';
interface Result { ok: boolean; data?: CalendarResult; error?: string; code?: string }
/** 一轮查询收齐所有页；中途数据变更交由调用者整轮重试，不拼接新旧快照。 */
export async function loadCalendarPages(request: (input: CalendarQuery) => Promise<Result>, input: CalendarQuery): Promise<CalendarResult> {
  let first: CalendarResult | undefined, cursor: string | undefined;
  const itemColors:Record<string,string>={};
  const items: CalendarResult['items'] = [], seen = new Set<string>();
  for (let page = 0; page < 50; page++) {
    const response = await request({ ...input, cursor, limit: 500 });
    if (!response.ok || !response.data) throw Object.assign(new Error(response.error ?? '日历读取失败'), { code: response.code });
    const result = response.data;
    first ??= result;Object.assign(itemColors,result.itemColors??{});
    if (result.revision !== first.revision) throw Object.assign(new Error('日历已变化，请重试'), { code: 'REVISION_CONFLICT' });
    for (const item of result.items) { if (seen.has(item.id)) throw new Error('日历分页返回重复项目'); seen.add(item.id); items.push(item); }
    if (!result.nextCursor) return { ...first, items, itemColors, nextCursor: null, truncated: false };
    if (result.nextCursor === cursor) throw new Error('日历游标未前进');
    cursor = result.nextCursor;
  }
  throw Object.assign(new Error('结果超过当前显示容量，请缩小日期范围；没有将部分结果当作完整日历展示'), { code: 'RESULT_NOT_COMPLETE' });
}
