import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkCore, type TestCtx } from './helpers';
import { createNewsScheduleService, newsScheduleWindow } from '../src/services/news-schedule';

describe('早午晚新闻调度与恢复补采', () => {
  let ctx: TestCtx;
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-27T04:10:00Z')); ctx = mkCore(); });
  afterEach(() => { ctx.cleanup(); vi.useRealTimers(); });

  it('使用北京时间时段，整点前不提前执行，跨日定位上一个应执行时段', () => {
    const times = ['08:00', '12:00', '17:00'];
    expect(newsScheduleWindow(new Date('2026-10-26T23:59:59Z'), times)).toEqual({
      due: { key: '2026-10-26/17:00/Asia-Shanghai', at: '2026-10-26T09:00:00.000Z' }, next: '2026-10-27T00:00:00.000Z',
    });
    expect(newsScheduleWindow(new Date('2026-10-27T04:00:00Z'), times).due?.key).toBe('2026-10-27/12:00/Asia-Shanghai');
    expect(newsScheduleWindow(new Date('2026-10-27T09:00:00Z'), times).next).toBe('2026-10-28T00:00:00.000Z');
  });

  it('错过多轮只补最近一轮，持久槽位跨宿主重建防重复', () => {
    const scheduler = createNewsScheduleService(ctx.core.db, ctx.core.newsFeed);
    const batch = scheduler.tick();
    expect(batch?.trigger).toBe('scheduled');
    expect(scheduler.getStatus().latest?.slot_key).toBe('2026-10-27/12:00/Asia-Shanghai');
    expect(scheduler.tick()).toBeNull();
    expect(createNewsScheduleService(ctx.core.db, ctx.core.newsFeed).tick()).toBeNull();
    expect(ctx.core.newsFeed.listBatches()).toHaveLength(1);
    expect(ctx.core.db.prepare('SELECT COUNT(*) AS n FROM news_schedule_slots').get()?.n).toBe(1);
  });

  it('定时复用活动手动批次，完成后不为同一槽位重新采集', () => {
    const manual = ctx.core.newsFeed.startUpdate();
    const scheduler = createNewsScheduleService(ctx.core.db, ctx.core.newsFeed);
    expect(scheduler.tick()?.id).toBe(manual.id);
    ctx.core.newsFeed.stopUpdate(manual.id);
    expect(scheduler.tick()).toBeNull();
    vi.setSystemTime(new Date('2026-10-27T09:00:00Z'));
    expect(scheduler.tick()?.id).not.toBe(manual.id);
    expect(ctx.core.newsFeed.listBatches()).toHaveLength(2);
  });

  it('关闭计划不会建立批次，修改时刻立即用于尚未触发的槽位', () => {
    const before = ctx.core.newsFeed.getConfig();
    ctx.core.newsFeed.updateConfig({ config: { ...before, schedule: { ...before.schedule, enabled: false } }, expected_revision: before.revision });
    const scheduler = createNewsScheduleService(ctx.core.db, ctx.core.newsFeed);
    expect(scheduler.tick()).toBeNull(); expect(scheduler.getStatus().next_at).toBeNull();
    const disabled = ctx.core.newsFeed.getConfig();
    ctx.core.newsFeed.updateConfig({ config: { ...disabled, schedule: { ...disabled.schedule, enabled: true, times: ['10:00', '16:00'] } }, expected_revision: disabled.revision });
    expect(scheduler.tick()).not.toBeNull();
    expect(scheduler.getStatus().latest?.slot_key).toBe('2026-10-27/10:00/Asia-Shanghai');
    expect(scheduler.getStatus().next_at).toBe('2026-10-27T08:00:00.000Z');
  });
});
