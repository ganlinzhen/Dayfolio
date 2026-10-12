// 独立审查回归门槛（六项）：确认失败回滚 / 相同重试不加历史 / 纠正保留原答案 /
// 计划间证据隔离 / 预算逐条预占 / 预览快照绑定。适配 applyAdjustments 快照 API，不降低断言强度。
import { afterEach, expect, it } from 'vitest';
import { mkCore } from './helpers';
import { addDays, todayStr } from '../src/utils/date';
import type { TodoDeskCore } from '../src/index';

const contexts: ReturnType<typeof mkCore>[] = [];
const fresh = (): TodoDeskCore => {
  const c = mkCore();
  contexts.push(c);
  return c.core;
};
afterEach(() => {
  contexts.splice(0).forEach((c) => c.cleanup());
});

/** 两个知识点条目（同日、各 60 分钟）的学习计划；count 控制条目数 */
const makePlan = (core: TodoDeskCore, count = 1) =>
  core.plans.create({
    title: '隔离审查',
    goal: '验证',
    start_date: addDays(todayStr(), -2),
    end_date: todayStr(),
    daily_minutes: 60,
    items: Array.from({ length: count }, (_, i) => ({
      date: addDays(todayStr(), -1),
      content: '知识点' + i,
      knowledge_key: 'k' + i,
      duration_min: 60,
      item_type: 'learn' as const,
    })),
  });

it('确认草案失败应回滚已创建的计划与待办', () => {
  const c = fresh();
  const d = c.study.draft({ title: '事务测试', daily_minutes: 60, start_date: todayStr(), knowledge_points: [{ key: 'k', name: '知识点' }] });
  const todosBefore = c.todos.list({ status: 'all' }).length;
  c.db.exec("CREATE TRIGGER reject_confirm BEFORE UPDATE ON study_plan_drafts BEGIN SELECT RAISE(ABORT, '测试故障'); END;");
  expect(() => c.study.confirmDraft(d.id)).toThrow('测试故障');
  expect((c.db.prepare('SELECT count(*) AS n FROM study_plans').get() as { n: number }).n).toBe(0);
  expect(c.todos.list({ status: 'all' })).toHaveLength(todosBefore); // 生成的待办一并回滚
  // 故障清除后可正常确认
  c.db.exec('DROP TRIGGER reject_confirm');
  expect(c.study.confirmDraft(d.id).plan.items).toHaveLength(1);
});

it('相同自评重试不增加纠正历史', () => {
  const c = fresh();
  const x = { id: 'same', knowledge_key: 'k', question: '题目', answer: '答案', source: 'self' as const, score: 60 };
  c.study.recordAssessment(x);
  expect(c.study.recordAssessment(x).corrections).toHaveLength(0);
});

it('纠正记录保留原答案/反馈/依据', () => {
  const c = fresh();
  const x = { id: 'history', knowledge_key: 'k', question: '题目', answer: '原始错误答案', source: 'self' as const, score: 20 };
  c.study.recordAssessment(x);
  const updated = c.study.recordAssessment({ ...x, answer: '纠正答案', score: 80, feedback: '重讲通过', evidence: '对照教材' });
  expect(JSON.stringify(updated.corrections)).toContain('原始错误答案');
  expect(JSON.stringify(updated.corrections)).toContain('纠正答案');
  expect(updated.answer).toBe('纠正答案'); // 当前值更新，旧值只在历史里
});

it('其他计划的同名知识点证据不改变本计划掌握度', () => {
  const c = fresh();
  const a = makePlan(c);
  const b = makePlan(c);
  c.study.recordAssessment({ id: 'other', plan_id: b.id, knowledge_key: 'k0', question: '题目', answer: '答案', source: 'self', score: 95 });
  expect(c.study.getMastery({ plan_id: a.id }).entries[0].mastery).toBe('unknown'); // B 计划的 95 分不外溢
  expect(c.study.getMastery({ plan_id: b.id }).entries[0].mastery).toBe('strong');
  expect(c.study.getMastery({ knowledge_keys: ['k0'] }).entries[0].mastery).toBe('strong'); // 全局视图仍可见
});

it('两项各 60 分钟在预算 60 时不应建议同一天（逐条预占容量）', () => {
  const c = fresh();
  const p = makePlan(c, 2);
  const s = c.study.suggestAdjustments(p.id);
  expect(s).toHaveLength(2);
  expect(new Set(s.map((x) => x.to_date)).size).toBe(2);
  // 先后顺序保持：原计划顺序靠前的建议日期不晚于靠后的
  const dates = s.map((x) => x.to_date).sort();
  expect(dates[0] <= dates[1]).toBe(true);
});

it('单项超过每日预算时建议单独占用空闲日，不叠加既有安排', () => {
  const c = fresh();
  const p = c.plans.create({
    title: '超预算',
    start_date: addDays(todayStr(), -1),
    daily_minutes: 60,
    items: [
      { date: todayStr(), content: '今天已排 60 分钟', duration_min: 60, item_type: 'learn' },
      { date: addDays(todayStr(), -1), content: '昨天漏做的 90 分钟大块', knowledge_key: 'big', duration_min: 90, item_type: 'learn' },
    ],
  });
  const s = c.study.suggestAdjustments(p.id);
  const big = s.find((x) => x.item_id != null && x.reason.includes('90 分钟'));
  expect(big).toBeTruthy();
  expect(big!.to_date).toBe(addDays(todayStr(), 1)); // 今天已满 → 找完全空闲的明天
});

it('预览后计划变化不能静默执行新日期（快照绑定）', () => {
  const c = fresh();
  const p = makePlan(c, 2);
  const s = c.study.suggestAdjustments(p.id)[0];
  expect(s.to_date).toBe(todayStr());
  // 预览后把另一条目挪到今天占满预算，重算的建议日期应变化
  c.db.prepare('UPDATE plan_items SET date = ? WHERE id = ?').run(todayStr(), p.items[1].id);
  const stale = c.study.applyAdjustments(p.id, [{ id: s.id, to_date: s.to_date }]);
  expect(stale.applied).toHaveLength(0);
  expect(stale.skipped[0].reason).toContain('建议日期已变化');
  // 按新预览重新确认则可应用
  const fresh2 = c.study.suggestAdjustments(p.id)[0];
  const ok = c.study.applyAdjustments(p.id, [{ id: fresh2.id, to_date: fresh2.to_date }]);
  expect(ok.applied).toHaveLength(1);
});

it('超预算知识点排程：当天已有安排时单独占用新的一天（不叠加）', () => {
  const c = fresh();
  const d = c.study.draft({
    title: '超预算排程',
    daily_minutes: 120,
    start_date: todayStr(),
    knowledge_points: [
      { key: 'small', name: '小知识点', est_minutes: 60 },
      { key: 'huge', name: '大知识点', est_minutes: 150 },
    ],
  });
  // 小知识点占今天 60 分钟；大知识点 150 > 120 → 不与今天叠加，单独占用明天
  expect(d.items.map((i) => [i.knowledge_key, i.date])).toEqual([
    ['small', todayStr()],
    ['huge', addDays(todayStr(), 1)],
  ]);
  expect(d.assumptions.some((a) => a.includes('单独占用一天'))).toBe(true);
});
