// 间隔复习调度服务测试
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkCore, type TestCtx } from './helpers';

let ctx: TestCtx;

beforeEach(() => {
  ctx = mkCore();
});

afterEach(() => {
  ctx.cleanup();
});

describe('createReviewService.schedule', () => {
  it('默认间隔 [1,3,7,21]：单主题生成 4 条 review 条目，日期 = 学完日 + 间隔', () => {
    const plan = ctx.core.reviews.schedule({
      topics: ['TS 协变与逆变'],
      start_date: '2026-09-23',
    });
    expect(plan.items).toHaveLength(4);
    expect(plan.items.every((i) => i.item_type === 'review')).toBe(true);
    // start_date 即学完日：D+1/D+3/D+7/D+21
    expect(plan.items.map((i) => i.date)).toEqual([
      '2026-09-24',
      '2026-09-26',
      '2026-09-30',
      '2026-10-14',
    ]);
    expect(plan.items[0].content).toContain('TS 协变与逆变');
    expect(plan.end_date).toBe('2026-10-14');
  });

  it('多主题混合字符串与对象：每个主题独立 learned_date，跨月日期正确', () => {
    const plan = ctx.core.reviews.schedule({
      topics: ['快照测试', { name: 'MCP 协议', learned_date: '2026-09-20' }],
      start_date: '2026-09-28',
      intervals: [1, 2],
    });
    expect(plan.items).toHaveLength(4);
    // 快照测试按 start_date=09-28 基准
    expect(plan.items.map((i) => `${i.date}:${i.content}`)).toContain('2026-09-29:复习：快照测试（第 1 天）');
    // MCP 协议按自己学完日 09-20 基准
    expect(plan.items.map((i) => `${i.date}:${i.content}`)).toContain('2026-09-21:复习：MCP 协议（第 1 天）');
    // 计划起点自动扩展到最早复习日（09-20+1），不丢早期复习
    expect(plan.start_date).toBe('2026-09-21');
  });

  it('跨月末日期加法正确（09-29 +3 → 10-02）', () => {
    const plan = ctx.core.reviews.schedule({
      topics: [{ name: '月末知识点', learned_date: '2026-09-29' }],
      start_date: '2026-09-29',
      intervals: [3],
    });
    expect(plan.items[0].date).toBe('2026-10-02');
  });

  it('自动生成关联待办且打卡联动正常（复习条目 done → 打卡 + 待办完成）', () => {
    const plan = ctx.core.reviews.schedule({
      topics: ['闭包'],
      start_date: '2026-09-01',
      intervals: [1],
    });
    const item = plan.items[0];
    expect(item.todo_id).not.toBeNull();
    const updated = ctx.core.plans.updateItemStatus(item.id, 'done');
    expect(updated.status).toBe('done');
    // 关联待办被联动完成
    const todo = ctx.core.todos.list({ status: 'all', search: '闭包' }).find((t) => t.id === item.todo_id);
    expect(todo?.status).toBe('done');
    // 打卡统计 +1（plan_item）
    const stats = ctx.core.checkins.stats();
    expect(stats.total_checkins).toBe(1);
  });

  it('create_todos=false 时不生成待办', () => {
    const plan = ctx.core.reviews.schedule({
      topics: ['纯复习不留待办'],
      start_date: '2026-09-23',
      create_todos: false,
    });
    expect(plan.items.every((i) => i.todo_id === null)).toBe(true);
  });

  it('标题缺省自动生成：含主题名，超过 3 个主题带「等」', () => {
    const a = ctx.core.reviews.schedule({ topics: ['A'], start_date: '2026-09-23' });
    expect(a.title).toBe('间隔复习：A');
    const b = ctx.core.reviews.schedule({
      topics: ['A', 'B', 'C', 'D'],
      start_date: '2026-09-23',
    });
    expect(b.title).toBe('间隔复习：A、B、C 等');
  });

  it('自定义标题与时长透传', () => {
    const plan = ctx.core.reviews.schedule({
      title: 'React hooks 专项复习',
      topics: ['useEffect 清理'],
      start_date: '2026-09-23',
      duration_min: 25,
    });
    expect(plan.title).toBe('React hooks 专项复习');
    expect(plan.items.every((i) => i.duration_min === 25)).toBe(true);
  });

  it('参数校验：空主题 / 空名称 / 非法间隔均报错', () => {
    expect(() => ctx.core.reviews.schedule({ topics: [], start_date: '2026-09-23' })).toThrow('topics');
    expect(() =>
      ctx.core.reviews.schedule({ topics: [{ name: '  ' }], start_date: '2026-09-23' }),
    ).toThrow('名称');
    expect(() =>
      ctx.core.reviews.schedule({ topics: ['X'], start_date: '2026-09-23', intervals: [0] }),
    ).toThrow('正整数');
    expect(() =>
      ctx.core.reviews.schedule({ topics: ['X'], start_date: '2026-09-23', intervals: [] }),
    ).toThrow('间隔');
  });

  it('重复间隔自动去重', () => {
    const plan = ctx.core.reviews.schedule({
      topics: ['去重'],
      start_date: '2026-09-23',
      intervals: [1, 1, 3],
    });
    expect(plan.items).toHaveLength(2);
  });
});
