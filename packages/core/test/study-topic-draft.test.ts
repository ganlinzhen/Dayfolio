// 无日期学习专题草案（v9 dateless_drafts）单测：创建零副作用（不排日程/不产待办/不占预算）、
// 样课课程关联、内容更新边界、排期预览（预算冲突/知识点重复/依赖拓扑，纯只读）、
// 排期提交（事务+同参数幂等/重排/状态拒绝）、未排期确认防御、dated 草案行为回归、
// v8 一致性副本升级兼容（绝不触碰真实库：全部临时目录）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openNodeSqliteDb } from '../src/adapters/node-sqlite';
import { initDb } from '../src/db';
import { MIGRATIONS } from '../src/migrations';
import { createCore, type TodoDeskCore } from '../src/index';
import { mkCore } from './helpers';

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((f) => f());
});

const POINTS = [
  { key: 'rust-basics', name: 'Rust 基础概念', est_minutes: 60, outcome: '能说清 Rust 的定位与典型用法' },
  { key: 'rust-advanced', name: 'Rust 进阶实践', est_minutes: 90, outcome: '能独立完成一次进阶操作', depends_on: ['rust-basics'] },
];

describe('无日期专题草案：创建零副作用', () => {
  it('创建：start/end/daily 为空、items 为空、不产计划/待办/今日安排', () => {
    const { core } = mkCore();
    const before = { plans: core.plans.list().length, todos: core.todos.list().length };
    const draft = core.study.draftDateless({
      title: 'Rust 专题：基础到进阶',
      goal: '掌握 Rust 全链路',
      material_source: '六份 Rust 专题文稿',
      knowledge_points: POINTS,
      notes: '日期待排期、未确认',
    });
    expect(draft.status).toBe('draft');
    expect(draft.start_date).toBeNull();
    expect(draft.end_date).toBeNull();
    expect(draft.daily_minutes).toBeNull();
    expect(draft.items).toEqual([]);
    expect(draft.knowledge_points.map((k) => k.key)).toEqual(['rust-basics', 'rust-advanced']);
    // 零副作用：无计划、无待办、今日面板无该草案条目
    expect(core.plans.list()).toHaveLength(before.plans);
    expect(core.todos.list()).toHaveLength(before.todos);
    expect(core.today.getToday('2026-10-12').today_plan_items).toHaveLength(0);
    // assumptions 首条即「未排期」提示，且完整信息不额外造假设
    expect(draft.assumptions[0]).toContain('未排期');
    expect(draft.assumptions).toHaveLength(1);
    expect(draft.course_id).toBeNull();
  });

  it('校验：知识点为空/依赖环/未知依赖/课程不存在在创建时即报错', () => {
    const { core } = mkCore();
    expect(() => core.study.draftDateless({ title: '空', knowledge_points: [] })).toThrow('knowledge_points 不能为空');
    expect(() =>
      core.study.draftDateless({
        title: '环',
        knowledge_points: [
          { key: 'a', name: 'A', depends_on: ['b'] },
          { key: 'b', name: 'B', depends_on: ['a'] },
        ],
      }),
    ).toThrow('依赖存在环');
    expect(() =>
      core.study.draftDateless({
        title: '缺依赖',
        knowledge_points: [{ key: 'a', name: 'A', depends_on: ['ghost'] }],
      }),
    ).toThrow('不在知识点清单中');
    expect(() =>
      core.study.draftDateless({ title: '坏课程', knowledge_points: POINTS, course_id: 999 }),
    ).toThrow('关联课程 999 不存在');
  });

  it('样课课程关联：样课未确认（imported）也可关联，仅信息性记录不动课程绑定', () => {
    const { core, dbPath } = mkCore();
    const stage = mkdtempSync(join(tmpdir(), 'td-topic-course-'));
    cleanups.push(() => rmSync(stage, { recursive: true, force: true }));
    mkdirSync(join(stage, 'lessons'), { recursive: true });
    writeFileSync(join(stage, 'lessons', 'd1.html'), '<h1>Rust 样课</h1><p>正文</p>');
    writeFileSync(
      join(stage, 'course.json'),
      JSON.stringify({
        slug: 'rust-topic',
        title: 'Rust 专题课',
        version: '1.0.0',
        lessons: [{ day: 1, title: '第一天', html: 'lessons/d1.html', is_sample: true }],
      }),
    );
    const imported = core.courses.importCourse(stage);
    expect(imported.course.status).toBe('imported'); // 样课尚未确认

    const draft = core.study.draftDateless({ title: 'Rust 专题', knowledge_points: POINTS, course_id: imported.course.id });
    expect(draft.course_id).toBe(imported.course.id);
    // 课程绑定不被草案触碰：plan_id 仍为空
    expect(core.courses.getCourse(imported.course.id).plan_id).toBeNull();
    expect(dbPath).toContain('tododesk-test-'); // 隔离断言：临时库
  });
});

describe('无日期专题草案：内容更新', () => {
  it('未排期可改大纲/材料/课程关联；知识点整体替换重新校验', () => {
    const { core } = mkCore();
    const draft = core.study.draftDateless({ title: '旧标题', knowledge_points: POINTS });
    const updated = core.study.updateDraftMeta(draft.id, {
      title: '新标题',
      material_source: '新文稿',
      course_id: null,
      knowledge_points: [{ key: 'x', name: 'X', est_minutes: 30 }],
    });
    expect(updated.title).toBe('新标题');
    expect(updated.material_source).toBe('新文稿');
    expect(updated.knowledge_points.map((k) => k.key)).toEqual(['x']);
    // 再换回带环的清单仍要报错
    expect(() =>
      core.study.updateDraftMeta(draft.id, {
        knowledge_points: [
          { key: 'a', name: 'A', depends_on: ['b'] },
          { key: 'b', name: 'B', depends_on: ['a'] },
        ],
      }),
    ).toThrow('依赖存在环');
  });

  it('排期后内容锁定；确认/取消后拒绝编辑', () => {
    const { core } = mkCore();
    const draft = core.study.draftDateless({ title: 'T', knowledge_points: POINTS });
    core.study.scheduleDraft(draft.id, '2026-10-12', 120);
    expect(() => core.study.updateDraftMeta(draft.id, { title: '改' })).toThrow('内容锁定');
    const confirmed = core.study.confirmDraft(core.study.scheduleDraft(draft.id, '2026-10-12', 120).id);
    expect(() => core.study.updateDraftMeta(confirmed.draft.id, { title: '改' })).toThrow('已确认');

    const other = core.study.draftDateless({ title: 'T2', knowledge_points: POINTS });
    core.study.cancelDraft(other.id);
    expect(() => core.study.updateDraftMeta(other.id, { title: '改' })).toThrow('已取消');
  });
});

describe('排期预览：纯只读，冲突与依赖', () => {
  it('干净库：无冲突无预警，返回逐日安排与拓扑序，不写库', () => {
    const { core } = mkCore();
    const draft = core.study.draftDateless({ title: 'T', knowledge_points: POINTS });
    const preview = core.study.previewDraftSchedule(draft.id, '2026-10-12', 120);
    expect(preview.start_date).toBe('2026-10-12');
    expect(preview.end_date).toBe('2026-10-13'); // 60 + 90 > 120 分两天
    expect(preview.items.map((i) => i.knowledge_key)).toEqual(['rust-basics', 'rust-advanced']);
    expect(preview.ordered_keys).toEqual(['rust-basics', 'rust-advanced']);
    expect(preview.dependency_chains.find((c) => c.key === 'rust-advanced')?.depends_on).toEqual(['rust-basics']);
    expect(preview.conflicts).toEqual([]);
    expect(preview.duplicate_knowledge_keys).toEqual([]);
    expect(preview.warnings).toEqual([]);
    // 只读：草案仍未排期
    const after = core.study.getDraft(draft.id);
    expect(after.start_date).toBeNull();
    expect(after.items).toEqual([]);
  });

  it('预算冲突与知识点重复：与进行中计划同日叠加、同 key 未完成条目都会预警', () => {
    const { core } = mkCore();
    // 既有 active 计划：10-12 已排 90 分钟，且含同 key 'rust-basics' 的未完成条目
    core.plans.create({
      title: '既有计划',
      start_date: '2026-10-12',
      items: [{ date: '2026-10-12', content: '既有安排', duration_min: 90, knowledge_key: 'rust-basics' }],
      daily_minutes: 120,
    });
    const draft = core.study.draftDateless({ title: 'T', knowledge_points: POINTS });
    const preview = core.study.previewDraftSchedule(draft.id, '2026-10-12', 120);
    const firstDay = preview.conflicts.find((c) => c.date === '2026-10-12')!;
    expect(firstDay).toMatchObject({ existing_minutes: 90, new_minutes: 60, daily_minutes: 120, over_budget: true });
    expect(preview.conflicts.find((c) => c.date === '2026-10-13')?.existing_minutes ?? 0).toBe(0);
    expect(preview.duplicate_knowledge_keys).toEqual([
      { knowledge_key: 'rust-basics', plan_id: expect.any(Number), plan_title: '既有计划' },
    ]);
    expect(preview.warnings.join('\n')).toContain('预算冲突');
    expect(preview.warnings.join('\n')).toContain('知识点重复');
  });

  it('参数非法与状态拒绝：预算越界/坏日期/已确认/已取消', () => {
    const { core } = mkCore();
    const draft = core.study.draftDateless({ title: 'T', knowledge_points: POINTS });
    expect(() => core.study.previewDraftSchedule(draft.id, '2026-10-12', 5)).toThrow('10~600');
    expect(() => core.study.previewDraftSchedule(draft.id, 'not-a-date', 60)).toThrow();
    core.study.cancelDraft(draft.id);
    expect(() => core.study.previewDraftSchedule(draft.id, '2026-10-12', 60)).toThrow('已取消');
  });
});

describe('排期提交：事务 + 幂等', () => {
  it('成功落库；同参数重复提交幂等（不重算不改 updated_at）；换参数重排', () => {
    const { core } = mkCore();
    const draft = core.study.draftDateless({ title: 'T', knowledge_points: POINTS });
    const scheduled = core.study.scheduleDraft(draft.id, '2026-10-12', 120);
    expect(scheduled.start_date).toBe('2026-10-12');
    expect(scheduled.end_date).toBe('2026-10-13');
    expect(scheduled.daily_minutes).toBe(120);
    expect(scheduled.items.map((i) => i.date)).toEqual(['2026-10-12', '2026-10-13']);
    // 幂等：同参数重复提交返回原样，updated_at 不动
    const again = core.study.scheduleDraft(draft.id, '2026-10-12', 120);
    expect(again).toEqual(scheduled);
    expect(again.updated_at).toBe(scheduled.updated_at);
    expect(core.study.listDrafts('draft')).toHaveLength(1);
    // 重排：换起始日期/预算覆盖原安排（60+90=150 ≤ 180，两个条目同日）
    const rescheduled = core.study.scheduleDraft(draft.id, '2026-11-01', 180);
    expect(rescheduled.start_date).toBe('2026-11-01');
    expect(rescheduled.items.map((i) => i.date)).toEqual(['2026-11-01', '2026-11-01']);
  });

  it('排期后走确认门禁：未排期拒绝确认，排期后确认生成计划与待办且幂等', () => {
    const { core } = mkCore();
    const draft = core.study.draftDateless({ title: 'T', knowledge_points: POINTS });
    expect(() => core.study.confirmDraft(draft.id)).toThrow('尚未排期');
    expect(core.plans.list()).toHaveLength(0);

    core.study.scheduleDraft(draft.id, '2026-10-12', 120);
    const { plan } = core.study.confirmDraft(draft.id);
    expect(plan.items).toHaveLength(2);
    expect(core.todos.list().filter((t) => t.source === 'plan')).toHaveLength(2);
    // 幂等确认：重复确认返回原计划
    const again = core.study.confirmDraft(draft.id);
    expect(again.plan.id).toBe(plan.id);
    expect(core.plans.list()).toHaveLength(1);
    // 确认后拒绝再排期
    expect(() => core.study.scheduleDraft(draft.id, '2026-12-01', 60)).toThrow('已确认为计划');
  });
});

describe('dated 草案行为回归（旧路径不受影响）', () => {
  it('draft() 仍强制日期与预算；产物与确认流程不变', () => {
    const { core } = mkCore();
    expect(() =>
      core.study.draft({ title: 'T', daily_minutes: 5, start_date: '2026-10-12', knowledge_points: POINTS }),
    ).toThrow('10~600');
    const dated = core.study.draft({ title: 'T', daily_minutes: 120, start_date: '2026-10-12', knowledge_points: POINTS });
    expect(dated.start_date).toBe('2026-10-12');
    expect(dated.items.length).toBeGreaterThan(0);
    const { plan } = core.study.confirmDraft(dated.id);
    expect(plan.items).toHaveLength(2);
  });
});

describe('预算冲突硬校验（服务层强制，UI 预览不可替代）', () => {
  /** 干净区间里的既有占用计划：D0 当天排 90 分钟（另一个 active 计划） */
  const mkOccupier = (core: TodoDeskCore, date: string) =>
    core.plans.create({
      title: '既有占用计划',
      start_date: date,
      items: [{ date, content: '既有安排', duration_min: 90, knowledge_key: 'occupier-kp' }],
      daily_minutes: 120,
    });

  it('排期：有冲突不带确认集拒绝；带过期/多余确认集拒绝；带精确一致确认集放行', () => {
    const { core } = mkCore();
    const D0 = '2026-12-01';
    const draft = core.study.draftDateless({ title: 'T', knowledge_points: POINTS });
    const prev = core.study.previewDraftSchedule(draft.id, D0, 120);
    expect(prev.over_budget_dates).toEqual([]); // 预览时无冲突

    // 模拟并发变动：预览之后、提交之前其他进程加了占用计划
    mkOccupier(core, D0);
    // 1) 不带确认集 → 拒绝（服务层硬校验，绕过 UI 直接调服务也不行）
    expect(() => core.study.scheduleDraft(draft.id, D0, 120)).toThrow('预算冲突硬校验失败');
    // 2) 带过期确认集（预览时的空集）→ 拒绝
    expect(() => core.study.scheduleDraft(draft.id, D0, 120, { confirmed_over_dates: prev.over_budget_dates })).toThrow('硬校验失败');
    // 3) 重新预览拿最新集 → 原样传回 → 放行，且落库 conflict_checked_at 非空
    const fresh = core.study.previewDraftSchedule(draft.id, D0, 120);
    expect(fresh.over_budget_dates).toEqual([D0]);
    const scheduled = core.study.scheduleDraft(draft.id, D0, 120, { confirmed_over_dates: fresh.over_budget_dates });
    expect(scheduled.start_date).toBe(D0);
    expect(scheduled.conflict_checked_at).not.toBeNull();
    // 4) 冲突消失后仍带旧集 → 拒绝（集合必须精确一致）
    const occ = mkOccupier(core, D0);
    core.plans.update(occ.id, { status: 'archived' }); // 归档占用计划，冲突消失
    expect(() =>
      core.study.scheduleDraft(draft.id, '2026-12-02', 120, { confirmed_over_dates: [D0] }),
    ).toThrow('当前已无超预算冲突');
  });

  it('排期无冲突时多带确认集也拒绝（空集必须精确）', () => {
    const { core } = mkCore();
    const draft = core.study.draftDateless({ title: 'T', knowledge_points: POINTS });
    expect(() => core.study.scheduleDraft(draft.id, '2026-12-01', 120, { confirmed_over_dates: ['2026-12-01'] })).toThrow('硬校验失败');
  });

  it('确认边界：排期后既有计划变动引入冲突 → 不带集拒绝；带当下重算集通过；幂等分支不受影响', () => {
    const { core } = mkCore();
    const D0 = '2026-12-01';
    const draft = core.study.draftDateless({ title: 'T', knowledge_points: POINTS });
    core.study.scheduleDraft(draft.id, D0, 120); // 干净区间排期，无冲突
    // 模拟排期后、确认前的并发变动
    mkOccupier(core, D0);
    expect(() => core.study.confirmDraft(draft.id)).toThrow('预算冲突硬校验失败');
    // 带当下重算集 → 通过（复检同样以该集为准）
    const overNow = core.study.previewDraftSchedule(draft.id, D0, 120).over_budget_dates;
    expect(overNow).toEqual([D0]);
    const { plan } = core.study.confirmDraft(draft.id, { confirmed_over_dates: overNow });
    expect(plan.items).toHaveLength(2);
    // 幂等优先：确认之后再有冲突计划，重复确认仍返回原计划
    mkOccupier(core, '2026-12-02');
    const again = core.study.confirmDraft(draft.id);
    expect(again.plan.id).toBe(plan.id);
    expect(core.plans.list()).toHaveLength(3); // 无重复创建
  });

  it('旧路径豁免（明确限定）：draft() 创建即排期的草案，同日有占用计划也能确认（历史行为保持）', () => {
    const { core } = mkCore();
    const D0 = '2026-12-01';
    mkOccupier(core, D0); // 同日既有占用
    const dated = core.study.draft({ title: '旧路径草案', daily_minutes: 120, start_date: D0, knowledge_points: POINTS });
    expect(dated.conflict_checked_at).toBeNull(); // 未走排期提交，无硬校验标记
    const { plan } = core.study.confirmDraft(dated.id); // 不设冲突门，直接通过
    expect(plan.items).toHaveLength(2);
  });

  it('确认复检整体回退：建计划期间的并发占用使草案恢复未确认、计划与待办删除', () => {
    const { core } = mkCore();
    const D0 = '2026-12-01';
    const draft = core.study.draftDateless({ title: 'T', knowledge_points: POINTS });
    core.study.scheduleDraft(draft.id, D0, 120); // 干净区间，预检时无冲突

    // 模拟跨进程竞态：预检通过后、建计划期间其他进程写入同日占用——
    // 对 study 服务共享的 plans 对象打一次性补丁，在 create 返回后、复检前落库占用计划
    const plansObj = core.plans as unknown as { create: (input: never) => { id: number } };
    const originalCreate = plansObj.create.bind(core.plans);
    plansObj.create = (input) => {
      const plan = originalCreate(input);
      plansObj.create = originalCreate; // 先还原，避免占用计划创建递归触发补丁
      mkOccupier(core, D0);
      return plan;
    };
    const todosBeforeConfirm = core.todos.list().length;
    expect(() => core.study.confirmDraft(draft.id, { confirmed_over_dates: [] })).toThrow('硬校验失败');
    plansObj.create = originalCreate; // 兜底还原

    // 草案恢复未确认且无关联计划；本次生成的计划与其待办已删净（占用计划自身的待办保留）
    const d = core.study.getDraft(draft.id);
    expect(d.status).toBe('draft');
    expect(d.plan_id).toBeNull();
    expect(core.plans.list().filter((p) => p.title === 'T')).toHaveLength(0);
    expect(core.todos.list()).toHaveLength(todosBeforeConfirm + 1); // 仅多出占用计划自己的 1 条待办
    // 占用计划确实存在（模拟的并发写入保留），换最新确认集重试即可通过
    const overNow = core.study.previewDraftSchedule(draft.id, D0, 120).over_budget_dates;
    const { plan } = core.study.confirmDraft(draft.id, { confirmed_over_dates: overNow });
    expect(plan.items).toHaveLength(2);
  });
});

describe('合成 v8 夹具：一般兼容性回归（结构性验证，非真实数据副本验收）', () => {
  it('合成 v8 库（dated 草案 NOT NULL 结构）打开即迁 v9：存量草案原值保留且可确认，新无日期草案可用', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tododesk-v8-copy-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, 'v8.db');

    // 构造合成 v8 结构副本：同一份迁移代码跑到 v8 为止（只覆盖一般兼容性；
    // 真实 v8 数据副本的升级验收见 drafts-upgrade-real-v8.test.ts，二者不得混称）
    const db = openNodeSqliteDb(dbPath);
    initDb(db);
    for (const m of MIGRATIONS.filter((x) => x.version <= 8)) {
      db.exec('BEGIN IMMEDIATE');
      m.up(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    }
    // v8 断言：start_date 仍是 NOT NULL
    const cols = db.prepare('PRAGMA table_info(study_plan_drafts)').all() as Array<{ name: string; notnull: number }>;
    expect(cols.find((c) => c.name === 'start_date')?.notnull).toBe(1);
    expect(cols.some((c) => c.name === 'course_id')).toBe(false);
    // 存量 dated 草案（结构上等价于 agent 旧流程产物）
    db.prepare(
      `INSERT INTO study_plan_drafts
       (title, goal, material_source, daily_minutes, start_date, end_date, knowledge_points, items, assumptions, status, plan_id, notes, created_at, updated_at)
       VALUES ('旧草案', '', '', 120, '2026-10-10', '2026-10-11', '[]', ?, '[]', 'draft', NULL, '', '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z')`,
    ).run(
      JSON.stringify([
        { date: '2026-10-10', content: '旧条目A', item_type: 'learn', duration_min: 60, knowledge_key: 'old-a' },
        { date: '2026-10-11', content: '旧条目B', item_type: 'learn', duration_min: 60, knowledge_key: 'old-b' },
      ]),
    );
    db.close();

    // 重新打开 = 正常启动路径：v9 及后续迁移自动执行
    const core: TodoDeskCore = createCore(openNodeSqliteDb(dbPath), { dbPath });
    expect(Number((core.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)).toBe(MIGRATIONS.length);
    // v9 断言：三列已可空，course_id 已加
    const cols9 = core.db.prepare('PRAGMA table_info(study_plan_drafts)').all() as Array<{ name: string; notnull: number }>;
    expect(cols9.find((c) => c.name === 'start_date')?.notnull).toBe(0);
    expect(cols9.find((c) => c.name === 'daily_minutes')?.notnull).toBe(0);
    expect(cols9.find((c) => c.name === 'course_id')).toBeDefined();
    // 存量草案字段原值保留，行为不变：仍可确认生成计划
    const old = core.study.listDrafts().find((d) => d.title === '旧草案')!;
    expect(old.start_date).toBe('2026-10-10');
    expect(old.daily_minutes).toBe(120);
    expect(old.items).toHaveLength(2);
    const { plan } = core.study.confirmDraft(old.id);
    expect(plan.items).toHaveLength(2);
    // 升级后即可创建无日期草案；排期/确认按当下库状态取预览确认集（对任意既有数据稳健）
    const fresh = core.study.draftDateless({ title: '新无日期', knowledge_points: POINTS });
    const prev = core.study.previewDraftSchedule(fresh.id, '2026-10-12', 120);
    expect(core.study.scheduleDraft(fresh.id, '2026-10-12', 120, { confirmed_over_dates: prev.over_budget_dates }).items).toHaveLength(2);
    const rePrev = core.study.previewDraftSchedule(fresh.id, '2026-10-12', 120);
    const { plan: freshPlan } = core.study.confirmDraft(fresh.id, { confirmed_over_dates: rePrev.over_budget_dates });
    expect(freshPlan.items).toHaveLength(2);
  });
});
