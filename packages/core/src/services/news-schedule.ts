// 本地新闻调度：以北京时间的最近一个应执行时段合并补采，槽位与批次在同一事务中记录。
import { inTx, type DbAdapter } from '../db';
import type { NewsFeedBatch, NewsFeedConfig } from '../news-types';

interface ScheduleFeed {
  getConfig(): NewsFeedConfig;
  startUpdate(input: { trigger: 'scheduled'; slot_key: string }): NewsFeedBatch;
}
export interface NewsScheduleSlot {
  slot_key: string; scheduled_at: string; attempted_at: string; batch_id: string | null; error: string | null;
}
export interface NewsScheduleStatus {
  enabled: boolean; timezone: 'Asia/Shanghai'; times: string[];
  next_at: string | null; latest: NewsScheduleSlot | null;
}

/** 时区固定为配置中明确的 Asia/Shanghai，不依赖运行机器当前时区。 */
export function newsScheduleWindow(now: Date, times: string[]): { due: { key: string; at: string } | null; next: string | null } {
  if (!Number.isFinite(now.getTime())) throw new Error('新闻调度时间无效');
  const shifted = new Date(now.getTime() + 8 * 3600_000);
  const date = shifted.toISOString().slice(0, 10);
  const midnight = Date.parse(`${date}T00:00:00+08:00`);
  const safeTimes = [...new Set(times)].filter(value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value)).sort();
  if (!safeTimes.length) return { due: null, next: null };
  const slots: Array<{ key: string; timestamp: number }> = [];
  for (const offset of [-1, 0, 1]) for (const time of safeTimes) {
    const [hour, minute] = time.split(':').map(Number);
    const timestamp = midnight + offset * 86400_000 + hour * 3600_000 + minute * 60_000;
    const day = new Date(timestamp + 8 * 3600_000).toISOString().slice(0, 10);
    slots.push({ key: `${day}/${time}/Asia-Shanghai`, timestamp });
  }
  const due = slots.filter(slot => slot.timestamp <= now.getTime()).at(-1);
  const next = slots.find(slot => slot.timestamp > now.getTime());
  return { due: due ? { key: due.key, at: new Date(due.timestamp).toISOString() } : null, next: next ? new Date(next.timestamp).toISOString() : null };
}

export function createNewsScheduleService(db: DbAdapter, feed: ScheduleFeed) {
  const getStatus = (now = new Date()): NewsScheduleStatus => {
    const config = feed.getConfig();
    const row = db.prepare('SELECT * FROM news_schedule_slots ORDER BY scheduled_at DESC LIMIT 1').get();
    return {
      ...config.schedule,
      next_at: config.schedule.enabled ? newsScheduleWindow(now, config.schedule.times).next : null,
      latest: row ? {
        slot_key: String(row.slot_key), scheduled_at: String(row.scheduled_at), attempted_at: String(row.attempted_at),
        batch_id: row.batch_id == null ? null : String(row.batch_id), error: row.error == null ? null : String(row.error),
      } : null,
    };
  };
  const tick = (now = new Date()): NewsFeedBatch | null => inTx(db, () => {
    const config = feed.getConfig();
    if (!config.schedule.enabled) return null;
    const { due } = newsScheduleWindow(now, config.schedule.times);
    if (!due || db.prepare('SELECT 1 FROM news_schedule_slots WHERE slot_key=?').get(due.key)) return null;
    // startUpdate 会复用正在执行的手动批次；即使复用也消费该槽位，不在完成后再重复启动。
    const batch = feed.startUpdate({ trigger: 'scheduled', slot_key: due.key });
    db.prepare('INSERT INTO news_schedule_slots(slot_key,scheduled_at,attempted_at,batch_id,error) VALUES(?,?,?,?,NULL)')
      .run(due.key, due.at, now.toISOString(), batch.id);
    return batch;
  });
  return { getStatus, tick };
}
