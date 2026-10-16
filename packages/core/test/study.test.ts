// 学习闭环 v1 单测：草案（预览→确认/取消）、会话幂等、测评证据与纠正历史、
// 掌握度与完成率分离、调整建议纯预览/应用只动未完成项、卡片防重与用户编辑保护、重启持久化。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openNodeSqliteDb } from '../src/adapters/node-sqlite';
import { createCore, type TodoDeskCore } from '../src/index';
import { addDays, todayStr } from '../src/utils/date';
import { mkCore } from './helpers';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups) fn();
  cleanups = [];
});

/** 独立临时库，支持「关闭重开」模拟 App/MCP 重启（dbPath 必传：资产根不得回退真实应用数据目录） */
function mkPersistentCore(): { core: TodoDeskCore; reopen: () => TodoDeskCore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tododesk-study-test-'));
  const dbPath = join(dir, 'study.db');
  const open = () => createCore(openNodeSqliteDb(dbPath), { dbPath });
  const first = open();
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return { core: first, reopen: open, dir };
}

/** 一个最小可用的线性代数知识点分解（agent 视角输入） */
const LINALG_POINTS = [
  { key: 'vectors', name: '向量与线性组合', est_minutes: 60, outcome: '能不用资料解释线性组合并举一个例子' },
  { key: 'matrix-mult', name: '矩阵乘法', est_minutes: 90, outcome: '能手算 2x2 矩阵乘法并说明行列视角', depends_on: ['vectors'] },
  { key: 'determinant', name: '行列式', est_minutes: 60, outcome: '能解释行列式的几何意义', depends_on: ['matrix-mult'] },
];

describe('学习计划草案：透明排程 → 预览 → 确认/取消', () => {
  it('排程：每日预算 120 分钟时 60+90 分两天、依赖在前', () => {
    const { core } = mkCore();
    const draft = core.study.draft({
      title: '线性代数入门',
      goal: '为机器学习打线性代数基础',
      material_source: '《线性代数及其应用》第 1-2 章',
      daily_minutes: 120,
      start_date: '2026-10-12',
      knowledge_points: LINALG_POINTS,
    });
    expect(draft.status).toBe('draft');
    // 依赖排序：vectors → matrix-mult → determinant；预算 120：D0 vectors(60)，matrix-mult(90) 放不下 → D1，determinant(60) 与 90 同日超预算 → D2
    expect(draft.items.map((i) => i.knowledge_key)).toEqual(['vectors', 'matrix-mult', 'determinant']);
    expect(draft.items.map((i) => i.date)).toEqual(['2026-10-12', '2026-10-13', '2026-10-14']);
    expect(draft.end_date).toBe('2026-10-14');
    // 提供了完整信息的知识点不应产生假设
    expect(draft.assumptions).toHaveLength(0);
  });

  it('缺失时长/成果时记入 assumptions；依赖环与未知依赖报错', () => {
    const { core } = mkCore();
    const draft = core.study.draft({
      title: '最小草案',
      daily_minutes: 60,
      start_date: todayStr(),
      knowledge_points: [{ key: 'kp1', name: '知识点一' }],
    });
    expect(draft.assumptions).toEqual([
      '知识点「知识点一」未提供预计时长，按缺省 60 分钟排程',
      '知识点「知识点一」未提供可验证成果，建议补充（学完后如何证明掌握）',
    ]);
    expect(() =>
      core.study.draft({
        title: '环',
        daily_minutes: 60,
        start_date: todayStr(),
        knowledge_points: [
          { key: 'a', name: 'A', depends_on: ['b'] },
          { key: 'b', name: 'B', depends_on: ['a'] },
        ],
      }),
    ).toThrow('环');
    expect(() =>
      core.study.draft({
        title: '未知依赖',
        daily_minutes: 60,
        start_date: todayStr(),
        knowledge_points: [{ key: 'a', name: 'A', depends_on: ['ghost'] }],
      }),
    ).toThrow('ghost');
  });

  it('草案是纯预览：不创建计划/待办；取消后仍无任何计划副作用，且取消幂等', () => {
    const { core } = mkCore();
    const before = {
      plans: core.plans.list().length,
      todos: core.todos.list({ status: 'all' }).length,
    };
    const draft = core.study.draft({ title: '预览不落计划', daily_minutes: 120, start_date: todayStr(), knowledge_points: LINALG_POINTS });
    expect(core.plans.list()).toHaveLength(before.plans);
    expect(core.todos.list({ status: 'all' })).toHaveLength(before.todos);

    const cancelled = core.study.cancelDraft(draft.id);
    expect(cancelled.status).toBe('cancelled');
    expect(core.study.cancelDraft(draft.id).status).toBe('cancelled'); // 幂等
    expect(core.plans.list()).toHaveLength(before.plans);
    expect(core.todos.list({ status: 'all' })).toHaveLength(before.todos);
    // 已取消的草案不能确认
    expect(() => core.study.confirmDraft(draft.id)).toThrow('已取消');
  });

  it('确认草案：生成计划与逐日待办、daily_minutes 与 knowledge_key 落库；重复确认幂等不重复创建', () => {
    const { core } = mkCore();
    const draft = core.study.draft({
      title: '线性代数入门',
      daily_minutes: 120,
      start_date: todayStr(),
      knowledge_points: LINALG_POINTS,
    });
    const { plan } = core.study.confirmDraft(draft.id);
    expect(plan.items).toHaveLength(3);
    expect(plan.items.every((i) => i.todo_id != null)).toBe(true);
    expect(plan.daily_minutes).toBe(120);
    expect(plan.items.map((i) => i.knowledge_key)).toEqual(['vectors', 'matrix-mult', 'determinant']);

    const before = { plans: core.plans.list().length, todos: core.todos.list({ status: 'all' }).length };
    const again = core.study.confirmDraft(draft.id); // 幂等：返回同一计划
    expect(again.plan.id).toBe(plan.id);
    expect(core.plans.list()).toHaveLength(before.plans);
    expect(core.todos.list({ status: 'all' })).toHaveLength(before.todos);

    // 已确认的草案不能取消（应走计划归档）
    expect(() => core.study.cancelDraft(draft.id)).toThrow('已确认');
  });

  it('旧库兼容：迁移 v2 后老计划（无 daily_minutes/knowledge_key）与新表共存', () => {
    const { core } = mkCore();
    const legacy = core.plans.create({
      title: '老式手工计划',
      start_date: todayStr(),
      items: [{ date: todayStr(), content: '旧条目' }],
    });
    expect(legacy.daily_minutes).toBeNull();
    expect(legacy.items[0].knowledge_key).toBeNull();
    // 新功能照常工作
    const draft = core.study.draft({ title: '新草案', daily_minutes: 60, start_date: todayStr(), knowledge_points: [{ key: 'k', name: 'K' }] });
    expect(core.study.confirmDraft(draft.id).plan.daily_minutes).toBe(60);
  });
});

describe('学习会话：稳定 ID、多次尝试、重复提交幂等、重启持久化', () => {
  it('同一稳定 id 重复提交只更新一条；无 id 按 (目标, attempt) 复用；attempt 自动递增支持多次尝试', () => {
    const { core } = mkCore();
    const plan = core.plans.create({
      title: '会话测试计划',
      start_date: todayStr(),
      items: [{ date: todayStr(), content: '学矩阵乘法' }],
      daily_minutes: 60,
    });
    const item = plan.items[0];

    const s1 = core.study.recordSession({
      id: 'sess-stable-1',
      plan_item_id: item.id,
      plan_id: plan.id,
      knowledge_key: 'matrix-mult',
      topic: '矩阵乘法',
      actual_minutes: 40,
      explanation: '行乘列得到标量，逐格组合',
    });
    expect(s1.attempt).toBe(1);

    // 同一 id 重试（网络重试场景）：内容更新，不新增记录
    const s1b = core.study.recordSession({
      id: 'sess-stable-1',
      plan_item_id: item.id,
      knowledge_key: 'matrix-mult',
      actual_minutes: 45,
      explanation: '行乘列得到标量，逐格组合（修正：还应强调线性组合视角）',
      questions: '为什么矩阵乘法不可交换？',
      material_source: '教材 2.3 节',
    });
    expect(s1b.id).toBe('sess-stable-1');
    expect(s1b.actual_minutes).toBe(45);
    expect(core.study.listSessions({ plan_item_id: item.id })).toHaveLength(1);

    // 无 id 的重试：显式带同一 attempt → 按 (目标, attempt) 复用同一条（确定性 id）
    const retry2 = core.study.recordSession({ plan_item_id: item.id, knowledge_key: 'matrix-mult', attempt: 1, actual_minutes: 50 });
    expect(retry2.id).toBe('sess-stable-1');
    expect(core.study.listSessions({ plan_item_id: item.id })).toHaveLength(1);

    // 无 id 显式 attempt=2：独立第二次尝试，确定性 id
    const s2 = core.study.recordSession({ plan_item_id: item.id, knowledge_key: 'matrix-mult', attempt: 2, actual_minutes: 30, explanation: '第二次尝试：完整推导了 2x2 例子' });
    expect(s2.attempt).toBe(2);

    // 无 id 无 attempt：视为下一次尝试（attempt=3）；幂等契约要求重试时带稳定 id 或显式 attempt
    const s3 = core.study.recordSession({ plan_item_id: item.id, knowledge_key: 'matrix-mult', actual_minutes: 25, explanation: '第三次尝试' });
    expect(s3.attempt).toBe(3);
    // 显式 attempt 重试同一条：复用确定性 id
    const s2b = core.study.recordSession({ plan_item_id: item.id, knowledge_key: 'matrix-mult', attempt: 2, actual_minutes: 32, explanation: '第二次尝试（修订）' });
    expect(s2b.id).toBe(s2.id);
    expect(s2b.actual_minutes).toBe(32);
    expect(core.study.listSessions({ plan_item_id: item.id })).toHaveLength(3);

    // 稳定 id 不能挪用到别的目标
    expect(() =>
      core.study.recordSession({ id: 'sess-stable-1', knowledge_key: 'other', date: todayStr(), actual_minutes: 10 }),
    ).toThrow('不一致');
  });

  it('重启（重开数据库）后会话/测评/草案/导出记录全部持久化', () => {
    const { core, reopen, dir } = mkPersistentCore();
    const draft = core.study.draft({ title: '持久化草案', daily_minutes: 60, start_date: todayStr(), knowledge_points: [{ key: 'kp', name: 'K' }] });
    const { plan } = core.study.confirmDraft(draft.id);
    const session = core.study.recordSession({ id: 'sess-persist-1', plan_id: plan.id, knowledge_key: 'kp', actual_minutes: 25, explanation: 'e' });
    core.study.recordAssessment({ id: 'asm-persist-1', session_id: session.id, knowledge_key: 'kp', question: '解释 K', answer: '...', source: 'self', score: 70, feedback: '尚可' });
    const exportDir = join(dir, 'cards');
    core.study.exportCards({ session_ids: [session.id] }, exportDir);
    expect(existsSync(join(exportDir, `TD-kp-${session.id}.md`))).toBe(true);

    const core2 = reopen();
    expect(core2.study.listDrafts('confirmed')).toHaveLength(1);
    expect(core2.study.listSessions({ plan_id: plan.id })).toHaveLength(1);
    expect(core2.study.listAssessments({ knowledge_key: 'kp' })).toHaveLength(1);
    expect(core2.study.listCardExports()).toHaveLength(1);
    expect(core2.study.getMastery({ plan_id: plan.id }).entries[0].mastery).toBe('reviewing');
  });
});

describe('测评证据：来源显式、客观必须带判题依据、纠正历史保留', () => {
  it('objective 缺 evidence 或判题结果被拒绝；ai_suggestion 可记录但不计入掌握证据', () => {
    const { core } = mkCore();
    expect(() =>
      core.study.recordAssessment({ knowledge_key: 'k', question: '1+1?', answer: '2', source: 'objective', score: 100, objective_passed: true }),
    ).toThrow('evidence');
    expect(() =>
      core.study.recordAssessment({ knowledge_key: 'k', question: '1+1?', answer: '2', source: 'objective', evidence: '跑了脚本', score: 100 }),
    ).toThrow('objective_passed');

    core.study.recordAssessment({
      knowledge_key: 'k',
      question: '解释矩阵乘法的几何意义',
      answer: '线性变换的复合',
      source: 'ai_suggestion',
      score: 95,
      feedback: 'AI 建议：结论正确但缺例子',
      evidence: 'AI 客户端给出，非 Dayfolio 生成',
    });
    const report = core.study.getMastery({ knowledge_keys: ['k'] });
    expect(report.entries[0].mastery).toBe('unknown'); // AI 建议不算证据
    expect(report.entries[0].reason).toContain('不计为掌握证据');
  });

  it('自评可纠正：同一 id 更新保留完整历史；完全相同的重复提交不产生历史', () => {
    const { core } = mkCore();
    const a1 = core.study.recordAssessment({
      id: 'asm-self-1',
      knowledge_key: 'det',
      question: '行列式的几何意义？',
      answer: '面积缩放因子',
      source: 'self',
      score: 50,
      feedback: '自己感觉没讲清',
    });
    const a2 = core.study.recordAssessment({
      id: 'asm-self-1',
      knowledge_key: 'det',
      question: '行列式的几何意义？',
      answer: '补上定向解释后的完整答案',
      source: 'self',
      score: 85,
      feedback: '补了符号与定向的解释',
      evidence: '能独立复述例 3',
    });
    expect(a2.id).toBe(a1.id);
    expect(a2.score).toBe(85);
    expect(a2.corrections).toHaveLength(1);
    expect(a2.corrections[0]).toMatchObject({ from_score: 50, to_score: 85 });
    expect(JSON.stringify(a2.corrections)).toContain('面积缩放因子'); // 旧答案保留
    expect(JSON.stringify(a2.corrections)).toContain('自己感觉没讲清'); // 旧反馈保留
    // 完全相同的重复提交：幂等，不追加纠正历史
    const a3 = core.study.recordAssessment({
      id: 'asm-self-1',
      knowledge_key: 'det',
      question: '行列式的几何意义？',
      answer: '补上定向解释后的完整答案',
      source: 'self',
      score: 85,
      feedback: '补了符号与定向的解释',
      evidence: '能独立复述例 3',
    });
    expect(a3.corrections).toHaveLength(1);
    expect(core.study.listAssessments({ knowledge_key: 'det' })).toHaveLength(1);
  });

  it('掌握度与完成率分离：打卡完成 ≠ 掌握，无证据为 unknown', () => {
    const { core } = mkCore();
    const draft = core.study.draft({ title: '分离', daily_minutes: 60, start_date: todayStr(), knowledge_points: [{ key: 'vec', name: '向量' }] });
    const { plan } = core.study.confirmDraft(draft.id);
    const item = plan.items[0];
    core.plans.updateItemStatus(item.id, 'done'); // 打卡完成

    const report = core.study.getMastery({ plan_id: plan.id });
    expect(report.plan_progress).toEqual({ total_items: 1, done_items: 1, progress: 1 });
    expect(report.entries[0].mastery).toBe('unknown');
    expect(report.entries[0].reason).toContain('未知');

    // 自评 40 → weak；再自评 85 → strong（被后续证据纠正）
    core.study.recordAssessment({ plan_id: plan.id, knowledge_key: 'vec', question: 'Q', answer: 'A', source: 'self', score: 40 });
    expect(core.study.getMastery({ plan_id: plan.id }).entries[0].mastery).toBe('weak');
    core.study.recordAssessment({ plan_id: plan.id, knowledge_key: 'vec', question: 'Q2', answer: 'A2', source: 'self', score: 85 });
    expect(core.study.getMastery({ plan_id: plan.id }).entries[0].mastery).toBe('strong');

    // 客观优先：存在客观测评时以最新客观结果判定（较新的自评不覆盖客观）
    const obj = core.study.recordAssessment({
      plan_id: plan.id,
      knowledge_key: 'vec',
      question: '计算 [[1,2],[3,4]] 的行列式',
      answer: '-2',
      source: 'objective',
      score: 0,
      objective_passed: false,
      evidence: '与 Python numpy.linalg.det([[1,2],[3,4]]) = -2.0 核对',
    });
    expect(core.study.getMastery({ plan_id: plan.id }).entries[0].mastery).toBe('weak');
    expect(obj.objective_passed).toBe(false);
    core.study.recordAssessment({ plan_id: plan.id, knowledge_key: 'vec', question: '更晚的自评', answer: '我又觉得会了', source: 'self', score: 90 });
    expect(core.study.getMastery({ plan_id: plan.id }).entries[0].mastery).toBe('weak'); // 客观未通过仍为 weak
    void core.study.recordAssessment({
      plan_id: plan.id,
      knowledge_key: 'vec',
      question: '计算 [[1,2],[3,4]] 的行列式',
      answer: '-2',
      source: 'objective',
      score: 100,
      objective_passed: true,
      evidence: '与 numpy 核对一致，且口头复述符号法则',
    });
    expect(core.study.getMastery({ plan_id: plan.id }).entries[0].mastery).toBe('strong');
  });
});

describe('未完成项调整：纯预览不写库，应用只动未完成并同步待办', () => {
  /** 构造一个「昨天有条目没做 + 今天学了但自评薄弱」的计划 */
  function setup(core: TodoDeskCore) {
    const yesterday = addDays(todayStr(), -1);
    const draft = core.study.draft({
      title: '调整测试计划',
      daily_minutes: 120,
      start_date: yesterday,
      knowledge_points: [
        { key: 'vec', name: '向量', est_minutes: 60, outcome: '解释线性组合' },
        { key: 'mat', name: '矩阵', est_minutes: 60, outcome: '手算乘法' },
      ],
    });
    const { plan } = core.study.confirmDraft(draft.id);
    const vecItem = plan.items.find((i) => i.knowledge_key === 'vec')!;
    const matItem = plan.items.find((i) => i.knowledge_key === 'mat')!;
    // 向量（昨天）已完成且自评薄弱；矩阵（今天）未做
    core.plans.updateItemStatus(vecItem.id, 'done');
    const session = core.study.recordSession({ id: 'sess-adj-1', plan_item_id: vecItem.id, plan_id: plan.id, knowledge_key: 'vec', actual_minutes: 30, explanation: '……' });
    core.study.recordAssessment({ session_id: session.id, knowledge_key: 'vec', question: '解释线性组合', answer: '……', source: 'self', score: 40 });
    return { plan, vecItem, matItem };
  }

  it('suggest 是纯预览：不写库、不改条目与待办；依据引用真实证据', () => {
    const { core } = mkCore();
    const { plan, matItem } = setup(core);
    const before = JSON.stringify(core.plans.get(plan.id));
    const todoBefore = JSON.stringify(core.todos.list({ status: 'all' }));

    const suggestions = core.study.suggestAdjustments(plan.id);
    const reschedule = suggestions.find((s) => s.kind === 'reschedule');
    const review = suggestions.find((s) => s.kind === 'add_review');
    expect(reschedule?.item_id).toBe(matItem.id); // 漏做的矩阵条目
    expect(reschedule?.to_date).toBe(todayStr());
    expect(reschedule?.reason).toContain('漏做');
    expect(review?.knowledge_key).toBe('vec'); // 薄弱知识点
    expect(review?.reason).toContain('自评 40');

    // 无副作用
    expect(JSON.stringify(core.plans.get(plan.id))).toBe(before);
    expect(JSON.stringify(core.todos.list({ status: 'all' }))).toBe(todoBefore);
    expect(core.study.suggestAdjustments(plan.id)).toHaveLength(2);
  });

  it('apply：改期同步待办截止日并扩展计划边界；已完成条目绝不被调整', () => {
    const { core } = mkCore();
    const { plan, vecItem, matItem } = setup(core);
    const suggestions = core.study.suggestAdjustments(plan.id);
    const reschedule = suggestions.find((s) => s.kind === 'reschedule')!;
    const result = core.study.applyAdjustments(plan.id, [{ id: reschedule.id, to_date: reschedule.to_date }]);

    expect(result.applied).toHaveLength(1);
    expect(result.todos_synced).toBe(1);
    const matAfter = core.plans.getItem(matItem.id);
    expect(matAfter.date).toBe(todayStr());
    if (matAfter.todo_id != null) {
      expect(core.todos.list({ status: 'all' }).find((t) => t.id === matAfter.todo_id)?.due_date).toBe(todayStr());
    }
    // 已完成的向量条目原封不动
    const vecAfter = core.plans.getItem(vecItem.id);
    expect(vecAfter.status).toBe('done');
    expect(vecAfter.date).toBe(addDays(todayStr(), -1));

    // 应用后建议消失（未完成项已无漏做）
    const remaining = core.study.suggestAdjustments(plan.id);
    expect(remaining.find((s) => s.id === reschedule.id)).toBeUndefined();

    // 过期建议（快照日期或状态已变）：跳过并说明，不静默执行新日期
    const stale = core.study.applyAdjustments(plan.id, [{ id: reschedule.id, to_date: reschedule.to_date }]);
    expect(stale.applied).toHaveLength(0);
    expect(stale.skipped[0].reason).toContain('不存在或已失效');
    // 空选择直接拒绝
    expect(() => core.study.applyAdjustments(plan.id, [])).toThrow('selection 不能为空');
  });

  it('add_review 建议应用后：新增复习条目与待办，写入审计记录；取消（不调用）无副作用', () => {
    const { core } = mkCore();
    const { plan } = setup(core);
    const review = core.study.suggestAdjustments(plan.id).find((s) => s.kind === 'add_review')!;
    const before = { items: core.plans.get(plan.id).items.length, todos: core.todos.list({ status: 'all' }).length };

    const result = core.study.applyAdjustments(plan.id, [{ id: review.id, to_date: review.to_date }]);
    expect(result.applied).toHaveLength(1);
    const after = core.plans.get(plan.id);
    expect(after.items).toHaveLength(before.items + 1);
    const added = after.items.find((i) => i.item_type === 'review' && i.knowledge_key === 'vec')!;
    expect(added.date).toBe(addDays(todayStr(), 1));
    expect(added.todo_id).not.toBeNull();
    expect(core.todos.list({ status: 'all' })).toHaveLength(before.todos + 1);
    // 同一建议再次应用：薄弱复习已存在 → 不再重复建议
    expect(core.study.suggestAdjustments(plan.id).find((s) => s.id === review.id)).toBeUndefined();
  });
});

describe('Obsidian 待审卡片：预览不落盘、导出防重、保护用户编辑', () => {
  function mkSession(core: TodoDeskCore) {
    const draft = core.study.draft({ title: '卡片计划', daily_minutes: 60, start_date: todayStr(), knowledge_points: [{ key: 'vec', name: '向量', outcome: '解释线性组合' }] });
    const { plan } = core.study.confirmDraft(draft.id);
    const item = plan.items[0];
    const session = core.study.recordSession({
      id: 'sess-card-1',
      plan_item_id: item.id,
      plan_id: plan.id,
      knowledge_key: 'vec',
      topic: '向量与线性组合',
      actual_minutes: 35,
      explanation: '向量是有序数组，线性组合是缩放再相加',
      questions: '零向量算线性组合吗？',
      material_source: '《线性代数及其应用》1.1',
    });
    core.study.recordAssessment({ session_id: session.id, knowledge_key: 'vec', question: '解释线性组合', answer: session.explanation, source: 'self', score: 75, feedback: '缺例子', evidence: '与教材定义比对' });
    return session;
  }

  it('预览：生成 draft/未核实标记的 markdown，不写任何文件；重复预览稳定', () => {
    const { core, dir } = mkPersistentCore();
    const session = mkSession(core);
    const cards = core.study.previewCards({ session_ids: [session.id] });
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.file_name).toBe('TD-vec-sess-card-1.md');
    expect(card.markdown).toContain('status: draft');
    expect(card.markdown).toContain('verified: false');
    expect(card.markdown).toContain('session_id: "sess-card-1"');
    expect(card.markdown).toContain('assessed: "self:75"');
    expect(card.markdown).toContain('未经核实');
    expect(card.markdown).toContain('材料');
    // 预览不落盘：反复预览不产生任何文件（目录不存在）
    const neverDir = join(dir, 'never-created');
    void core.study.previewCards({ session_ids: [session.id] });
    void core.study.previewCards({ session_ids: [session.id] });
    expect(existsSync(neverDir)).toBe(false);
    // 重复预览内容稳定（文件名与内容一致）
    expect(core.study.previewCards({ session_ids: [session.id] })[0].markdown).toBe(card.markdown);
  });

  it('导出：写入文件；重复导出内容一致 → skipped；用户编辑后 → protected 不覆盖', () => {
    const { core, reopen, dir } = mkPersistentCore();
    const session = mkSession(core);
    const exportDir = join(dir, 'obsidian-out');

    const first = core.study.exportCards({ session_ids: [session.id] }, exportDir);
    expect(first.exported).toBe(1);
    const card = core.study.previewCards({ session_ids: [session.id] })[0];
    const filePath = join(exportDir, card.file_name);
    expect(readFileSync(filePath, 'utf8')).toBe(card.markdown);

    // 幂等：内容未变再导出 → skipped_identical
    const second = core.study.exportCards({ session_ids: [session.id] }, exportDir);
    expect(second.skipped).toBe(1);
    expect(second.exported).toBe(0);

    // 用户在 Obsidian 里编辑了卡片 → 绝不覆盖
    writeFileSync(filePath, card.markdown.replace('# 向量与线性组合', '# 向量与线性组合（我改过）'), 'utf8');
    const third = core.study.exportCards({ session_ids: [session.id] }, exportDir);
    expect(third.protected).toBe(1);
    expect(readFileSync(filePath, 'utf8')).toContain('我改过');

    // 会话更新（补充解释）后再导出：文件被人工改过 → 仍保护
    core.study.recordSession({ id: session.id, plan_item_id: session.plan_item_id ?? undefined, knowledge_key: 'vec', actual_minutes: 45, explanation: '补充：基向量视角' });
    const fourth = core.study.exportCards({ session_ids: [session.id] }, exportDir);
    expect(fourth.protected).toBe(1);

    // 但如果文件与上次导出记录一致且源更新了（文件没人动过）：允许重新导出
    const exportDir2 = join(dir, 'obsidian-out-2');
    core.study.exportCards({ session_ids: [session.id] }, exportDir2); // 干净目录
    core.study.recordSession({ id: session.id, plan_item_id: session.plan_item_id ?? undefined, knowledge_key: 'vec', actual_minutes: 50, explanation: '再补充：列空间' });
    const updated = core.study.exportCards({ session_ids: [session.id] }, exportDir2);
    expect(updated.exported).toBe(1);
    expect(readFileSync(join(exportDir2, card.file_name), 'utf8')).toContain('列空间');

    // 重启后导出记录仍在，防重继续生效
    const core2 = reopen();
    const after = core2.study.exportCards({ session_ids: [session.id] }, exportDir2);
    expect(after.skipped).toBe(1);
  });

  it('取消语义：只预览不调用 export → 目录始终不存在（无任何文件副作用）', () => {
    const { core, dir } = mkPersistentCore();
    const session = mkSession(core);
    void core.study.previewCards({ session_ids: [session.id] });
    const never = join(dir, 'never-created');
    expect(existsSync(never)).toBe(false);
    expect(core.study.listCardExports()).toHaveLength(0);
  });
});
