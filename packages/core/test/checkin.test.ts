// 打卡服务测试
import { describe, expect, it } from 'vitest';
import { addDays, todayStr } from '../src/utils/date';
import { mkCore } from './helpers';

describe('打卡服务', () => {
  it('每日打卡幂等：同一天重复打卡只保留一条', () => {
    const { core, cleanup } = mkCore();
    try {
      const today = todayStr();
      core.checkins.checkin({ ref_type: 'day', note: '第一天' });
      core.checkins.checkin({ ref_type: 'day', note: '再来一次' });
      const dayCheckins = core.checkins.list({ ref_type: 'day' });
      expect(dayCheckins).toHaveLength(1);
      expect(dayCheckins[0].note).toBe('再来一次');
    } finally {
      cleanup();
    }
  });

  it('连续天数：今天+昨天打卡=2；断档后重新计数', () => {
    const { core, cleanup } = mkCore();
    try {
      const today = todayStr();
      expect(core.checkins.streak()).toBe(0);
      core.checkins.checkin({ ref_type: 'day', date: addDays(today, -1) });
      core.checkins.checkin({ ref_type: 'day', date: today });
      expect(core.checkins.streak()).toBe(2);

      core.checkins.checkin({ ref_type: 'day', date: addDays(today, -3) });
      // -3 与 -1 之间断档，但锚点仍是今天→昨天
      expect(core.checkins.streak()).toBe(2);

      // 把今天的删掉，只剩 -3 与 -1/-2? → -1 有，-2 无 → 锚昨天链长 1
      core.checkins.remove('day', 0, today);
      expect(core.checkins.streak()).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('统计：近 7/30 天活跃天数', () => {
    const { core, cleanup } = mkCore();
    try {
      const today = todayStr();
      core.checkins.checkin({ ref_type: 'day', date: today });
      core.checkins.checkin({ ref_type: 'day', date: addDays(today, -5) });
      const s = core.checkins.stats();
      expect(s.active_days_last_7).toBe(2);
      expect(s.active_days_last_30).toBe(2);
      expect(s.total_checkins).toBe(2);
    } finally {
      cleanup();
    }
  });
});
