// 学习闭环 v1 服务：计划草案（预览→确认/取消；含无日期专题草案：排期预览→事务排期）、
// 学习会话（幂等多次尝试）、测评证据（自评/客观/AI建议，可纠正）、掌握度（与完成率分离）、
// 未完成项调整建议（纯预览→显式应用）、Obsidian 待审卡片（预览→导出防重）。
//
// 设计原则（与 apps/help/docs/09-study-loop.md 规范同源，改动须两处同步）：
// 1. Dayfolio 只做透明规则（拓扑排序 + 每日预算装箱），学习内容由 agent 分解提供，
//    缺失信息记录进 assumptions，绝不编造知识点或评分；
// 2. 不调用运行时模型 API；objective 测评必须携带真实判题依据，否则拒绝入库；
// 3. 预览类操作（草案、调整建议、卡片）不产生计划/待办/打卡/文件等副作用；
// 4. 写操作幂等：同一稳定 ID（或 scope+attempt）重复提交只更新不重复创建。
import { createHash } from 'node:crypto';
import { getStudyProgress } from './study-progress';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DbAdapter } from '../db';
import { assertDirOutsideVaults } from './vault';
import { inTx } from '../db';
import type {
  AdjustmentApplyResult,
  AdjustmentSuggestion,
  AssessmentSource,
  CardExportResult,
  CardExportOutcome,
  DraftConflictConfirm,
  DraftKnowledgeDuplicate,
  DraftScheduleConflict,
  DraftSchedulePreview,
  MasteryEntry,
  MasteryReport,
  MasteryStatus,
  PlanDetail,
  PlanItem,
  StudyAssessment,
  StudyAssessmentInput,
  StudyCard,
  StudyDraft,
  StudyDraftInput,
  StudyDraftItem,
  StudyDraftStatus,
  StudyKnowledgePoint,
  StudySession,
  StudySessionInput,
  StudyTopicDraftInput,
  StudyTopicDraftPatch,
} from '../types';
import { addDays, ensureValidDateStr, nowIso, todayStr } from '../utils/date';
import type { PlanService } from './plan';
import type { TodoService } from './todo';

// ---------- 透明规则常量（规范文档与测试共同引用） ----------

/** 知识点缺省预计时长（分钟） */
export const DEFAULT_KNOWLEDGE_POINT_MINUTES = 60;
/** 旧计划（无每日预算字段）调整时使用的缺省预算（分钟） */
export const DEFAULT_PLAN_DAILY_MINUTES = 120;
/** 自评 ≥80 分视为掌握良好 */
export const MASTERY_SELF_STRONG = 80;
/** 自评 <60 分视为薄弱 */
export const MASTERY_SELF_WEAK = 60;
/** 自动追加复习条目的时长（分钟） */
export const ADJUST_REVIEW_MINUTES = 20;
/** 会话归属日允许补记的最远过去天数 */
export const MAX_SESSION_BACKFILL_DAYS = 366;

// ---------- 行映射 ----------

function parseJsonArray<T>(raw: unknown): T[] {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function mapDraft(row: Record<string, unknown>): StudyDraft {
  return {
    id: Number(row.id),
    title: String(row.title),
    goal: String(row.goal ?? ''),
    material_source: String(row.material_source ?? ''),
    daily_minutes: row.daily_minutes === null || row.daily_minutes === undefined ? null : Number(row.daily_minutes),
    start_date: (row.start_date as string | null) ?? null,
    end_date: (row.end_date as string | null) ?? null,
    knowledge_points: parseJsonArray<StudyKnowledgePoint>(row.knowledge_points),
    items: parseJsonArray<StudyDraftItem>(row.items),
    assumptions: parseJsonArray<string>(row.assumptions),
    status: row.status as StudyDraftStatus,
    plan_id: row.plan_id === null || row.plan_id === undefined ? null : Number(row.plan_id),
    course_id: row.course_id === null || row.course_id === undefined ? null : Number(row.course_id),
    conflict_checked_at: (row.conflict_checked_at as string | null) ?? null,
    notes: String(row.notes ?? ''),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    confirmed_at: (row.confirmed_at as string | null) ?? null,
    cancelled_at: (row.cancelled_at as string | null) ?? null,
  };
}

function mapSession(row: Record<string, unknown>): StudySession {
  return {
    id: String(row.id),
    plan_id: row.plan_id === null || row.plan_id === undefined ? null : Number(row.plan_id),
    plan_item_id: row.plan_item_id === null || row.plan_item_id === undefined ? null : Number(row.plan_item_id),
    scope_key: String(row.scope_key),
    knowledge_key: String(row.knowledge_key),
    topic: String(row.topic),
    attempt: Number(row.attempt),
    date: String(row.date),
    actual_minutes: Number(row.actual_minutes),
    explanation: String(row.explanation ?? ''),
    questions: String(row.questions ?? ''),
    material_source: String(row.material_source ?? ''),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapAssessment(row: Record<string, unknown>): StudyAssessment {
  return {
    id: String(row.id),
    session_id: (row.session_id as string | null) ?? null,
    plan_id: row.plan_id === null || row.plan_id === undefined ? null : Number(row.plan_id),
    plan_item_id: row.plan_item_id === null || row.plan_item_id === undefined ? null : Number(row.plan_item_id),
    knowledge_key: String(row.knowledge_key),
    topic: String(row.topic),
    question: String(row.question),
    criteria: String(row.criteria ?? ''),
    answer: String(row.answer),
    source: row.source as AssessmentSource,
    score: row.score === null || row.score === undefined ? null : Number(row.score),
    objective_passed: row.objective_passed === null || row.objective_passed === undefined ? null : Number(row.objective_passed) === 1,
    feedback: String(row.feedback ?? ''),
    evidence: String(row.evidence ?? ''),
    corrections: parseJsonArray<StudyAssessment['corrections'][number]>(row.corrections),
    date: String(row.date),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

// ---------- 透明排程（纯函数，可独立测试） ----------

/**
 * 知识点清单校验 + 依赖拓扑排序（不涉及日期）：key/名称/去重/时长校验，依赖存在性与环检测，
 * Kahn 按输入顺序取队首保证稳定。无日期草案创建时即校验（早失败），排程时复用其拓扑序。
 */
export function normalizeKnowledgePoints(
  points: Array<{ key: string; name: string; depends_on?: string[]; est_minutes?: number; outcome?: string }>,
): { ordered: StudyKnowledgePoint[]; assumptions: string[] } {
  const assumptions: string[] = [];
  const byKey = new Map<string, StudyKnowledgePoint>();
  for (const p of points) {
    const key = p.key?.trim();
    const name = p.name?.trim();
    if (!key) throw new Error('知识点 key 不能为空');
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(key)) {
      throw new Error(`知识点 key "${key}" 格式错误：应为小写 slug（字母数字与 . _ -）`);
    }
    if (!name) throw new Error(`知识点 "${key}" 缺少名称（name）`);
    if (byKey.has(key)) throw new Error(`知识点 key 重复："${key}"`);
    const est = p.est_minutes ?? DEFAULT_KNOWLEDGE_POINT_MINUTES;
    if (!Number.isInteger(est) || est <= 0 || est > 600) {
      throw new Error(`知识点 "${key}" 的 est_minutes 必须为 1~600 的整数`);
    }
    if (p.est_minutes === undefined) assumptions.push(`知识点「${name}」未提供预计时长，按缺省 ${DEFAULT_KNOWLEDGE_POINT_MINUTES} 分钟排程`);
    if (!p.outcome?.trim()) assumptions.push(`知识点「${name}」未提供可验证成果，建议补充（学完后如何证明掌握）`);
    byKey.set(key, { key, name, depends_on: p.depends_on?.map((d) => d.trim()).filter(Boolean) ?? [], est_minutes: est, outcome: p.outcome?.trim() ?? '' });
  }
  // 依赖校验 + 拓扑排序（Kahn，按输入顺序取队首保证稳定）
  for (const kp of byKey.values()) {
    for (const dep of kp.depends_on) {
      if (!byKey.has(dep)) throw new Error(`知识点 "${kp.key}" 依赖的 "${dep}" 不在知识点清单中`);
    }
  }
  const ordered: StudyKnowledgePoint[] = [];
  const pending = [...byKey.values()];
  const done = new Set<string>();
  while (pending.length > 0) {
    const idx = pending.findIndex((kp) => kp.depends_on.every((d) => done.has(d)));
    if (idx === -1) {
      throw new Error(`知识点依赖存在环：${pending.map((k) => k.key).join('、')}`);
    }
    const [kp] = pending.splice(idx, 1);
    ordered.push(kp);
    done.add(kp.key);
  }
  return { ordered, assumptions };
}

/**
 * 按透明规则把知识点排成逐日安排：
 * 1. 依赖拓扑排序（保持输入顺序稳定，有环报错）；
 * 2. 从 start_date 起按每日预算装箱：装不下就顺延到下一天；
 * 3. 单个知识点超过全天预算时单独占一天（记入 assumptions）。
 * 缺省的 est_minutes / outcome 逐条记入 assumptions，供用户核对。
 */
export function scheduleKnowledgePoints(
  points: Array<{ key: string; name: string; depends_on?: string[]; est_minutes?: number; outcome?: string }>,
  dailyMinutes: number,
  startDate: string,
): { items: StudyDraftItem[]; assumptions: string[]; ordered: StudyKnowledgePoint[]; endDate: string } {
  const { ordered, assumptions } = normalizeKnowledgePoints(points);

  const items: StudyDraftItem[] = [];
  let date = startDate;
  let used = 0;
  const advanceDay = () => {
    date = addDays(date, 1);
    used = 0;
  };
  for (const kp of ordered) {
    if (kp.est_minutes > dailyMinutes) {
      assumptions.push(`知识点「${kp.name}」预计 ${kp.est_minutes} 分钟超过每日预算 ${dailyMinutes} 分钟，单独占用一天`);
      if (used > 0) advanceDay(); // 当天已有安排则换新的一天，不与既有条目叠加
    } else if (used + kp.est_minutes > dailyMinutes) {
      advanceDay();
    }
    items.push({
      date,
      content: kp.outcome ? `${kp.name}（目标：${kp.outcome}）` : kp.name,
      item_type: 'learn',
      duration_min: kp.est_minutes,
      knowledge_key: kp.key,
    });
    used += kp.est_minutes;
    if (used >= dailyMinutes) advanceDay();
  }
  if (items.length === 0) throw new Error('知识点清单为空，无法排程');
  return { items, assumptions, ordered, endDate: items[items.length - 1].date };
}

// ---------- 服务 ----------

export interface StudyServiceDeps {
  plans: PlanService;
  todos: TodoService;
}

export function createStudyService(db: DbAdapter, deps: StudyServiceDeps) {
  // ===== 计划草案 =====

  /** 生成草案（预览载体）：只写草案表，不创建计划/待办/打卡 */
  const draft = (input: StudyDraftInput): StudyDraft => {
    if (!input.title?.trim()) throw new Error('草案标题不能为空');
    if (!Array.isArray(input.knowledge_points) || input.knowledge_points.length === 0) {
      throw new Error('knowledge_points 不能为空：请先与用户澄清并分解知识点');
    }
    assertDailyMinutes(input.daily_minutes);
    const start = ensureValidDateStr(input.start_date);
    const scheduled = scheduleKnowledgePoints(input.knowledge_points, input.daily_minutes, start);
    const now = nowIso();
    const res = db
      .prepare(
        `INSERT INTO study_plan_drafts
         (title, goal, material_source, daily_minutes, start_date, end_date, knowledge_points, items, assumptions, status, plan_id, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL, ?, ?, ?)`,
      )
      .run(
        input.title.trim(),
        input.goal?.trim() ?? '',
        input.material_source?.trim() ?? '',
        input.daily_minutes,
        start,
        scheduled.endDate,
        JSON.stringify(scheduled.ordered),
        JSON.stringify(scheduled.items),
        JSON.stringify(scheduled.assumptions),
        input.notes?.trim() ?? '',
        now,
        now,
      );
    return getDraft(Number(res.lastInsertRowid));
  };

  // ===== 无日期学习专题草案（日期待排期、未确认：不排日程、不产待办、不占预算） =====

  /** 每日预算共用校验（dated 草案 / 排期提交同规则） */
  const assertDailyMinutes = (v: unknown): number => {
    if (!Number.isInteger(v) || (v as number) < 10 || (v as number) > 600) {
      throw new Error(`每日预算 daily_minutes 必须为 10~600 的整数（分钟），收到 "${v}"`);
    }
    return v as number;
  };

  /**
   * 创建无日期专题草案：只保存主题大纲/知识点/材料与可选的样课课程关联，
   * start/end/daily_minutes 均为 NULL、items 为空——不排日程、不产待办、不占每日预算。
   * 知识点在创建时即完成校验（key 格式/去重/依赖存在性/环检测），但**不排日期**；
   * 待用户给出起始日期与每日预算后走 previewDraftSchedule → scheduleDraft → confirmDraft。
   */
  const draftDateless = (input: StudyTopicDraftInput): StudyDraft => {
    if (!input.title?.trim()) throw new Error('草案标题不能为空');
    if (!Array.isArray(input.knowledge_points) || input.knowledge_points.length === 0) {
      throw new Error('knowledge_points 不能为空：请先与用户澄清并分解知识点');
    }
    if (input.course_id != null) {
      const row = db.prepare('SELECT id FROM courses WHERE id = ?').get(input.course_id);
      if (!row) throw new Error(`关联课程 ${input.course_id} 不存在：请先导入该课程的样课包再关联`);
    }
    const { ordered, assumptions } = normalizeKnowledgePoints(input.knowledge_points);
    const now = nowIso();
    const res = db
      .prepare(
        `INSERT INTO study_plan_drafts
         (title, goal, material_source, daily_minutes, start_date, end_date, knowledge_points, items, assumptions, status, plan_id, course_id, notes, created_at, updated_at)
         VALUES (?, ?, ?, NULL, NULL, NULL, ?, '[]', ?, 'draft', NULL, ?, ?, ?, ?)`,
      )
      .run(
        input.title.trim(),
        input.goal?.trim() ?? '',
        input.material_source?.trim() ?? '',
        JSON.stringify(ordered),
        JSON.stringify(['未排期：等待用户提供起始日期与每日时间预算（preview → schedule → confirm）', ...assumptions]),
        input.course_id ?? null,
        input.notes?.trim() ?? '',
        now,
        now,
      );
    return getDraft(Number(res.lastInsertRowid));
  };

  /** 更新无日期草案内容（大纲/知识点/材料/样课关联）。仅未排期且未确认时可改；已排期后内容锁定，调整走取消重建或计划调整 */
  const updateDraftMeta = (id: number, patch: StudyTopicDraftPatch): StudyDraft => {
    const d = getDraft(id);
    if (d.status === 'confirmed') throw new Error(`草案 ${id} 已确认为计划 ${d.plan_id}，不能再编辑内容`);
    if (d.status === 'cancelled') throw new Error(`草案 ${id} 已取消，不能再编辑内容`);
    if (d.start_date != null) {
      throw new Error(`草案 ${id} 已排期（${d.start_date} 起，每日 ${d.daily_minutes} 分钟），内容锁定不再可改；如需换知识点请取消后重建草案`);
    }
    const next = {
      title: patch.title !== undefined ? patch.title.trim() : d.title,
      goal: patch.goal !== undefined ? (patch.goal?.trim() ?? '') : d.goal,
      material_source: patch.material_source !== undefined ? (patch.material_source?.trim() ?? '') : d.material_source,
      notes: patch.notes !== undefined ? (patch.notes?.trim() ?? '') : d.notes,
      course_id: patch.course_id !== undefined ? patch.course_id : d.course_id,
      knowledge_points: patch.knowledge_points ?? d.knowledge_points,
    };
    if (!next.title) throw new Error('草案标题不能为空');
    if (next.course_id != null) {
      const row = db.prepare('SELECT id FROM courses WHERE id = ?').get(next.course_id);
      if (!row) throw new Error(`关联课程 ${next.course_id} 不存在：请先导入该课程的样课包再关联`);
    }
    // 知识点整体替换时重新校验 + 拓扑排序（保持存储即拓扑序）；未更换则原样保留
    const kp = patch.knowledge_points ? normalizeKnowledgePoints(next.knowledge_points) : null;
    const assumptions = kp ? ['未排期：等待用户提供起始日期与每日时间预算（preview → schedule → confirm）', ...kp.assumptions] : d.assumptions;
    db.prepare(
      `UPDATE study_plan_drafts SET title = ?, goal = ?, material_source = ?, knowledge_points = ?, assumptions = ?, course_id = ?, notes = ?, updated_at = ? WHERE id = ?`,
    ).run(
      next.title,
      next.goal,
      next.material_source,
      JSON.stringify(kp ? kp.ordered : next.knowledge_points),
      JSON.stringify(assumptions),
      next.course_id,
      next.notes,
      nowIso(),
      id,
    );
    return getDraft(id);
  };

  /** 其他进行中（active）计划在 [from, to] 区间内每日已排估算分钟数（条目无时长按缺省 60 计；可排除指定计划——确认复检时排除本次刚建的） */
  const activeUsageBetween = (from: string, to: string, excludePlanId?: number): Map<string, number> => {
    const rows = db
      .prepare(
        `SELECT pi.date AS date, SUM(COALESCE(pi.duration_min, ?)) AS minutes
         FROM plan_items pi JOIN study_plans sp ON sp.id = pi.plan_id
         WHERE sp.status = 'active' AND pi.date >= ? AND pi.date <= ?${excludePlanId != null ? ' AND sp.id != ?' : ''}
         GROUP BY pi.date`,
      )
      .all(...(excludePlanId != null ? [DEFAULT_KNOWLEDGE_POINT_MINUTES, from, to, excludePlanId] : [DEFAULT_KNOWLEDGE_POINT_MINUTES, from, to]));
    const usage = new Map<string, number>();
    for (const r of rows) usage.set(String(r.date), Number(r.minutes ?? 0));
    return usage;
  };

  /** 按当下库状态重算 items 的超预算日期（其他 active 计划当日占用 + 新排 > 预算），排序返回 */
  const overDatesOf = (items: Array<{ date: string; duration_min: number }>, budget: number, excludePlanId?: number): string[] => {
    if (items.length === 0) return [];
    let min = items[0].date;
    let max = items[0].date;
    const newByDate = new Map<string, number>();
    for (const it of items) {
      min = it.date < min ? it.date : min;
      max = it.date > max ? it.date : max;
      newByDate.set(it.date, (newByDate.get(it.date) ?? 0) + it.duration_min);
    }
    const usage = activeUsageBetween(min, max, excludePlanId);
    const over: string[] = [];
    for (const [date, mins] of newByDate) {
      if ((usage.get(date) ?? 0) + mins > budget) over.push(date);
    }
    return over.sort();
  };

  /**
   * 冲突确认快照硬校验（服务层，UI 提示不可替代）：
   * 当下重算的超预算日期集合必须与用户确认的集合**精确一致**——
   * 有冲突未确认、确认集过期（预览后既有计划变动）、冲突已消失却仍带旧确认集，一律拒绝并要求重新预览。
   */
  const assertOverDatesConfirmed = (over: string[], confirmed: string[] | undefined, stage: string): void => {
    const got = [...over].sort().join('、');
    const want = [...new Set((confirmed ?? []).map((d) => ensureValidDateStr(d)))].sort().join('、');
    if (got === want) return;
    throw new Error(
      `预算冲突硬校验失败（${stage}）：当前超预算日期为 [${got || '无'}]，与用户确认的 [${want || '无'}] 不一致。` +
        (got.length > 0
          ? `请把冲突逐条告知用户并取得同意后，重新 preview_study_draft_schedule，把最新 over_budget_dates 原样作为 confirmed_over_dates 传回（或调整起始日期/预算/既有计划）`
          : '当前已无超预算冲突：请清空 confirmed_over_dates 后重试'),
    );
  };

  /**
   * 排期预览（纯只读，不写库）：给定起始日期与每日预算，按透明规则重排逐日安排，
   * 并汇总两类预警供用户确认前核对——
   * 1. 每日预算冲突：排期区间内其他进行中计划当日已排分钟数 + 本草案当日新排分钟数超出预算；
   * 2. 知识点重复：本草案知识点已出现在其他进行中计划的未完成条目里（重复学习预警）。
   * 依赖拓扑顺序随预览返回（先修在前，有环在此暴露）。
   */
  const previewDraftSchedule = (id: number, startDate: string, dailyMinutes: number): DraftSchedulePreview => {
    const d = getDraft(id);
    if (d.status === 'confirmed') throw new Error(`草案 ${id} 已确认为计划 ${d.plan_id}，无需再排期；如需调整请使用计划调整建议`);
    if (d.status === 'cancelled') throw new Error(`草案 ${id} 已取消，不能排期；请重新创建草案`);
    const start = ensureValidDateStr(startDate);
    const budget = assertDailyMinutes(dailyMinutes);
    const scheduled = scheduleKnowledgePoints(d.knowledge_points, budget, start);

    // 每日冲突：本草案当日新排分钟 + 其他 active 计划当日既有占用 vs 声明预算
    const usage = activeUsageBetween(start, scheduled.endDate);
    const newByDate = new Map<string, number>();
    for (const it of scheduled.items) newByDate.set(it.date, (newByDate.get(it.date) ?? 0) + it.duration_min);
    const conflicts: DraftScheduleConflict[] = [];
    for (const [date, newMinutes] of [...newByDate.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const existing = usage.get(date) ?? 0;
      if (existing === 0 && newMinutes <= budget) continue;
      conflicts.push({
        date,
        existing_minutes: existing,
        new_minutes: newMinutes,
        daily_minutes: budget,
        over_budget: existing + newMinutes > budget,
      });
    }

    // 知识点重复：与其他 active 计划的未完成条目比对
    const keys = d.knowledge_points.map((k) => k.key);
    const placeholders = keys.map(() => '?').join(', ');
    const dupRows = keys.length
      ? (db
          .prepare(
            `SELECT DISTINCT sp.id AS plan_id, sp.title AS plan_title, pi.knowledge_key AS knowledge_key
             FROM plan_items pi JOIN study_plans sp ON sp.id = pi.plan_id
             WHERE sp.status = 'active' AND pi.status = 'pending' AND pi.knowledge_key IS NOT NULL AND pi.knowledge_key IN (${placeholders})`,
          )
          .all(...keys) as Array<{ plan_id: number; plan_title: string; knowledge_key: string }>)
      : [];
    const duplicate_knowledge_keys: DraftKnowledgeDuplicate[] = dupRows.map((r) => ({
      knowledge_key: String(r.knowledge_key),
      plan_id: Number(r.plan_id),
      plan_title: String(r.plan_title),
    }));

    const warnings: string[] = [];
    const overDays = conflicts.filter((c) => c.over_budget);
    if (overDays.length > 0) {
      warnings.push(
        `预算冲突：${overDays.map((c) => `${c.date}（既有 ${c.existing_minutes}m + 新排 ${c.new_minutes}m > ${budget}m）`).join('、')}；可换起始日期、调高每日预算或先调整既有计划`,
      );
    }
    if (duplicate_knowledge_keys.length > 0) {
      warnings.push(
        `知识点重复：${duplicate_knowledge_keys.map((x) => `${x.knowledge_key}（计划「${x.plan_title}」未完成）`).join('、')} 已在其他进行中计划里，确认排期前请与用户核对是否重复学习`,
      );
    }
    return {
      draft_id: id,
      start_date: start,
      end_date: scheduled.endDate,
      daily_minutes: budget,
      items: scheduled.items,
      ordered_keys: scheduled.ordered.map((k) => k.key),
      dependency_chains: scheduled.ordered.map((k) => ({ key: k.key, name: k.name, depends_on: k.depends_on })),
      assumptions: scheduled.assumptions,
      conflicts,
      over_budget_dates: conflicts.filter((c) => c.over_budget).map((c) => c.date).sort(),
      duplicate_knowledge_keys,
      warnings,
    };
  };

  /**
   * 排期提交（事务 + 幂等 + **预算冲突硬校验**）：把用户确认过的起始日期与每日预算落库并生成逐日安排。
   * - 硬校验（服务层，UI 预览提示不可替代）：事务内（BEGIN IMMEDIATE 持写锁）按当下库状态重算超预算
   *   日期——预览之后其他进程新增/改期的计划在此刻全部可见；存在超预算日则必须携带 confirmed_over_dates
   *   且与重算集合**精确一致**（有冲突未确认/确认集过期/冲突消失仍带旧集，一律拒绝）；
   * - 幂等：同参数重复提交直接返回原草案（不重算副作用；排期成功后的外界变化由确认边界兜底）；
   * - 已排期但未确认的草案换参数 = 重新排期（重新过硬校验）；已确认/已取消的草案拒绝；
   * - 排期后仍是草案：生成正式计划与待办仍走 confirmDraft（确认边界会再次硬校验）。
   */
  const scheduleDraft = (id: number, startDate: string, dailyMinutes: number, opts: DraftConflictConfirm = {}): StudyDraft => {
    const d = getDraft(id);
    if (d.status === 'confirmed') throw new Error(`草案 ${id} 已确认为计划 ${d.plan_id}，不能再排期；如需调整请使用计划调整建议`);
    if (d.status === 'cancelled') throw new Error(`草案 ${id} 已取消，不能排期；请重新创建草案`);
    const start = ensureValidDateStr(startDate);
    const budget = assertDailyMinutes(dailyMinutes);
    if (d.start_date === start && d.daily_minutes === budget && d.items.length > 0) return d; // 幂等：同参数重复提交
    const scheduled = scheduleKnowledgePoints(d.knowledge_points, budget, start);
    const now = nowIso();
    inTx(db, () => {
      assertOverDatesConfirmed(overDatesOf(scheduled.items, budget), opts.confirmed_over_dates, '排期');
      const r = db
        .prepare(
          `UPDATE study_plan_drafts SET daily_minutes = ?, start_date = ?, end_date = ?, items = ?, assumptions = ?, conflict_checked_at = ?, updated_at = ? WHERE id = ? AND status = 'draft'`,
        )
        .run(budget, start, scheduled.endDate, JSON.stringify(scheduled.items), JSON.stringify(scheduled.assumptions), now, now, id);
      if (r.changes === 0) throw new Error(`草案 ${id} 状态已变化（并发确认/取消），本次排期未生效，请重读草案后再试`);
    });
    return getDraft(id);
  };

  const listDrafts = (status?: StudyDraftStatus): StudyDraft[] => {    const where = status ? 'WHERE status = ?' : '';
    const params = status ? [status] : [];
    return db
      .prepare(`SELECT * FROM study_plan_drafts ${where} ORDER BY created_at DESC, id DESC`)
      .all(...params)
      .map(mapDraft);
  };

  const getDraft = (id: number): StudyDraft => {
    const row = db.prepare('SELECT * FROM study_plan_drafts WHERE id = ?').get(id);
    if (!row) throw new Error(`学习计划草案 ${id} 不存在`);
    return mapDraft(row);
  };

  /** 补偿回滚：使用计划删除的同一事务清理计划与生成待办。 */
  const rollbackPlanWithTodos = (planId: number): void => {
    deps.plans.remove(planId);
  };

  /** 仅按草案中明确记录的课程建立绑定；调用方须持有事务写锁，禁止覆盖已有绑定。 */
  const bindDraftCourse = (draft: StudyDraft, planId: number): void => {
    if (draft.course_id == null) return;
    const course = db.prepare('SELECT plan_id FROM courses WHERE id = ?').get(draft.course_id);
    if (!course) throw new Error(`关联课程 ${draft.course_id} 不存在，无法确认学习计划`);
    if (course.plan_id != null) {
      if (Number(course.plan_id) !== planId) {
        throw new Error(`课程 ${draft.course_id} 已绑定学习计划 ${course.plan_id}，不得改绑计划 ${planId}`);
      }
      return;
    }
    db.prepare('UPDATE courses SET plan_id = ?, updated_at = ? WHERE id = ? AND plan_id IS NULL')
      .run(planId, nowIso(), draft.course_id);
  };

  /**
   * 确认草案 → 生成正式计划与逐日待办，并绑定草案指定的课程。
   * 幂等：已确认的草案返回原计划，仅补齐旧版遗漏的空绑定，不重复创建或改绑。
   * **确认边界预算冲突硬校验**（仅新排期路径：conflict_checked_at 非 NULL，即经 scheduleDraft 排期的草案）：
   * 排期之后、确认之前，其他进程（App ↔ MCP 共库）可能新增/改期计划引入新的超预算冲突——
   * 1. 建计划前按当下库状态重检（快速拒绝，无副作用）；
   * 2. 建计划并落确认状态后**再复检一次**（排除本次刚建的计划自身，捕获建计划期间的并发写入）；
   *    不一致则整体回退：草案恢复未确认、本次生成的计划与待办删除，绝不留下冲突未确认的计划。
   * 旧路径豁免（明确限定）：conflict_checked_at IS NULL = `draft()` 创建即排期的 dated 草案，
   * 确认不设冲突门（历史行为保持），不因新增的校验挡住既有流程。
   * 草案确认、预算复检与课程绑定共用事务；失败后删除本次生成的计划与待办并原样抛错，
   * 不留下「计划已建而草案未确认」的中间态。
   */
  const confirmDraft = (id: number, opts: DraftConflictConfirm = {}): { draft: StudyDraft; plan: PlanDetail } => {
    const d = getDraft(id);
    if (d.status === 'confirmed' && d.plan_id != null) {
      const planId = d.plan_id;
      return inTx(db, () => {
        const plan = deps.plans.get(planId);
        bindDraftCourse(d, plan.id);
        return { draft: d, plan };
      });
    }
    if (d.status === 'cancelled') throw new Error(`草案 ${id} 已取消，不能确认；请重新生成草案`);
    // 无日期草案防御：未排期（无起始日期/每日预算/逐日安排）一律拒绝确认——
    // 必须先 previewDraftSchedule 预览、scheduleDraft 排期，再走确认
    if (d.start_date == null || d.end_date == null || d.daily_minutes == null || d.items.length === 0) {
      throw new Error(`草案 ${id} 尚未排期（缺起始日期/每日预算/逐日安排），不能确认；请先 preview_study_draft_schedule 预览并 schedule_study_draft 排期`);
    }
    const dailyMinutes = d.daily_minutes;
    // 1) 建计划前重检（新排期路径）：排期后既有计划变动在此刻可见，冲突集必须与用户确认的精确一致
    if (d.conflict_checked_at != null) {
      assertOverDatesConfirmed(overDatesOf(d.items, d.daily_minutes), opts.confirmed_over_dates, '确认');
    }
    // plans.create 自带事务（此处不可再包一层，避免嵌套 BEGIN）
    const plan = deps.plans.create({
      title: d.title,
      goal: d.goal || `目标：${d.title}`,
      start_date: d.start_date,
      end_date: d.end_date,
      notes: d.notes || `材料来源：${d.material_source || '未提供'}；由学习草案 ${d.id} 确认生成`,
      items: d.items.map((it) => ({ date: it.date, content: it.content, item_type: it.item_type, duration_min: it.duration_min, knowledge_key: it.knowledge_key })),
      create_todos: true,
      daily_minutes: d.daily_minutes,
    });
    try {
      inTx(db, () => {
        const confirmed = db
          .prepare(
            `UPDATE study_plan_drafts SET status = 'confirmed', plan_id = ?, confirmed_at = ?, updated_at = ? WHERE id = ? AND status = 'draft'`,
          )
          .run(plan.id, nowIso(), nowIso(), id).changes === 1;
        if (!confirmed) throw new Error(`草案 ${id} 确认中断（状态更新未生效），已回滚本次生成的计划 ${plan.id}`);
        // 排除本次刚建的计划自身，在事务内复检预算，再写入课程绑定。
        if (d.conflict_checked_at != null) {
          assertOverDatesConfirmed(overDatesOf(d.items, dailyMinutes, plan.id), opts.confirmed_over_dates, '确认复检');
        }
        bindDraftCourse(d, plan.id);
      });
    } catch (e) {
      rollbackPlanWithTodos(plan.id);
      throw e;
    }
    return { draft: getDraft(id), plan };
  };

  /** 取消草案：无任何其他副作用（不产生/不删除计划与待办）；重复取消幂等 */
  const cancelDraft = (id: number): StudyDraft => {
    const d = getDraft(id);
    if (d.status === 'cancelled') return d;
    if (d.status === 'confirmed') throw new Error(`草案 ${id} 已确认为计划 ${d.plan_id}，不能取消草案；如需终止请归档对应计划`);
    db.prepare(`UPDATE study_plan_drafts SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?`).run(nowIso(), nowIso(), id);
    return getDraft(id);
  };

  // ===== 学习会话 =====

  /** 会话归属键：条目会话按条目，独立主题会话按 知识点+日期 */
  const sessionScopeKey = (planItemId: number | null | undefined, knowledgeKey: string, date: string): string =>
    planItemId != null ? `pi:${planItemId}` : `kp:${knowledgeKey}@${date}`;

  const getSession = (id: string): StudySession | null => {
    const row = db.prepare('SELECT * FROM study_sessions WHERE id = ?').get(id);
    return row ? mapSession(row) : null;
  };

  /**
   * 记录一次学习会话。幂等规则（按优先级）：
   * 1. 传了 id 且已存在：按 id 更新（目标不一致会拒绝）；
   * 2. 未传 id：按 (scope_key, attempt) 查找复用；attempt 也未传则取该目标已有次数 + 1
   *    （即「下一次尝试」），并生成确定性 id（sess-<scope哈希>-a<attempt>）——
   *    因此「无 id + 显式 attempt」的重复提交同样幂等；只传内容不传 id/attempt 视为新一轮尝试。
   */
  const recordSession = (input: StudySessionInput): StudySession => {
    const knowledgeKey = input.knowledge_key?.trim();
    if (!knowledgeKey) throw new Error('knowledge_key 不能为空');
    const date = ensureValidDateStr(input.date ?? todayStr());
    if (date < addDays(todayStr(), -MAX_SESSION_BACKFILL_DAYS)) {
      throw new Error(`会话日期 ${date} 过早，不支持补记超过 ${MAX_SESSION_BACKFILL_DAYS} 天前的会话`);
    }
    if (input.actual_minutes !== undefined && (!Number.isInteger(input.actual_minutes) || input.actual_minutes <= 0 || input.actual_minutes > 1440)) {
      throw new Error(`实际用时 actual_minutes 必须为 1~1440 的整数（分钟），收到 "${input.actual_minutes}"`);
    }
    if (input.plan_item_id != null) {
      const item = deps.plans.getItem(input.plan_item_id);
      if (input.plan_id != null && item.plan_id !== input.plan_id) {
        throw new Error(`条目 ${input.plan_item_id} 属于计划 ${item.plan_id}，与传入的 plan_id ${input.plan_id} 不一致`);
      }
    }
    const scopeKey = sessionScopeKey(input.plan_item_id, knowledgeKey, date);
    const now = nowIso();
    const nextAttempt = (): number => {
      const row = db.prepare('SELECT MAX(attempt) AS m FROM study_sessions WHERE scope_key = ?').get(scopeKey);
      return Number((row as { m: number | null }).m ?? 0) + 1;
    };
    const byScope = (att: number): StudySession | null => {
      const row = db.prepare('SELECT * FROM study_sessions WHERE scope_key = ? AND attempt = ?').get(scopeKey, att);
      return row ? mapSession(row) : null;
    };

    let existing: StudySession | null = null;
    if (input.id) {
      existing = getSession(input.id);
      if (existing && existing.scope_key !== scopeKey) {
        throw new Error(`会话 id "${input.id}" 已属于目标 ${existing.scope_key}，与本次目标 ${scopeKey} 不一致；请换一个 id 或不传 id`);
      }
    }
    const attempt = existing ? existing.attempt : input.attempt ?? nextAttempt();
    if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`attempt 必须为正整数，收到 "${attempt}"`);
    if (!existing) existing = byScope(attempt);

    const topic = input.topic?.trim() || existing?.topic || knowledgeKey;
    const planId = input.plan_id ?? existing?.plan_id ?? null;
    const planItemId = input.plan_item_id ?? existing?.plan_item_id ?? null;
    const materialSource = input.material_source?.trim() ?? existing?.material_source ?? '';
    const explanation = input.explanation ?? existing?.explanation ?? '';
    const questions = input.questions ?? existing?.questions ?? '';
    const rowId =
      existing?.id ??
      input.id ??
      `sess-${createHash('sha256').update(scopeKey).digest('hex').slice(0, 10)}-a${attempt}`;

    inTx(db, () => {
      db.prepare(
        `INSERT INTO study_sessions (id, plan_id, plan_item_id, scope_key, knowledge_key, topic, attempt, date, actual_minutes, explanation, questions, material_source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           plan_id = excluded.plan_id, plan_item_id = excluded.plan_item_id, topic = excluded.topic,
           attempt = excluded.attempt, date = excluded.date, actual_minutes = excluded.actual_minutes,
           explanation = excluded.explanation, questions = excluded.questions,
           material_source = excluded.material_source, updated_at = excluded.updated_at`,
      ).run(
        rowId,
        planId,
        planItemId,
        scopeKey,
        knowledgeKey,
        topic,
        attempt,
        date,
        input.actual_minutes ?? existing?.actual_minutes ?? 0,
        explanation,
        questions,
        materialSource,
        existing?.created_at ?? now,
        now,
      );
    });
    return getSession(rowId)!;
  };

  const listSessions = (filter: { plan_id?: number; plan_item_id?: number; knowledge_key?: string; since?: string; until?: string; limit?: number }): StudySession[] => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.plan_id != null) {
      where.push('plan_id = ?');
      params.push(filter.plan_id);
    }
    if (filter.plan_item_id != null) {
      where.push('plan_item_id = ?');
      params.push(filter.plan_item_id);
    }
    if (filter.knowledge_key) {
      where.push('knowledge_key = ?');
      params.push(filter.knowledge_key);
    }
    if (filter.since) {
      where.push('date >= ?');
      params.push(ensureValidDateStr(filter.since));
    }
    if (filter.until) {
      where.push('date <= ?');
      params.push(ensureValidDateStr(filter.until));
    }
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
    return db
      .prepare(`SELECT * FROM study_sessions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY date DESC, attempt DESC LIMIT ${limit}`)
      .all(...params)
      .map(mapSession);
  };

  // ===== 测评记录 =====

  const VALID_SOURCES: AssessmentSource[] = ['self', 'objective', 'ai_suggestion'];

  const getAssessment = (id: string): StudyAssessment | null => {
    const row = db.prepare('SELECT * FROM study_assessments WHERE id = ?').get(id);
    return row ? mapAssessment(row) : null;
  };

  /**
   * 记录一次测评。幂等与纠正历史：
   * - 传 id 或命中去重键（session_id+question / knowledge_key+date+question）→ 更新已有记录；
   * - 内容有实质变化（来源/评分/答案/反馈/依据/判题结果任一不同）才追加 corrections（保留旧值全貌），
   *   完全相同的重复提交不产生历史；
   * - 计划归属：优先显式 plan_id；其次沿用已有关联；带 session_id 时自动采用会话所属计划
   *   （掌握度按计划隔离，见 getMastery）；会话/条目/计划的归属不一致会被拒绝；
   * - objective 来源必须提供 evidence（真实判题依据）与判题结果，否则拒绝——Dayfolio 不代判、不伪造；
   * - ai_suggestion 仅作为参考记录，不计入掌握度证据（get_mastery 会说明）。
   */
  const recordAssessment = (input: StudyAssessmentInput): StudyAssessment => {
    const knowledgeKey = input.knowledge_key?.trim();
    if (!knowledgeKey) throw new Error('knowledge_key 不能为空');
    if (!input.question?.trim()) throw new Error('测评题目 question 不能为空');
    if (!input.answer?.trim()) throw new Error('原答案 answer 不能为空');
    if (!VALID_SOURCES.includes(input.source)) {
      throw new Error(`评价来源 source 必须是 ${VALID_SOURCES.join('/')}，收到 "${input.source}"`);
    }
    if (input.score != null && (!Number.isInteger(input.score) || input.score < 0 || input.score > 100)) {
      throw new Error(`score 必须为 0~100 的整数，收到 "${input.score}"`);
    }
    if (input.source === 'objective') {
      if (!input.evidence?.trim()) throw new Error('objective 测评必须提供 evidence（判题依据：题目来源、判题过程与结果）');
      if (input.objective_passed == null) throw new Error('objective 测评必须提供 objective_passed（实际判题结果）');
    }
    const session = input.session_id != null ? getSession(input.session_id) : null;
    if (input.session_id != null && !session) {
      throw new Error(`关联的学习会话 "${input.session_id}" 不存在`);
    }
    // 计划归属解析 + 一致性校验（会话 / 条目 / 计划三者不能互相矛盾）
    const planId = input.plan_id ?? null;
    if (session && planId != null && session.plan_id != null && session.plan_id !== planId) {
      throw new Error(`会话 "${session.id}" 属于计划 ${session.plan_id}，与传入的 plan_id ${planId} 不一致`);
    }
    if (input.plan_item_id != null) {
      const item = deps.plans.getItem(input.plan_item_id);
      if (planId != null && item.plan_id !== planId) {
        throw new Error(`条目 ${input.plan_item_id} 属于计划 ${item.plan_id}，与传入的 plan_id ${planId} 不一致`);
      }
      if (session && session.plan_item_id != null && session.plan_item_id !== input.plan_item_id) {
        throw new Error(`会话 "${session.id}" 关联的是条目 ${session.plan_item_id}，与传入的 plan_item_id ${input.plan_item_id} 不一致`);
      }
    }
    const date = ensureValidDateStr(input.date ?? todayStr());
    const now = nowIso();

    // 去重键：同一会话同一题 / 同一知识点同一天同一题，视为同一次测评的重复提交
    let existing = input.id ? getAssessment(input.id) : null;
    if (!existing && !input.id) {
      const row = input.session_id
        ? db.prepare('SELECT * FROM study_assessments WHERE session_id = ? AND question = ? ORDER BY created_at LIMIT 1').get(input.session_id, input.question.trim())
        : db.prepare('SELECT * FROM study_assessments WHERE session_id IS NULL AND knowledge_key = ? AND date = ? AND question = ? ORDER BY created_at LIMIT 1').get(knowledgeKey, date, input.question.trim());
      existing = row ? mapAssessment(row) : null;
    }

    const id = existing?.id ?? input.id ?? `asm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const sessionId = input.session_id ?? existing?.session_id ?? null;
    const resolvedPlanId = planId ?? existing?.plan_id ?? session?.plan_id ?? null;
    const topic = input.topic?.trim() || existing?.topic || knowledgeKey;
    const newScore = input.score ?? null;
    // objective 已在上面强制要求 objective_passed（boolean）；此处归一为 0/1 存储
    const newPassed = input.source === 'objective' ? (input.objective_passed ? 1 : 0) : null;

    const next = {
      topic,
      criteria: input.criteria?.trim() ?? existing?.criteria ?? '',
      answer: input.answer.trim(),
      source: input.source,
      score: newScore,
      objective_passed: newPassed,
      feedback: input.feedback ?? existing?.feedback ?? '',
      evidence: input.evidence?.trim() ?? existing?.evidence ?? '',
    };

    let corrections = existing?.corrections ?? [];
    if (existing) {
      const samePassed = (v: boolean | null, w: number | null) => (v == null ? w == null : w === (v ? 1 : 0));
      const changed =
        existing.source !== next.source ||
        existing.score !== next.score ||
        !samePassed(existing.objective_passed, next.objective_passed) ||
        existing.answer !== next.answer ||
        existing.feedback !== next.feedback ||
        existing.evidence !== next.evidence ||
        existing.criteria !== next.criteria;
      if (changed) {
        corrections = [
          ...corrections,
          {
            at: now,
            note: `更新测评（${changed ? '内容有变化' : ''}）`,
            from_source: existing.source,
            to_source: next.source,
            from_score: existing.score,
            to_score: next.score,
            from_answer: existing.answer,
            to_answer: next.answer,
            from_feedback: existing.feedback,
            to_feedback: next.feedback,
            from_evidence: existing.evidence,
            to_evidence: next.evidence,
            from_objective_passed: existing.objective_passed,
            to_objective_passed: next.objective_passed === null ? null : next.objective_passed === 1,
          },
        ];
      }
    }

    inTx(db, () => {
      db.prepare(
        `INSERT INTO study_assessments
         (id, session_id, plan_id, plan_item_id, knowledge_key, topic, question, criteria, answer, source, score, objective_passed, feedback, evidence, corrections, date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           session_id = excluded.session_id, plan_id = excluded.plan_id, plan_item_id = excluded.plan_item_id,
           topic = excluded.topic, criteria = excluded.criteria, answer = excluded.answer, source = excluded.source,
           score = excluded.score, objective_passed = excluded.objective_passed, feedback = excluded.feedback,
           evidence = excluded.evidence, corrections = excluded.corrections, date = excluded.date, updated_at = excluded.updated_at`,
      ).run(
        id,
        sessionId,
        resolvedPlanId,
        input.plan_item_id ?? existing?.plan_item_id ?? null,
        knowledgeKey,
        next.topic,
        input.question.trim(),
        next.criteria,
        next.answer,
        next.source,
        next.score,
        next.objective_passed,
        next.feedback,
        next.evidence,
        JSON.stringify(corrections),
        date,
        existing?.created_at ?? now,
        now,
      );
    });
    return getAssessment(id)!;
  };

  const listAssessments = (filter: { plan_id?: number; knowledge_key?: string; session_id?: string; source?: AssessmentSource; limit?: number }): StudyAssessment[] => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.plan_id != null) {
      where.push('plan_id = ?');
      params.push(filter.plan_id);
    }
    if (filter.knowledge_key) {
      where.push('knowledge_key = ?');
      params.push(filter.knowledge_key);
    }
    if (filter.session_id) {
      where.push('session_id = ?');
      params.push(filter.session_id);
    }
    if (filter.source) {
      where.push('source = ?');
      params.push(filter.source);
    }
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
    return db
      .prepare(`SELECT * FROM study_assessments ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ${limit}`)
      .all(...params)
      .map(mapAssessment);
  };

  // ===== 掌握度（与完成率分离） =====

  /**
   * 掌握度只看测评证据（透明规则），且**按计划隔离**：
   * - 计划范围内只统计归属该计划的会话与测评（不带 plan_id 的测评只进全局视图，不污染计划掌握度）；
   * - 无 self/objective 证据 → unknown（打卡/会话不算掌握，缺证据明确未知）；
   * - **客观优先**：只要范围内存在 objective 测评，取最新客观判题结果（通过=strong / 未通过=weak），
   *   自评不覆盖客观；没有客观测评时才看最新自评（≥80 strong / 60~79 reviewing / <60 weak）；
   * - ai_suggestion 记录在案但不作为证据。
   */
  const masteryOf = (knowledgeKey: string, scopePlanId?: number): MasteryEntry => {
    const sessions = scopePlanId != null
      ? listSessions({ plan_id: scopePlanId, knowledge_key: knowledgeKey, limit: 1000 })
      : listSessions({ knowledge_key: knowledgeKey, limit: 1000 });
    const all = scopePlanId != null
      ? listAssessments({ plan_id: scopePlanId, knowledge_key: knowledgeKey, limit: 1000 })
      : listAssessments({ knowledge_key: knowledgeKey, limit: 1000 });
    const evidence = all.filter((a) => a.source === 'self' || a.source === 'objective');
    const latestBy = (src: 'self' | 'objective') =>
      evidence.filter((a) => a.source === src).sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
    const latestObjective = latestBy('objective');
    const latestSelf = latestBy('self');
    // 客观优先：有客观证据用最新客观结果；否则用最新自评
    const latest = latestObjective ?? latestSelf;
    const scopeNote = scopePlanId != null ? `（仅统计计划 ${scopePlanId} 内的证据）` : '';
    const topic = sessions[0]?.topic ?? latest?.topic ?? knowledgeKey;

    let mastery: MasteryStatus = 'unknown';
    let reason = '尚无自评或客观测评记录，掌握情况未知（完成打卡不等于掌握）';
    if (latest) {
      if (latestObjective) {
        mastery = latestObjective.objective_passed ? 'strong' : 'weak';
        reason = `客观优先：最新客观测评${latestObjective.objective_passed ? '通过' : '未通过'}（依据：${latestObjective.evidence || '未填写'}，测评 ${latestObjective.id}）${scopeNote}`;
      } else if (latestSelf.score == null) {
        mastery = 'unknown';
        reason = `最新自评未打分（测评 ${latestSelf.id}），掌握情况未知${scopeNote}`;
      } else if (latestSelf.score >= MASTERY_SELF_STRONG) {
        mastery = 'strong';
        reason = `最新自评 ${latestSelf.score} 分（≥${MASTERY_SELF_STRONG} 视为掌握良好，测评 ${latestSelf.id}，可被客观测评纠正）${scopeNote}`;
      } else if (latestSelf.score >= MASTERY_SELF_WEAK) {
        mastery = 'reviewing';
        reason = `最新自评 ${latestSelf.score} 分（${MASTERY_SELF_WEAK}~${MASTERY_SELF_STRONG - 1} 之间，仍需巩固，测评 ${latestSelf.id}）${scopeNote}`;
      } else {
        mastery = 'weak';
        reason = `最新自评 ${latestSelf.score} 分（<${MASTERY_SELF_WEAK} 视为薄弱，测评 ${latestSelf.id}）${scopeNote}`;
      }
    }
    const aiOnly = all.length > 0 && evidence.length === 0;
    if (aiOnly) reason += '；另有 AI 建议记录但按规则不计为掌握证据';
    return {
      knowledge_key: knowledgeKey,
      topic,
      mastery,
      evidence_count: evidence.length,
      latest_source: latest?.source ?? null,
      latest_score: latest?.score ?? null,
      latest_objective_passed: latest?.objective_passed ?? null,
      last_assessed_at: latest?.created_at ?? null,
      session_count: sessions.length,
      reason,
    };
  };

  const getMastery = (scope: { plan_id?: number; knowledge_keys?: string[] }): MasteryReport => {
    let keys: string[] = [];
    if (scope.knowledge_keys?.length) {
      keys = [...new Set(scope.knowledge_keys.map((k) => k.trim()).filter(Boolean))];
    } else if (scope.plan_id != null) {
      const plan = deps.plans.get(scope.plan_id);
      keys = [...new Set(plan.items.map((i) => i.knowledge_key).filter((k): k is string => !!k))];
    } else {
      keys = [...new Set(listSessions({ limit: 1000 }).map((s) => s.knowledge_key))];
    }
    const entries = keys.map((k) => masteryOf(k, scope.plan_id));
    const planProgress = scope.plan_id != null ? (() => {
      const p = deps.plans.get(scope.plan_id);
      return { total_items: p.total_items, done_items: p.done_items, progress: p.progress };
    })() : null;
    return { entries, plan_progress: planProgress };
  };

  // ===== 未完成项调整建议（纯预览 → 显式应用） =====

  const dailyBudgetOf = (plan: { daily_minutes: number | null }): number => plan.daily_minutes ?? DEFAULT_PLAN_DAILY_MINUTES;
  const estimateOf = (durationMin: number | null): number => durationMin ?? DEFAULT_KNOWLEDGE_POINT_MINUTES;

  /** 计划内某日期的已排占用（分钟）：现有条目（含已完成）估算时长之和 */
  const usageByDate = (planId: number): Map<string, number> => {
    const usage = new Map<string, number>();
    for (const it of deps.plans.get(planId).items) {
      usage.set(it.date, (usage.get(it.date) ?? 0) + estimateOf(it.duration_min));
    }
    return usage;
  };

  /** 从 from 起找第一个能放下 minutes 的日期；minutes 超过全天预算时找第一个完全空闲的日期 */
  const firstDateWithCapacity = (from: string, minutes: number, usage: Map<string, number>, budget: number): string => {
    let d = from;
    for (let i = 0; i < 365; i++) {
      const used = usage.get(d) ?? 0;
      if (minutes > budget) {
        // 单项超预算：按透明规则单独占用一天（当天必须完全空闲）
        if (used === 0) return d;
      } else if (used + minutes <= budget) {
        return d;
      }
      d = addDays(d, 1);
    }
    return d;
  };

  /** 依赖图：从确认该计划的草案读取（knowledge_points 本身就是拓扑序）；普通计划无草案 → 无先修约束 */
  const loadDepGraph = (planId: number): { deps: Map<string, string[]>; topoKeys: string[] } => {
    const row = db
      .prepare("SELECT knowledge_points FROM study_plan_drafts WHERE plan_id = ? AND status = 'confirmed' ORDER BY id DESC LIMIT 1")
      .get(planId) as { knowledge_points?: string } | undefined;
    if (!row) return { deps: new Map(), topoKeys: [] };
    const kps = parseJsonArray<StudyKnowledgePoint>(row.knowledge_points);
    return { deps: new Map(kps.map((k) => [k.key, k.depends_on ?? []])), topoKeys: kps.map((k) => k.key) };
  };

  /**
   * 生成调整建议（只读，不写库）。透明规则（**依赖感知**，按草案拓扑序处理未完成条目）：
   * A. 漏做改期：未完成条目日期已过 → 顺延到今天起第一个预算未满日；
   * A2. 依赖联动：后继条目早于其**未完成前置的生效日期**（前置被建议改期后的日期）→
   *     联动顺延到前置生效日期之后第一个预算未满日，绝不让后继静默早于前置执行；
   *    已完成/已跳过的前置视为已满足，不再约束后继；
   *    多条建议逐条预占容量（两条各 60 分钟、预算 60 → 不同日期），先修顺序保持；
   * B. 薄弱复习：掌握度 weak 的知识点（其学习条目已完成且未来无复习条目）→ 追加针对性复习条目。
   */
  const suggestAdjustments = (planId: number): AdjustmentSuggestion[] => {
    const plan = deps.plans.get(planId);
    const today = todayStr();
    const budget = dailyBudgetOf(plan);
    const budgetNote = plan.daily_minutes == null ? `（计划未设每日预算，按缺省 ${DEFAULT_PLAN_DAILY_MINUTES} 分钟）` : '';
    const usage = usageByDate(planId);
    const suggestions: AdjustmentSuggestion[] = [];

    // learn 条目按知识点索引；处理顺序优先用草案拓扑序（先修在前），无草案按原顺序
    const learnItems = new Map<string, NonNullable<ReturnType<typeof deps.plans.get>['items'][number]>>();
    for (const it of plan.items) {
      if (it.item_type === 'learn' && it.knowledge_key) learnItems.set(it.knowledge_key, it);
    }
    const { deps: depGraph, topoKeys } = loadDepGraph(planId);
    const keyOrder = topoKeys.filter((k) => learnItems.has(k));
    for (const k of learnItems.keys()) if (!keyOrder.includes(k)) keyOrder.push(k);

    // 未完成前置的「生效日期」：被建议改期则用改期后日期，否则用当前日期；级联传播
    const effectiveDate = new Map<string, string>();

    for (const key of keyOrder) {
      const it = learnItems.get(key)!;
      if (it.status !== 'pending') continue;
      const est = estimateOf(it.duration_min);
      // 未完成前置（pending）才构成约束；done/skipped 视为已满足
      const pendingPrereqs = (depGraph.get(key) ?? [])
        .map((d) => learnItems.get(d))
        .filter((p): p is NonNullable<typeof p> => !!p && p.status === 'pending');
      const depDate = pendingPrereqs.reduce((m, p) => {
        const fd = effectiveDate.get(p.knowledge_key!) ?? p.date;
        return fd > m ? fd : m;
      }, '');

      const overdue = it.date < today;
      const violatesDep = depDate !== '' && it.date < depDate;
      if (!overdue && !violatesDep) {
        effectiveDate.set(key, it.date);
        continue;
      }
      // 起点：漏做从今天起；有未完成前置则不早于前置生效日期；两者取大
      const fromDate = overdue && depDate !== '' ? (today > depDate ? today : depDate) : overdue ? today : depDate;
      const to = firstDateWithCapacity(fromDate, est, usage, budget);
      usage.set(to, (usage.get(to) ?? 0) + est); // 预占容量：后续建议（含依赖联动）看得到本次占用
      effectiveDate.set(key, to);

      const prereqNote =
        pendingPrereqs.length > 0
          ? `；未完成前置「${pendingPrereqs.map((p) => p.content).join('、')}」生效日期 ${depDate}`
          : '';
      const reason = overdue
        ? `漏做：条目「${it.content}」原定 ${it.date}，截至今日未完成${prereqNote}；顺延至 ${to}${budgetNote}${est > budget ? `；该条预计 ${est} 分钟超过每日预算 ${budget} 分钟，单独占用空闲日` : ''}`
        : `依赖联动：前置尚未完成（生效日期 ${depDate}），后继「${it.content}」不能排在它之前；顺延至 ${to}${budgetNote}`;
      suggestions.push({
        id: `adj-${it.id}-reschedule`,
        kind: 'reschedule',
        plan_id: planId,
        item_id: it.id,
        knowledge_key: it.knowledge_key,
        from_date: it.date,
        to_date: to,
        content: it.content,
        duration_min: it.duration_min ?? DEFAULT_KNOWLEDGE_POINT_MINUTES,
        reason,
      });
    }

    const mastery = getMastery({ plan_id: planId });
    for (const entry of mastery.entries.filter((e) => e.mastery === 'weak')) {
      const learnItem = plan.items.find((i) => i.knowledge_key === entry.knowledge_key && i.item_type === 'learn');
      if (!learnItem) continue;
      const hasFutureReview = plan.items.some((i) => i.knowledge_key === entry.knowledge_key && i.item_type === 'review' && i.date >= today && i.status === 'pending');
      if (hasFutureReview) continue;
      const to = firstDateWithCapacity(addDays(today, 1), ADJUST_REVIEW_MINUTES, usage, budget);
      usage.set(to, (usage.get(to) ?? 0) + ADJUST_REVIEW_MINUTES);
      suggestions.push({
        id: `adj-${planId}-review-${entry.knowledge_key}`,
        kind: 'add_review',
        plan_id: planId,
        item_id: null,
        knowledge_key: entry.knowledge_key,
        from_date: null,
        to_date: to,
        content: `复习：${entry.topic}（掌握薄弱，针对性巩固）`,
        duration_min: ADJUST_REVIEW_MINUTES,
        reason: `薄弱证据：${entry.reason}`,
      });
    }
    return suggestions;
  };

  /**
   * 显式应用调整建议（单事务）。**快照绑定**：selection 必须携带预览时看到的 to_date；
   * 应用时按当下状态重算，建议消失、或 to_date 与确认时不一致（预算/计划已变化）都会拒绝该条并说明，
   * 绝不静默执行一个不同于用户确认的日期。
   * **依赖组完整性**：只勾选前置的改期而落下其未完成后继的联动建议，会使落库计划出现
   * 「后继早于未完成前置」——这种不完整勾选被整组拒绝（跳过前置建议并说明需一起勾选的联动建议），
   * 按不动点迭代处理传递链（A→B→C 只勾 A/B 时从最下游逐级回退），落库计划永不破坏先修顺序。
   * - 只动未完成条目（应用瞬间已不是 pending 的跳过并说明）；
   * - reschedule 同步关联待办截止日期，必要时扩展计划 end_date；
   * - add_review 新增复习条目并生成待办；取消 = 不调用本函数，无副作用。
   */
  const applyAdjustments = (planId: number, selection: Array<{ id: string; to_date: string }>): AdjustmentApplyResult => {
    if (!Array.isArray(selection) || selection.length === 0) {
      throw new Error('selection 不能为空：请传入预览确认过的建议（{id, to_date} 列表）；如需全部应用，把预览结果原样传入');
    }
    const fresh = suggestAdjustments(planId); // 以当下状态重算，与确认快照逐条比对
    const freshById = new Map(fresh.map((s) => [s.id, s]));
    const applied: AdjustmentApplyResult['applied'] = [];
    const skipped: AdjustmentApplyResult['skipped'] = [];
    let todosSynced = 0;
    let maxDate = deps.plans.get(planId).end_date;
    const now = nowIso();

    // ---- 依赖组完整性校验（预演 + 不动点）----
    // 将应用的改期建议：item_id → 建议。先按快照绑定过滤，再做「后继不得早于未完成前置」预演：
    // 单独前置被勾选而后继联动未勾选 → 拒绝前置（回退其日期），迭代到无违例为止。
    const plan = deps.plans.get(planId);
    const learnItems = new Map<string, PlanItem>();
    for (const it of plan.items) {
      if (it.item_type === 'learn' && it.knowledge_key) learnItems.set(it.knowledge_key, it);
    }
    const { deps: depGraph } = loadDepGraph(planId);
    const selReschedule = new Map<number, AdjustmentSuggestion>(); // item_id → 将应用的改期建议
    for (const pick of selection) {
      const s = freshById.get(pick.id);
      if (s && s.to_date === pick.to_date && s.kind === 'reschedule' && s.item_id != null) selReschedule.set(s.item_id, s);
    }
    const postDate = new Map<string, string>();
    for (const [key, it] of learnItems) {
      const s = selReschedule.get(it.id);
      postDate.set(key, s ? s.to_date : it.date);
    }
    let fixed = true;
    while (fixed) {
      fixed = false;
      for (const [key, it] of learnItems) {
        if (it.status !== 'pending') continue;
        for (const d of depGraph.get(key) ?? []) {
          const p = learnItems.get(d);
          if (!p || p.status !== 'pending') continue; // 已完成/已跳过的前置视为已满足
          if ((postDate.get(key) ?? '') >= (postDate.get(d) ?? '')) continue;
          const ps = selReschedule.get(p.id);
          if (ps) {
            selReschedule.delete(p.id);
            postDate.set(d, p.date);
            skipped.push({
              suggestion_id: ps.id,
              reason: `不完整勾选：单独改期前置「${p.content}」→ ${ps.to_date} 会使后继「${it.content}」（${postDate.get(key)}）早于前置；请连同后继的联动建议一起勾选应用`,
            });
            fixed = true;
          }
        }
      }
    }

    inTx(db, () => {
      for (const pick of selection) {
        const s = freshById.get(pick.id);
        if (!s) {
          skipped.push({ suggestion_id: pick.id, reason: '建议不存在或已失效（计划状态已变化），请重新预览' });
          continue;
        }
        if (s.to_date !== pick.to_date) {
          skipped.push({ suggestion_id: pick.id, reason: `建议日期已变化（确认时 ${pick.to_date}，当前应为 ${s.to_date}），拒绝执行，请重新预览确认` });
          continue;
        }
        if (s.kind === 'reschedule' && s.item_id != null && !selReschedule.has(s.item_id)) {
          continue; // 依赖组完整性已拒绝并记录原因，不重复输出
        }
        if (s.kind === 'reschedule' && s.item_id != null) {
          const item = deps.plans.getItem(s.item_id);
          if (item.status !== 'pending') {
            skipped.push({ suggestion_id: s.id, reason: `条目 ${s.item_id} 已是 ${item.status}，不再调整` });
            continue;
          }
          db.prepare('UPDATE plan_items SET date = ?, updated_at = ? WHERE id = ?').run(s.to_date, now, s.item_id);
          if (item.todo_id != null) {
            deps.todos.update(item.todo_id, { due_date: s.to_date });
            todosSynced++;
          }
          if (s.to_date > maxDate) maxDate = s.to_date;
          applied.push({ suggestion_id: s.id, kind: s.kind, effect: `条目 ${s.item_id} 改期 ${s.from_date} → ${s.to_date}${item.todo_id != null ? `（待办 ${item.todo_id} 截止日已同步）` : ''}` });
        } else if (s.kind === 'add_review') {
          const res = db
            .prepare(
              `INSERT INTO plan_items (plan_id, date, content, item_type, duration_min, status, todo_id, knowledge_key, sort_order, created_at, updated_at)
               VALUES (?, ?, ?, 'review', ?, 'pending', NULL, ?, 900, ?, ?)`,
            )
            .run(planId, s.to_date, s.content, s.duration_min, s.knowledge_key, now, now);
          const todo = deps.todos.add({
            title: s.content,
            notes: `来自学习计划调整建议（${s.reason}）`,
            priority: 'medium',
            due_date: s.to_date,
            tags: ['学习计划', `plan:${planId}`],
            source: 'plan',
          });
          db.prepare('UPDATE plan_items SET todo_id = ? WHERE id = ?').run(todo.id, Number(res.lastInsertRowid));
          todosSynced++;
          if (s.to_date > maxDate) maxDate = s.to_date;
          applied.push({ suggestion_id: s.id, kind: s.kind, effect: `新增复习条目（${s.to_date}）：${s.content}（含待办 ${todo.id}）` });
        }
      }
      if (maxDate > deps.plans.get(planId).end_date) {
        db.prepare('UPDATE study_plans SET end_date = ?, updated_at = ? WHERE id = ?').run(maxDate, now, planId);
      }
      if (applied.length > 0) {
        db.prepare('INSERT INTO plan_adjustments (plan_id, suggestions, applied_at) VALUES (?, ?, ?)').run(
          planId,
          JSON.stringify(applied.map((a) => ({ id: a.suggestion_id, effect: a.effect }))),
          now,
        );
      }
    });
    return { applied, skipped, plan_end_date: maxDate, todos_synced: todosSynced };
  };

  // ===== Obsidian 待审卡片（预览 → 导出） =====

  const sanitizeKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'kp';
  /** 保留大小写的文件名安全化（用于会话 id 段，避免尾部截断碰撞） */
  const sanitizeId = (id: string): string => id.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'sess';

  /** 会话 → 待审卡片 markdown（不冒充主人观点、不宣称已掌握）。frontmatter 字符串值一律 JSON 引号转义（YAML 安全） */
  const renderCardMarkdown = (session: StudySession, planTitle: string | null, assessments: StudyAssessment[]): string => {
    const assessed = assessments
      .map((a) => {
        const sourceLabel = a.source === 'self' ? `自评 ${a.score ?? '未打分'} 分` : a.source === 'objective' ? `客观${a.objective_passed ? '通过' : '未通过'}${a.score != null ? ` ${a.score} 分` : ''}` : 'AI 建议（不计入掌握证据）';
        return `- ${sourceLabel} · ${a.feedback || '无评语'}（测评 ${a.id}，依据：${a.evidence || '未填写'}）`;
      })
      .join('\n');
    const q = (v: string) => JSON.stringify(v); // 双引号 YAML 标量，自动转义引号/反斜杠/换行
    const fm = [
      '---',
      `source: ${q('Dayfolio 学习会话')}`,
      `session_id: ${q(session.id)}`,
      `knowledge_key: ${q(session.knowledge_key)}`,
      `plan: ${planTitle ? q(planTitle) : 'null'}`,
      `date: ${session.date}`,
      `attempt: ${session.attempt}`,
      'status: draft',
      'verified: false',
      `assessed: ${assessments.length ? q(assessments.map((a) => `${a.source}:${a.score ?? (a.objective_passed ? 'pass' : 'fail')}`).join(', ')) : 'none'}`,
      '---',
    ].join('\n');
    const body = [
      `# ${session.topic}`,
      '',
      '## 我的解释',
      session.explanation || '（未填写）',
      '',
      '## 疑问',
      session.questions || '（无）',
      '',
      '## 测评证据',
      assessments.length ? assessed : '（尚无测评记录，掌握情况未知）',
      '',
      '## 材料',
      session.material_source || '（未记录）',
      '',
      '> [!warning] 待审卡片',
      '> 由 Dayfolio 学习会话生成（会话 ' + session.id + '）：内容为学习者当时的自述与自评，**未经核实**，不代表主人观点，也不代表已掌握。请人工审阅后再整理。',
      '',
    ].join('\n');
    return `${fm}\n\n${body}`;
  };

  const cardOf = (session: StudySession): StudyCard => {
    const planTitle = session.plan_id != null ? (() => {
      try {
        return deps.plans.get(session.plan_id).title;
      } catch {
        return null;
      }
    })() : null;
    const assessments = listAssessments({ session_id: session.id, limit: 50 });
    // 文件名含完整会话 id（ sanitized ），会话 id 即主键，天然无尾部截断碰撞
    return {
      card_key: `${session.knowledge_key}#${session.id}`,
      file_name: `TD-${sanitizeKey(session.knowledge_key)}-${sanitizeId(session.id)}.md`,
      markdown: renderCardMarkdown(session, planTitle, assessments),
      session_id: session.id,
      knowledge_key: session.knowledge_key,
      topic: session.topic,
    };
  };

  /** 卡片预览：纯内存计算，不写任何文件 */
  const previewCards = (selector: { plan_id?: number; knowledge_keys?: string[]; session_ids?: string[] }): StudyCard[] => {
    let sessions: StudySession[];
    if (selector.session_ids?.length) {
      sessions = selector.session_ids.map((id) => {
        const s = getSession(id);
        if (!s) throw new Error(`学习会话 "${id}" 不存在`);
        return s;
      });
    } else if (selector.knowledge_keys?.length) {
      sessions = selector.knowledge_keys.flatMap((k) => listSessions({ knowledge_key: k, limit: 1000 }));
    } else if (selector.plan_id != null) {
      sessions = listSessions({ plan_id: selector.plan_id, limit: 1000 });
    } else {
      sessions = listSessions({ limit: 500 });
    }
    return sessions.map(cardOf);
  };

  const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

  /**
   * 导出卡片到独立目录（显式传入 export_dir）。防重与保护规则：
   * - 目标文件不存在 → 以独占模式（wx）创建并记录 card_exports；并发下文件已被抢先创建则按已存在分支处理；
   * - 文件存在且内容与将写入的一致 → 跳过（幂等）；
   * - 文件存在但与上次导出记录不一致（可能被人工编辑）→ 拒绝覆盖（protected）；
   * - 仅当磁盘内容仍等于上次导出记录、且差异来自源会话更新时，才允许覆盖重导。
   */
  const exportCards = (selector: Parameters<typeof previewCards>[0], exportDir: string): CardExportResult => {
    if (!exportDir?.trim()) throw new Error('export_dir 不能为空：请与用户确认导出目录');
    // core 层硬约束（不再仅靠提示文案）：导出目录不得位于任何知识库 vault 内——
    // 含已注册 vault、内置默认保护根（~/Desktop/knowledge-base，即使未注册）与 TODODESK_PROTECTED_DIRS，
    // 比较为 symlink 安全的 realpath 前缀匹配。
    assertDirOutsideVaults(db, resolve(exportDir.trim()));
    const cards = previewCards(selector);
    mkdirSync(exportDir, { recursive: true });
    const outcomes: CardExportOutcome[] = [];
    const saveRecord = (card: StudyCard, filePath: string, hash: string) => {
      db.prepare(
        `INSERT INTO card_exports (card_key, file_path, content_hash, exported_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(card_key) DO UPDATE SET file_path = excluded.file_path, content_hash = excluded.content_hash, exported_at = excluded.exported_at`,
      ).run(card.card_key, filePath, hash, nowIso());
    };
    for (const card of cards) {
      const filePath = join(exportDir, card.file_name);
      const prev = db.prepare('SELECT * FROM card_exports WHERE card_key = ?').get(card.card_key) as
        | { file_path: string; content_hash: string; exported_at: string }
        | undefined;
      const hash = sha256(card.markdown);
      let fileExists = existsSync(filePath);
      if (!fileExists) {
        try {
          writeFileSync(filePath, card.markdown, { encoding: 'utf8', flag: 'wx' }); // 独占创建：不覆盖任何已出现的内容
          saveRecord(card, filePath, hash);
          outcomes.push({ card_key: card.card_key, file_name: card.file_name, result: 'exported', detail: `已写入 ${filePath}` });
          continue;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
          fileExists = true; // 并发下已被创建：转入已存在分支
        }
      }
      const disk = readFileSync(filePath, 'utf8');
      if (disk === card.markdown) {
        outcomes.push({ card_key: card.card_key, file_name: card.file_name, result: 'skipped_identical', detail: '文件内容一致，无需重复导出' });
        if (!prev) saveRecord(card, filePath, hash);
        continue;
      }
      // 磁盘文件与将写入内容不同：只有当磁盘内容仍与上次导出记录一致（未被人工改过）
      // 且差异来自源会话更新时，才允许覆盖重导；否则一律保护不覆盖。
      if (prev && sha256(disk) === prev.content_hash) {
        writeFileSync(filePath, card.markdown, 'utf8');
        saveRecord(card, filePath, hash);
        outcomes.push({ card_key: card.card_key, file_name: card.file_name, result: 'exported', detail: `源会话有更新且文件未被人工修改，已重新导出 ${filePath}` });
        continue;
      }
      if (prev) {
        outcomes.push({
          card_key: card.card_key,
          file_name: card.file_name,
          result: 'protected',
          detail: `目标文件与上次导出内容不一致（导出后被修改过），已保留现有文件不覆盖：${filePath}`,
        });
      } else {
        outcomes.push({
          card_key: card.card_key,
          file_name: card.file_name,
          result: 'protected',
          detail: `目标目录已存在同名文件（非本工具导出），不覆盖：${filePath}`,
        });
      }
    }
    return {
      export_dir: exportDir,
      outcomes,
      exported: outcomes.filter((o) => o.result === 'exported').length,
      skipped: outcomes.filter((o) => o.result === 'skipped_identical').length,
      protected: outcomes.filter((o) => o.result === 'protected').length,
    };
  };

  const listCardExports = (): Array<{ card_key: string; file_path: string; content_hash: string; exported_at: string }> =>
    db.prepare('SELECT card_key, file_path, content_hash, exported_at FROM card_exports ORDER BY exported_at DESC').all() as never;

  return {
    draft,
    draftDateless,
    updateDraftMeta,
    previewDraftSchedule,
    scheduleDraft,
    listDrafts,
    getDraft,
    confirmDraft,
    cancelDraft,
    recordSession,
    getProgress: (planId?: number) => getStudyProgress(db, planId),
    listSessions,
    recordAssessment,
    listAssessments,
    getMastery,
    suggestAdjustments,
    applyAdjustments,
    previewCards,
    exportCards,
    listCardExports,
  };
}

export type StudyService = ReturnType<typeof createStudyService>;
