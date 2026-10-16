// 日历服务测试：CRUD、跨天相交、rangeAgenda 聚合、今日概览集成
import { describe, expect, it } from 'vitest';
import { addDays, todayStr } from '../src/utils/date';
import { mkCore } from './helpers';

describe('日历服务', () => {
  it('CRUD 与默认值：全天缺省 blue/app；update 未传字段保持；删除后再取报错', () => {
    const { core, cleanup } = mkCore();
    try {
      const t = todayStr();
      const ev = core.calendar.add({ title: '写周报', date: t });
      expect(ev.start_time).toBeNull();
      expect(ev.end_date).toBeNull();
      expect(ev.color).toBe('blue');
      expect(ev.source).toBe('app');

      const upd = core.calendar.update(ev.id, { title: '写周报（升级版）', color: 'rose' });
      expect(upd.title).toBe('写周报（升级版）');
      expect(upd.color).toBe('rose');
      expect(upd.date).toBe(t); // 未传日期不动

      core.calendar.remove(ev.id);
      expect(core.calendar.get(ev.id)).toBeNull();
      expect(() => core.calendar.update(ev.id, { title: 'x' })).toThrow(/不存在/);
    } finally {
      cleanup();
    }
  });

  it('区间相交：跨天日程在区间每一天可见，边界日含端点', () => {
    const { core, cleanup } = mkCore();
    try {
      const t = todayStr();
      core.calendar.add({ title: '出差', date: addDays(t, -1), end_date: addDays(t, 1) });
      // 只查明天：跨天日程与 [t+1, t+1] 相交
      const next = core.calendar.list({ from: addDays(t, 1), to: addDays(t, 1) });
      expect(next.map((e) => e.title)).toContain('出差');
      // 上周不相关
      const past = core.calendar.list({ from: addDays(t, -10), to: addDays(t, -5) });
      expect(past).toHaveLength(0);
      // 端点当日（end_date=t+1）命中
      const edge = core.calendar.list({ from: addDays(t, 1), to: addDays(t, 5) });
      expect(edge).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it('排序：同日全天在最前，再按开始时间', () => {
    const { core, cleanup } = mkCore();
    try {
      const t = todayStr();
      core.calendar.add({ title: '下午同步', date: t, start_time: '14:00' });
      core.calendar.add({ title: '全天纪念', date: t });
      core.calendar.add({ title: '晨会', date: t, start_time: '09:00' });
      const list = core.calendar.list({ from: t, to: t });
      expect(list.map((e) => e.title)).toEqual(['全天纪念', '晨会', '下午同步']);
    } finally {
      cleanup();
    }
  });

  it('rangeAgenda 聚合到期待办、学习条目与每日打卡', () => {
    const { core, cleanup } = mkCore();
    try {
      const t = todayStr();
      core.calendar.add({ title: '日程A', date: t });
      core.todos.add({ title: '区间内到期待办', due_date: t, priority: 'high' });
      core.plans.create({
        title: '聚合测试计划',
        start_date: t,
        items: [{ date: t, content: '第一章' }],
      });
      core.checkins.checkin({ ref_type: 'day', date: t });

      const agenda = core.calendar.rangeAgenda({ from: t, to: t });
      expect(agenda.events.map((e) => e.title)).toContain('日程A');
      const day = agenda.days[t];
      expect(day.todos.map((x) => x.title)).toContain('区间内到期待办');
      expect(day.plan_items.map((x) => x.content)).toContain('第一章');
      expect(day.plan_items[0].plan_title).toBe('聚合测试计划');
      expect(day.checked_in).toBe(true);
      expect(agenda.days[addDays(t, 1)]).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('今日概览带出今日日程（跨天与全天都算今天）', () => {
    const { core, cleanup } = mkCore();
    try {
      const t = todayStr();
      core.calendar.add({ title: '今天的全天', date: t });
      core.calendar.add({ title: '跨天路过今天', date: addDays(t, -2), end_date: addDays(t, 3) });
      core.calendar.add({ title: '明天的', date: addDays(t, 1) });
      const ov = core.today.getToday(t);
      expect(ov.calendar_events.map((e) => e.title).sort()).toEqual(['今天的全天', '跨天路过今天']);
      expect(ov.summary_text).toContain('日程 2 项');
    } finally {
      cleanup();
    }
  });

  it('校验拒绝：标题空、结束日期早于开始、时间格式、全天带结束时间、未知颜色、区间倒置/过长', () => {
    const { core, cleanup } = mkCore();
    try {
      const t = todayStr();
      expect(() => core.calendar.add({ title: '  ', date: t })).toThrow(/标题/);
      expect(() => core.calendar.add({ title: 'x', date: t, end_date: addDays(t, -1) })).toThrow(/早于/);
      expect(() => core.calendar.add({ title: 'x', date: t, start_time: '9:00' })).toThrow(/时间格式/);
      expect(() => core.calendar.add({ title: 'x', date: t, start_time: '09:00', end_time: '08:00' })).toThrow(/不晚于/);
      expect(() => core.calendar.add({ title: 'x', date: t, end_time: '10:00' })).toThrow(/全天/);
      expect(() => core.calendar.add({ title: 'x', date: t, color: 'pink' as never })).toThrow(/颜色|color/);
      expect(() => core.calendar.list({ from: addDays(t, 5), to: t })).not.toThrow(); // list 只是把空集
      expect(() => core.calendar.rangeAgenda({ from: addDays(t, 5), to: t })).toThrow(/早于/);
      expect(() => core.calendar.rangeAgenda({ from: t, to: addDays(t, 200) })).toThrow(/区间过长/);
    } finally {
      cleanup();
    }
  });
});
