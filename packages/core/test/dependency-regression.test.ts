import { expect, it } from 'vitest';
import { mkCore } from './helpers';
import { addDays, todayStr } from '../src/utils/date';

it('漏做前置知识点时，后继未完成条目不能仍排在前置之前', () => {
  const ctx = mkCore();
  try {
    const yesterday = addDays(todayStr(), -1);
    const draft = ctx.core.study.draft({
      title: '先修调整', daily_minutes: 60, start_date: yesterday,
      knowledge_points: [
        { key: 'a', name: '前置', est_minutes: 60, outcome: '能解释 A' },
        { key: 'b', name: '后继', depends_on: ['a'], est_minutes: 60, outcome: '能解释 B' },
      ],
    });
    const { plan } = ctx.core.study.confirmDraft(draft.id);
    const a = plan.items.find(i => i.knowledge_key === 'a')!;
    const b = plan.items.find(i => i.knowledge_key === 'b')!;
    expect(a.date).toBe(yesterday);
    expect(b.date).toBe(todayStr());
    const suggestions = ctx.core.study.suggestAdjustments(plan.id);
    const aDate = suggestions.find(s => s.item_id === a.id)?.to_date ?? a.date;
    const bDate = suggestions.find(s => s.item_id === b.id)?.to_date ?? b.date;
    expect(bDate > aDate).toBe(true);
  } finally { ctx.cleanup(); }
});

it('只应用前置改期也不能使已落库计划的后继早于前置', () => {
  const ctx = mkCore();
  try {
    const yesterday = addDays(todayStr(), -1);
    const draft = ctx.core.study.draft({
      title: '先修部分确认', daily_minutes: 60, start_date: yesterday,
      knowledge_points: [
        { key: 'a', name: '前置', est_minutes: 60, outcome: '能解释 A' },
        { key: 'b', name: '后继', depends_on: ['a'], est_minutes: 60, outcome: '能解释 B' },
      ],
    });
    const { plan } = ctx.core.study.confirmDraft(draft.id);
    const a = plan.items.find(i => i.knowledge_key === 'a')!;
    const suggestions = ctx.core.study.suggestAdjustments(plan.id);
    const aPick = suggestions.find(s => s.item_id === a.id)!;
    expect(aPick).toBeTruthy();
    ctx.core.study.applyAdjustments(plan.id, [{ id: aPick.id, to_date: aPick.to_date }]);
    const current = ctx.core.plans.get(plan.id);
    const aNow = current.items.find(i => i.knowledge_key === 'a')!;
    const bNow = current.items.find(i => i.knowledge_key === 'b')!;
    expect(bNow.date > aNow.date).toBe(true);
  } finally { ctx.cleanup(); }
});
