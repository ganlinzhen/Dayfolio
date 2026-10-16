// 学习计划面板：列表 + 详情（每日卡片概要，Codex 风格）。
// 课程并入本面板（无独立侧栏入口）：首页用「计划 / 课程」切换，默认展示计划；
// 详情可进入关联课程总览，每日摘要卡直达当天完整讲义/自测，
// 返回时回到计划详情并恢复滚动位置；未生成的天从计划大纲显示「待生成」；条目打卡保留。
// 学习闭环（v1）：展示 agent 生成的待确认草案（确认/取消）、计划条目的掌握徽标、
// 学习会话记录、调整建议（预览→应用）与待审卡片（预览→导出）。App 侧无手工建计划表单。
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, call } from '../api';
import CoursePanel, { COURSE_STATUS_LABEL } from './CoursePanel';
import EmptyState from './EmptyState';
import { toast } from './Toast';
import { IconBook, IconChevronLeft, IconItemType } from './icons';

export interface PlanItem {
  id: number;
  date: string;
  content: string;
  item_type: 'learn' | 'review' | 'practice' | 'rest';
  duration_min: number | null;
  status: 'pending' | 'done' | 'skipped';
  todo_id: number | null;
  knowledge_key: string | null;
}

/** 与计划绑定的课程（只读概要；详情数据在课程面板） */
interface BoundCourse {
  id: number;
  slug: string;
  title: string;
  status: 'imported' | 'sample_confirmed' | 'generating' | 'complete';
  plan_id: number | null;
}

interface BoundLesson {
  day: number;
  title: string;
  is_sample: boolean;
  status: 'pending' | 'generated' | 'read';
  estimated_minutes: number;
  concepts: Array<{ name: string }>;
}

export interface Plan {
  id: number;
  title: string;
  goal: string;
  start_date: string;
  end_date: string;
  status: 'active' | 'done' | 'archived';
  notes: string;
  daily_minutes: number | null;
  total_items: number;
  done_items: number;
  progress: number;
  items?: PlanItem[];
}

interface DraftItem {
  date: string;
  content: string;
  item_type: string;
  duration_min: number;
  knowledge_key: string;
}

export interface StudyDraft {
  id: number;
  title: string;
  goal: string;
  material_source: string;
  /** NULL = 未排期的无日期专题草案（不排日程、不产待办、不占预算） */
  daily_minutes: number | null;
  start_date: string | null;
  end_date: string | null;
  knowledge_points: Array<{ key: string; name: string; outcome: string; est_minutes: number; depends_on?: string[] }>;
  items: DraftItem[];
  assumptions: string[];
  status: 'draft' | 'confirmed' | 'cancelled';
  /** 关联课程（样课未确认亦可；仅信息性关联） */
  course_id: number | null;
  /** 排期提交时刻（新排期路径标记）：非 null = 确认时须过预算冲突硬校验；null = 旧路径草案（draft 创建即排期），原流程 */
  conflict_checked_at: string | null;
}

/** 排期预览（只读）：逐日安排 + 与进行中计划的预算冲突/知识点重复 + 依赖拓扑 */
interface SchedulePreview {
  draft_id: number;
  start_date: string;
  end_date: string;
  daily_minutes: number;
  items: DraftItem[];
  ordered_keys: string[];
  dependency_chains: Array<{ key: string; name: string; depends_on: string[] }>;
  assumptions: string[];
  conflicts: Array<{ date: string; existing_minutes: number; new_minutes: number; daily_minutes: number; over_budget: boolean }>;
  /** 超预算日期（排期提交须原样带回 confirmed_over_dates，服务端硬校验精确匹配） */
  over_budget_dates: string[];
  duplicate_knowledge_keys: Array<{ knowledge_key: string; plan_id: number; plan_title: string }>;
  warnings: string[];
}

export interface StudySession {
  id: string;
  plan_id: number | null;
  plan_item_id: number | null;
  knowledge_key: string;
  topic: string;
  attempt: number;
  date: string;
  actual_minutes: number;
  explanation: string;
  questions: string;
  material_source: string;
}

export interface StudyAssessment {
  id: string;
  session_id: string | null;
  knowledge_key: string;
  topic: string;
  question: string;
  criteria: string;
  answer: string;
  source: 'self' | 'objective' | 'ai_suggestion';
  score: number | null;
  objective_passed: boolean | null;
  feedback: string;
  evidence: string;
  corrections: Array<{ at: string; from_score: number | null; to_score: number | null; from_answer?: string; to_answer?: string; from_source?: string; to_source?: string }>;
  date: string;
}

type MasteryStatus = 'unknown' | 'weak' | 'reviewing' | 'strong';

export interface MasteryReport {
  entries: Array<{
    knowledge_key: string;
    topic: string;
    mastery: MasteryStatus;
    evidence_count: number;
    latest_source: string | null;
    latest_score: number | null;
    reason: string;
    session_count: number;
  }>;
  plan_progress: { total_items: number; done_items: number; progress: number } | null;
}

interface AdjustmentSuggestion {
  id: string;
  kind: 'reschedule' | 'add_review';
  item_id: number | null;
  knowledge_key: string | null;
  from_date: string | null;
  to_date: string;
  content: string;
  duration_min: number;
  reason: string;
}

interface StudyCard {
  card_key: string;
  file_name: string;
  markdown: string;
  session_id: string;
  topic: string;
}

interface CardExportResult {
  export_dir: string;
  outcomes: Array<{ card_key: string; file_name: string; result: 'exported' | 'skipped_identical' | 'protected'; detail: string }>;
  exported: number;
  skipped: number;
  protected: number;
}

const TYPE_LABEL: Record<string, string> = { learn: '学习', review: '复习', practice: '练习', rest: '休息' };
const MASTERY_LABEL: Record<MasteryStatus, string> = { unknown: '未知', weak: '薄弱', reviewing: '巩固中', strong: '良好' };
const SOURCE_LABEL: Record<StudyAssessment['source'], string> = { self: '自评', objective: '客观测试', ai_suggestion: 'AI 建议' };
const LESSON_STATUS_LABEL: Record<string, string> = { pending: '待生成', generated: '可阅读', read: '已读' };

function MasteryBadge({ status, title }: { status: MasteryStatus; title?: string }) {
  return (
    <span className={`mastery-badge ${status}`} title={title}>
      {MASTERY_LABEL[status]}
    </span>
  );
}

/** 内嵌课程导航：from 记录入口视图（详情/首页），返回时回对应视图并恢复滚动位置；day 非 null 表示直达该天讲义 */
interface CourseView { courseId: number; day: number | null; from: 'detail' | 'list' }

export default function PlanPanel() {
  const [homeTab, setHomeTab] = useState<'plans' | 'courses'>('plans');
  const [plans, setPlans] = useState<Plan[]>([]);
  const [drafts, setDrafts] = useState<StudyDraft[]>([]);
  const [detail, setDetail] = useState<Plan | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [courseError, setCourseError] = useState('');
  // 课程导航（原「课程」页并入：总览与讲义都在本面板内部打开，侧栏仅此一个学习入口）
  const [courseView, setCourseView] = useState<CourseView | null>(null);
  // 首页课程页数据（含未绑计划的课程；加载失败不阻塞计划展示）
  const [courses, setCourses] = useState<BoundCourse[]>([]);

  // 与当前详情计划绑定的课程及其讲义概要（每日卡片用；加载失败不阻塞详情）
  const [boundCourse, setBoundCourse] = useState<BoundCourse | null>(null);
  const [boundLessons, setBoundLessons] = useState<BoundLesson[]>([]);

  // 详情页的学习闭环数据（均为只读展示，按需加载）
  const [mastery, setMastery] = useState<MasteryReport | null>(null);
  const [sessions, setSessions] = useState<StudySession[]>([]);
  const [assessments, setAssessments] = useState<StudyAssessment[]>([]);
  const [suggestions, setSuggestions] = useState<AdjustmentSuggestion[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [cards, setCards] = useState<StudyCard[] | null>(null);
  const [exportResult, setExportResult] = useState<CardExportResult | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [planList, draftList] = await Promise.all([
        call<Plan[]>(() => api.plans.list()),
        call<StudyDraft[]>(() => api.study.listDrafts({ status: 'draft' })),
      ]);
      setPlans(planList);
      setDrafts(draftList);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
    try {
      setCourses(await call<BoundCourse[]>(() => api.courses.list()));
      setCourseError('');
    } catch (e) {
      setCourseError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 视图切换的滚动位置记忆（列表 ↔ 详情 ↔ 内嵌课程视图）：离开前记录，返回后恢复原位
  const scrollMemo = useRef<Record<'list' | 'detail', number>>({ list: 0, detail: 0 });
  const restoreKeyRef = useRef<'list' | 'detail' | null>(null);
  const saveScroll = (k: 'list' | 'detail') => {
    const el = document.querySelector<HTMLElement>('.content');
    if (el) scrollMemo.current[k] = el.scrollTop;
  };
  const switchHomeTab = (tab: 'plans' | 'courses') => {
    if (tab === homeTab) return;
    scrollMemo.current.list = 0;
    setHomeTab(tab);
    const el = document.querySelector<HTMLElement>('.content');
    if (el) el.scrollTop = 0;
  };
  useEffect(() => {
    if (!restoreKeyRef.current) return;
    const k = restoreKeyRef.current;
    restoreKeyRef.current = null;
    const el = document.querySelector<HTMLElement>('.content');
    if (el) el.scrollTop = scrollMemo.current[k];
  }, [courseView, detail, selectedItemId]);

  const openItem = (id: number) => {
    saveScroll('detail');
    setSelectedItemId(id);
    const el = document.querySelector<HTMLElement>('.content');
    if (el) el.scrollTop = 0;
  };

  const exitItem = () => {
    restoreKeyRef.current = 'detail';
    setSelectedItemId(null);
  };

  // 进入课程：详情内进入回详情，列表课程区进入回列表；day 非 null 时直达该天讲义
  const enterCourse = (courseId: number, day: number | null) => {
    if (detail) saveScroll('detail');
    else saveScroll('list');
    setCourseView({ courseId, day, from: detail ? 'detail' : 'list' });
  };

  // 退出课程视图：回到入口视图并恢复滚动；讲义已读状态与课程状态回流同步（不重置其他详情状态）
  const exitCourse = () => {
    const from = courseView?.from ?? 'list';
    setCourseView(null);
    restoreKeyRef.current = from;
    void refresh();
    if (detail && boundCourse) {
      void call<BoundLesson[]>(() => api.courses.lessons({ course_id: boundCourse.id }))
        .then(setBoundLessons)
        .catch(() => { /* 刷新失败保留旧概要 */ });
    }
  };

  const openDetail = async (id: number) => {
    saveScroll('list');
    const plan = await call<Plan>(() => api.plans.get({ id }));
    setSelectedItemId(null);
    setDetail(plan);
    setSuggestions(null);
    setCards(null);
    setExportResult(null);
    // 绑定课程与讲义概要（失败不阻塞详情展示）
    setBoundCourse(null);
    setBoundLessons([]);
    try {
      const list = await call<BoundCourse[]>(() => api.courses.list());
      const bound = list.find((c) => c.plan_id === id) ?? null;
      setBoundCourse(bound);
      if (bound) setBoundLessons(await call<BoundLesson[]>(() => api.courses.lessons({ course_id: bound.id })));
    } catch { /* 课程数据加载失败按无课程展示 */ }
    // 学习闭环数据只读加载：掌握证据 + 会话 + 测评记录（失败不阻塞详情展示）
    try {
      const [m, s, a] = await Promise.all([
        call<MasteryReport>(() => api.study.getMastery({ plan_id: id })),
        call<StudySession[]>(() => api.study.listSessions({ plan_id: id })),
        call<StudyAssessment[]>(() => api.study.listAssessments({ plan_id: id })),
      ]);
      setMastery(m);
      setSessions(s);
      setAssessments(a);
    } catch {
      setMastery(null);
      setSessions([]);
      setAssessments([]);
    }
  };

  const setItemStatus = async (item: PlanItem, status: PlanItem['status']) => {
    await call(() => api.plans.updateItemStatus({ id: item.id, status }));
    setDetail(await call<Plan>(() => api.plans.get({ id: detail!.id })));
    setSuggestions(null);
    await refresh();
  };

  const archive = async (id: number) => {
    await call(() => api.plans.update({ id, status: 'archived' }));
    setDetail(null);
    await refresh();
    toast('计划已归档，条目与打卡记录保留', {
      label: '撤销',
      run: () => {
        void call(() => api.plans.update({ id, status: 'active' })).then(() => refresh());
      },
    });
  };

  const remove = async (id: number) => {
    if (!confirm('删除该计划？计划、条目、本计划独占的自动生成待办及相关打卡将一并删除，不可恢复。')) return;
    await call(() => api.plans.delete({ id }));
    setDetail(null);
    await refresh();
  };

  // ---------- 学习闭环：草案确认 / 取消 ----------

  const confirmDraft = async (draft: StudyDraft) => {
    // 新排期草案（conflict_checked_at 非空）的确认边界：先取**当下最新**超预算日期，
    // 明确列给用户并取得显式同意后，把精确集合传给服务端（服务端按当下重算硬校验；
    // 弹窗停留期间冲突发生变化会被拒绝并刷新列表引导重新排期，绝不自动默认同意）。
    // 旧路径草案（draft 创建即排期，conflict_checked_at 为 null）保持原确认流程。
    let confirmedOverDates: string[] = [];
    if (draft.conflict_checked_at != null) {
      if (draft.start_date == null || draft.daily_minutes == null) return; // 未排期：确认按钮本就不出现
      try {
        const prev = await call<SchedulePreview>(() =>
          api.study.previewSchedule({ id: draft.id, start_date: draft.start_date!, daily_minutes: draft.daily_minutes! }),
        );
        confirmedOverDates = prev.over_budget_dates;
      } catch (e) {
        setError(`「${draft.title}」无法确认：${(e as Error).message}`);
        return;
      }
    }
    const conflictNotice =
      confirmedOverDates.length > 0
        ? `注意：确认时仍有 ${confirmedOverDates.length} 天超出每日预算 ${draft.daily_minutes} 分钟（与其他进行中计划当日叠加）：\n${confirmedOverDates
            .map((d) => `· ${d}`)
            .join('\n')}\n可取消并改为调整起始日期/每日预算。\n\n`
        : '';
    if (!confirm(`${conflictNotice}确认学习计划草案「${draft.title}」？将生成 ${draft.items.length} 个逐日条目与对应待办。`)) return;
    try {
      // IPC 返回 {draft, plan}（core confirmDraft 原样透传），从这里取统一字段
      const res = await call<{ plan: Plan }>(() => api.study.confirmDraft({ id: draft.id, confirmed_over_dates: confirmedOverDates }));
      await refresh();
      toast(`草案已确认：计划 #${res.plan.id}，${res.plan.total_items} 个条目`);
    } catch (e) {
      // 确认边界硬校验拒绝（弹窗停留期间其他计划变动引入新冲突/冲突集过期）：如实展示原因并刷新，
      // 引导用户重新排期（排期卡片自带冲突预览）
      await refresh();
      setError(`「${draft.title}」确认被拒：${(e as Error).message}`);
    }
  };

  const cancelDraft = async (draft: StudyDraft) => {
    if (!confirm(`取消草案「${draft.title}」？不会产生或删除任何计划与待办。`)) return;
    await call(() => api.study.cancelDraft({ id: draft.id }));
    await refresh();
    toast('草案已取消（无其他变更）');
  };

  // ---------- 学习闭环：无日期专题草案的排期（预览冲突/依赖 → 确认 → 事务排期，幂等） ----------

  const [schedDraftId, setSchedDraftId] = useState<number | null>(null);
  const [schedStart, setSchedStart] = useState('');
  const [schedMinutes, setSchedMinutes] = useState(60);
  const [schedPreview, setSchedPreview] = useState<SchedulePreview | null>(null);
  const [schedBusy, setSchedBusy] = useState(false);

  const openSchedule = (draft: StudyDraft) => {
    setSchedDraftId(draft.id);
    setSchedStart(new Date().toLocaleDateString('sv-SE'));
    setSchedMinutes(draft.daily_minutes ?? 60);
    setSchedPreview(null);
  };

  const closeSchedule = () => {
    setSchedDraftId(null);
    setSchedPreview(null);
  };

  const previewSchedule = async (draft: StudyDraft) => {
    setSchedBusy(true);
    try {
      const res = await call<SchedulePreview>(() => api.study.previewSchedule({ id: draft.id, start_date: schedStart, daily_minutes: schedMinutes }));
      setSchedPreview(res);
    } finally {
      setSchedBusy(false);
    }
  };

  const applySchedule = async (draft: StudyDraft) => {
    if (!schedPreview) return;
    const overDates = schedPreview.over_budget_dates;
    const warn = overDates.length > 0 ? `注意 ${overDates.length} 天超预算（${overDates.join('、')}）已被你知晓。\n\n` : '';
    if (!confirm(`${warn}确认把「${draft.title}」排期为 ${schedPreview.start_date} ~ ${schedPreview.end_date}（每日 ${schedPreview.daily_minutes} 分钟，${schedPreview.items.length} 个条目）？\n排期后仍是草案，生成计划与待办还需再确认。`)) return;
    setSchedBusy(true);
    try {
      // 快照绑定：把预览看到的超预算日期原样带回（服务端按当下状态重算并要求精确一致）
      await call(() => api.study.scheduleDraft({ id: draft.id, start_date: schedStart, daily_minutes: schedMinutes, confirmed_over_dates: overDates }));
      closeSchedule();
      await refresh();
      toast('草案已排期：请核对逐日安排后确认生成计划');
    } catch (e) {
      setError(`「${draft.title}」排期被拒：${(e as Error).message}`);
    } finally {
      setSchedBusy(false);
    }
  };

  // ---------- 学习闭环：调整建议（预览 → 显式应用） ----------

  const loadSuggestions = async (planId: number) => {
    const list = await call<AdjustmentSuggestion[]>(() => api.study.suggestAdjustments({ plan_id: planId }));
    setSuggestions(list);
    setPicked(new Set(list.map((s) => s.id)));
    if (list.length === 0) toast('当前没有需要调整的未完成条目');
  };

  const applyPicked = async (planId: number) => {
    const pickedList = suggestions?.filter((s) => picked.has(s.id)) ?? [];
    if (pickedList.length === 0) return;
    // 快照绑定：把预览时看到的 to_date 原样带回，服务端重算不一致即拒绝
    const res = await call<{ applied: unknown[]; skipped: unknown[]; todos_synced: number }>(() =>
      api.study.applyAdjustments({ plan_id: planId, suggestions: pickedList.map((s) => ({ id: s.id, to_date: s.to_date })) }),
    );
    setSuggestions(null);
    await openDetail(planId);
    await refresh();
    toast(`已应用 ${res.applied.length} 条建议（同步待办 ${res.todos_synced} 个）${res.skipped.length ? `，跳过 ${res.skipped.length} 条` : ''}`);
  };

  // ---------- 学习闭环：待审卡片（预览 → 选目录导出） ----------

  const loadCards = async (planId: number) => {
    const list = await call<StudyCard[]>(() => api.study.previewCards({ plan_id: planId }));
    setCards(list);
    setExportResult(null);
    if (list.length === 0) toast('该计划还没有可生成卡片的学习会话');
  };

  const exportCards = async (planId: number) => {
    const dir = await call<string | null>(() => api.study.pickExportDir());
    if (!dir) {
      toast('已取消导出，未写入任何文件');
      return;
    }
    const res = await call<CardExportResult>(() => api.study.exportCards({ plan_id: planId, export_dir: dir }));
    setExportResult(res);
    toast(`导出完成：写入 ${res.exported}，跳过 ${res.skipped}，保护 ${res.protected}`);
  };

  const today = new Date().toLocaleDateString('sv-SE');

  // ---------- 内嵌课程视图（总览/讲义）：由计划详情或列表课程区进入，返回回入口视图 ----------
  if (courseView) {
    return (
      <CoursePanel
        key={`course-${courseView.courseId}-d${courseView.day ?? 0}`}
        target={{ courseId: courseView.courseId, day: courseView.day }}
        exitLabel={courseView.from === 'detail' ? '返回计划详情' : homeTab === 'courses' ? '返回课程' : '返回学习'}
        onExit={exitCourse}
      />
    );
  }

  // ---------- 详情 ----------
  if (detail) {
    const byDate = new Map<string, PlanItem[]>();
    for (const it of detail.items ?? []) byDate.set(it.date, [...(byDate.get(it.date) ?? []), it]);
    const masteryByKey = new Map((mastery?.entries ?? []).map((e) => [e.knowledge_key, e]));
    if (selectedItemId !== null) {
      const item = detail.items?.find((it) => it.id === selectedItemId);
      if (item) {
        const itemSessions = sessions.filter((s) => s.plan_item_id === item.id);
        const sessionIds = new Set(itemSessions.map((s) => s.id));
        const itemAssessments = assessments.filter((a) => a.session_id && sessionIds.has(a.session_id));
        const itemMastery = item.knowledge_key ? masteryByKey.get(item.knowledge_key) : undefined;
        const statusLabel = { pending: '待完成', done: '已完成', skipped: '已跳过' }[item.status];
        return (
          <div className="panel plan-item-detail">
            <button className="backlink" onClick={exitItem}>
              <IconChevronLeft width={14} height={14} /> 返回计划详情
            </button>
            <header className="panel-head">
              <div className="head-meta mono">{statusLabel}</div>
            </header>
            <p className="sub">所属计划：{detail.title}</p>

            <section className="group">
              <div className="group-label mono">学习安排</div>
              <p className="plan-item-detail-content">{item.content}</p>
              <div className="plan-item-detail-facts mono">
                <span>日期 {item.date}</span>
                <span>类型 {TYPE_LABEL[item.item_type]}</span>
                {item.duration_min != null && <span>预计 {item.duration_min} 分钟</span>}
                <span>状态 {statusLabel}</span>
              </div>
              <div className="row-gap plan-item-detail-actions">
                {item.status !== 'done' && <button className="btn primary" onClick={() => void setItemStatus(item, 'done')}>标记完成</button>}
                {item.status === 'done' && <button className="btn" onClick={() => void setItemStatus(item, 'pending')}>撤销完成</button>}
                {item.status === 'pending' && <button className="btn ghost" onClick={() => void setItemStatus(item, 'skipped')}>跳过</button>}
                {item.status === 'skipped' && <button className="btn ghost" onClick={() => void setItemStatus(item, 'pending')}>恢复待办</button>}
              </div>
            </section>

            {itemMastery && (
              <section className="group">
                <div className="group-label mono">知识点掌握</div>
                <div className="plan-item-detail-mastery">
                  <span>{itemMastery.topic}</span>
                  <MasteryBadge status={itemMastery.mastery} />
                  <span className="sub">{itemMastery.reason}</span>
                </div>
              </section>
            )}

            <section className="group">
              <div className="group-label mono">关联学习记录<span className="group-count">{itemSessions.length} 次会话</span></div>
              {itemSessions.length === 0 ? <p className="sub">暂无关联学习记录。</p> : itemSessions.map((s) => (
                <div key={s.id} className="session-row">
                  <div className="session-head mono">{s.date} · {s.topic} · 第 {s.attempt} 次 · {s.actual_minutes}m</div>
                  {s.explanation && <div className="session-body">我的解释：{s.explanation}</div>}
                  {s.questions && <div className="session-body session-q">疑问：{s.questions}</div>}
                  {s.material_source && <div className="session-meta mono">材料：{s.material_source}</div>}
                </div>
              ))}
            </section>

            {itemAssessments.length > 0 && (
              <section className="group">
                <div className="group-label mono">关联测评<span className="group-count">{itemAssessments.length} 条</span></div>
                {itemAssessments.map((a) => (
                  <div key={a.id} className="assessment-row">
                    <div className="session-head mono">{a.date} · {SOURCE_LABEL[a.source]} · {a.topic}</div>
                    <div className="session-body">题目：{a.question}</div>
                    {a.answer && <div className="session-body">原答案：{a.answer}</div>}
                    {a.feedback && <div className="session-body">反馈：{a.feedback}</div>}
                  </div>
                ))}
              </section>
            )}
          </div>
        );
      }
    }
    // 日期 → 课程天序：计划第 N 个日期对应课程第 N 天（与课程包逐日生成对齐）
    const sortedDates = [...byDate.keys()].sort();
    const dayOfDate = new Map(sortedDates.map((d, i) => [d, i + 1]));
    const lessonOfDate = new Map(sortedDates.map((d) => [d, boundLessons.find((l) => l.day === dayOfDate.get(d)) ?? null]));
    return (
      <div className="panel" role="region" aria-label="学习">
        <button className="backlink" onClick={() => { restoreKeyRef.current = 'list'; setDetail(null); }}>
          <IconChevronLeft width={14} height={14} /> 全部计划
        </button>
        <header className="panel-head">
          <h1>{detail.title}</h1>
          <div className="head-meta mono">
            {detail.done_items}/{detail.total_items} · {Math.round(detail.progress * 100)}%
            {detail.daily_minutes ? ` · 每日预算 ${detail.daily_minutes}m` : ''}
          </div>
        </header>
        <p className="sub">{detail.goal}</p>
        <div className="progress"><div style={{ width: `${Math.round(detail.progress * 100)}%` }} /></div>

        {boundCourse && (
          <div className="notice plan-course-bar">
            <span>
              关联课程「{boundCourse.title}」：课程讲义与每日安排逐日对应（第 N 天 = 计划第 N 个日期）；
              {boundLessons.length > 0 ? `已生成 ${boundLessons.length} 天` : '讲义尚未生成'}
            </span>
            <button className="btn slim" onClick={() => enterCourse(boundCourse.id, null)}>进入课程总览</button>
          </div>
        )}

        {[...byDate.entries()].map(([date, items]) => {
          const lesson = lessonOfDate.get(date) ?? null;
          return (
          <section key={date} className="group">
            <div className={`group-label mono ${date === today ? 'accent' : ''}`}>
              {date === today ? `今天 · ${date}` : date}
              {boundCourse && <span className="group-day-chip">第 {dayOfDate.get(date)} 天</span>}
              <span className="group-count">{items.filter((i) => i.status === 'done').length}/{items.length}</span>
            </div>
            {boundCourse && lesson && (
              <button className="plan-day-lesson" onClick={() => enterCourse(boundCourse.id, lesson.day)} title="打开当天完整讲义与自测，返回时回到计划详情">
                <span className="plan-day-lesson-title">
                  {lesson.title}{lesson.is_sample ? '（样课）' : ''}
                </span>
                <span className="plan-day-lesson-summary">{lesson.concepts.map((c) => c.name).join(' · ') || '讲义已生成'}</span>
                <span className="plan-day-lesson-meta mono">{lesson.estimated_minutes}m · {LESSON_STATUS_LABEL[lesson.status]}</span>
                <span className="plan-day-lesson-go">阅读当天讲义 →</span>
              </button>
            )}
            {boundCourse && !lesson && (
              <div className="plan-day-pending">
                讲义待生成：当日安排按下方大纲执行；在课程总览确认样课并请求完整版后解锁
              </div>
            )}
            {items.map((it) => {
              const m = it.knowledge_key ? masteryByKey.get(it.knowledge_key) : undefined;
              return (
                <div key={it.id} className={`plan-item ${it.status}`}>
                  <button
                    className={`check ${it.status === 'done' ? 'checked' : ''}`}
                    onClick={() => void setItemStatus(it, it.status === 'done' ? 'pending' : 'done')}
                    title={it.status === 'done' ? '撤销打卡' : '打卡'}
                  >
                    {it.status === 'done' && (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                        <path d="M4 12l5 5L20 6" />
                      </svg>
                    )}
                  </button>
                  <button className="plan-item-open" onClick={() => openItem(it.id)} aria-label={`查看「${it.content}」详情`}>
                    <IconItemType type={it.item_type} className="type-icon" />
                    <span className="plan-item-content">{it.content}</span>
                    {m && <MasteryBadge status={m.mastery} title={`掌握度只看测评证据：${m.reason}（证据 ${m.evidence_count} 条，会话 ${m.session_count} 次）`} />}
                    <span className="todo-meta mono">{TYPE_LABEL[it.item_type]}{it.duration_min ? ` · ${it.duration_min}m` : ''}</span>
                    <span className="plan-item-go">详情 →</span>
                  </button>
                  {it.status === 'pending' && (
                    <button className="btn slim ghost" onClick={() => void setItemStatus(it, 'skipped')}>跳过</button>
                  )}
                </div>
              );
            })}
          </section>
          );
        })}

        {/* 学习会话记录（agent 经 MCP 写入，只读展示） */}
        {sessions.length > 0 && (
          <section className="group">
            <div className="group-label mono">学习记录<span className="group-count">{sessions.length} 次会话</span></div>
            {sessions.map((s) => (
              <div key={s.id} className="session-row">
                <div className="session-head mono">
                  {s.date} · {s.topic} · 第 {s.attempt} 次 · {s.actual_minutes}m
                </div>
                {s.explanation && <div className="session-body">我的解释：{s.explanation}</div>}
                {s.questions && <div className="session-body session-q">疑问：{s.questions}</div>}
                {s.material_source && <div className="session-meta mono">材料：{s.material_source} · 会话 {s.id}</div>}
              </div>
            ))}
          </section>
        )}

        {/* 测评证据（题目/标准/原答案/来源/纠正历史，只读展示） */}
        {assessments.length > 0 && (
          <section className="group">
            <div className="group-label mono">测评证据<span className="group-count">{assessments.length} 条</span></div>
            {assessments.map((a) => (
              <div key={a.id} className="assessment-row">
                <div className="session-head mono">
                  {a.date} · {SOURCE_LABEL[a.source]} · {a.knowledge_key}
                  {a.source === 'self' && a.score != null ? ` · 自评 ${a.score} 分` : ''}
                  {a.source === 'objective' ? ` · 判题${a.objective_passed ? '通过' : '未通过'}` : ''}
                </div>
                <div className="session-body">题目：{a.question}{a.criteria ? `（标准：${a.criteria}）` : ''}</div>
                <div className="session-body session-q">原答案：{a.answer}</div>
                {a.feedback && <div className="session-body">反馈：{a.feedback}</div>}
                {a.evidence && <div className="session-meta mono">依据：{a.evidence} · 测评 {a.id}</div>}
                {a.corrections.length > 0 && (
                  <details className="corrections">
                    <summary className="mono">纠正历史（{a.corrections.length} 次）</summary>
                    {a.corrections.map((c, i) => (
                      <div key={i} className="mono correction-entry">
                        {c.at.slice(0, 19)} · {c.from_source ?? '?'} {c.from_score ?? '—'} 分 → {c.to_source ?? '?'} {c.to_score ?? '—'} 分
                        {c.from_answer ? `（原答案：${c.from_answer}）` : ''}
                      </div>
                    ))}
                  </details>
                )}
              </div>
            ))}
          </section>
        )}

        {/* 调整建议：纯预览，应用需显式确认；关闭即取消（无变更） */}
        <section className="group">
          <div className="group-label mono">
            计划调整
            {suggestions && <span className="group-count">{suggestions.length} 条建议</span>}
          </div>
          {suggestions === null ? (
            <button className="btn slim" onClick={() => void loadSuggestions(detail.id)}>查看调整建议（仅预览）</button>
          ) : suggestions.length === 0 ? (
            <p className="sub">暂无建议：没有漏做的未完成条目，也没有掌握薄弱且缺复习的知识点。</p>
          ) : (
            <>
              {suggestions.map((s) => (
                <label key={s.id} className="suggestion-row">
                  <input
                    type="checkbox"
                    checked={picked.has(s.id)}
                    onChange={() => {
                      const next = new Set(picked);
                      if (next.has(s.id)) next.delete(s.id);
                      else next.add(s.id);
                      setPicked(next);
                    }}
                  />
                  <span className="suggestion-main">
                    <span className="suggestion-title">
                      {s.kind === 'reschedule' ? `改期 ${s.from_date} → ${s.to_date}` : `补复习（${s.to_date}）`}：{s.content}
                    </span>
                    <span className="suggestion-reason">{s.reason}</span>
                  </span>
                </label>
              ))}
              <div className="row-gap">
                <button className="btn primary" disabled={picked.size === 0} onClick={() => void applyPicked(detail.id)}>
                  应用选中（{picked.size}）
                </button>
                <button className="btn ghost" onClick={() => setSuggestions(null)}>取消（不做任何变更）</button>
              </div>
            </>
          )}
        </section>

        {/* 待审卡片：预览 → 选目录导出；取消选择即不写文件 */}
        <section className="group">
          <div className="group-label mono">
            知识卡片
            {cards && <span className="group-count">{cards.length} 张待审</span>}
          </div>
          {cards === null ? (
            <button className="btn slim" onClick={() => void loadCards(detail.id)}>预览待审卡片（不落盘）</button>
          ) : cards.length === 0 ? (
            <p className="sub">还没有学习会话，卡片由真实会话生成。</p>
          ) : (
            <>
              {cards.map((c) => (
                <details key={c.card_key} className="card-preview">
                  <summary className="mono">{c.file_name}</summary>
                  <pre>{c.markdown}</pre>
                </details>
              ))}
              <div className="row-gap">
                <button className="btn primary" onClick={() => void exportCards(detail.id)}>导出到文件夹…</button>
                <button className="btn ghost" onClick={() => setCards(null)}>收起</button>
              </div>
              {exportResult && (
                <div className={`notice ${exportResult.protected > 0 ? 'warn' : ''}`}>
                  导出目录：{exportResult.export_dir} · 写入 {exportResult.exported} / 跳过 {exportResult.skipped} / 保护 {exportResult.protected}
                  {exportResult.outcomes.filter((o) => o.result !== 'exported').map((o) => (
                    <div key={o.card_key} className="mono export-detail">{o.result === 'protected' ? '⚠ ' : ''}{o.detail}</div>
                  ))}
                </div>
              )}
            </>
          )}
        </section>

        <div className="row-gap">
          <button className="btn" onClick={() => void archive(detail.id)}>归档</button>
          <button className="btn danger" onClick={() => void remove(detail.id)}>删除</button>
        </div>
      </div>
    );
  }

  // ---------- 列表 ----------
  const datelessCount = drafts.filter((d) => d.start_date == null).length;
  const datedCount = drafts.length - datelessCount;
  return (
    <div className="panel" role="region" aria-label="学习">
      <header className="panel-head study-home-head">
        <div className="seg study-home-tabs" role="group" aria-label="学习首页视图">
          <button type="button" className={`seg-item ${homeTab === 'plans' ? 'active' : ''}`} aria-pressed={homeTab === 'plans'} onClick={() => switchHomeTab('plans')}>计划</button>
          <button type="button" className={`seg-item ${homeTab === 'courses' ? 'active' : ''}`} aria-pressed={homeTab === 'courses'} onClick={() => switchHomeTab('courses')}>课程</button>
        </div>
        <div className="head-meta mono">
          {homeTab === 'plans' ? (
            <>{plans.length} 个计划{datedCount > 0 ? ` · ${datedCount} 个待确认草案` : ''}{datelessCount > 0 ? ` · ${datelessCount} 个未排期专题` : ''}</>
          ) : `${courses.length} 门课程`}
        </div>
      </header>
      {homeTab === 'plans' ? <>
      <p className="sub">在 zcode 中对 AI 说「为某课程制定学习计划」，计划与每日待办会同步到这里。学习计划最终应关联一门课程。</p>
      {error && <div className="notice error">{error}</div>}

      {/* 待确认草案（agent 生成，用户在此确认或取消；无日期专题草案先排期再确认） */}
      {drafts.map((d) => {
        const courseTitle = d.course_id != null ? courses.find((c) => c.id === d.course_id)?.title ?? `课程 #${d.course_id}（已删除）` : null;
        const estTotal = d.knowledge_points.reduce((s, k) => s + k.est_minutes, 0);
        return (
        <div key={d.id} className="draft-card">
          <div className="plan-card-head">
            <span className="plan-title">{d.title}</span>
            <span className="plan-status mono draft">{d.start_date == null ? '未排期专题草案' : '待确认草案'}</span>
          </div>
          <div className="sub mono">
            {d.start_date == null
              ? `${d.knowledge_points.length} 个知识点 · 预计 ${estTotal}m · 日期待排期${d.material_source ? ` · ${d.material_source}` : ''}`
              : `${d.start_date} — ${d.end_date} · 每日预算 ${d.daily_minutes}m · ${d.items.length} 个条目${d.material_source ? ` · ${d.material_source}` : ''}`}
            {courseTitle ? ` · 关联课程「${courseTitle}」` : ''}
          </div>
          {d.goal && <p className="sub">{d.goal}</p>}

          {/* 无日期专题草案：知识点大纲与排期入口（不排日程、不产待办、不占预算） */}
          {d.start_date == null && (
            <>
              {d.assumptions.length > 0 && (
                <div className="notice warn draft-assumptions">
                  {d.assumptions.map((a, i) => (
                    <div key={i}>· {a}</div>
                  ))}
                </div>
              )}
              <details className="draft-schedule">
                <summary className="mono">知识点大纲（{d.knowledge_points.length}）</summary>
                {d.knowledge_points.map((k) => (
                  <div key={k.key} className="mono draft-item">
                    {k.name} · {k.est_minutes}m{k.depends_on && k.depends_on.length > 0 ? ` · 前置：${k.depends_on.join('、')}` : ''}
                    {k.outcome ? ` · 目标：${k.outcome}` : ''}
                  </div>
                ))}
              </details>
              {schedDraftId === d.id ? (
                <div className="sched-box">
                  <div className="sched-form">
                    <label className="mono">起始日期
                      <input type="date" value={schedStart} onChange={(e) => { setSchedStart(e.target.value); setSchedPreview(null); }} />
                    </label>
                    <label className="mono">每日预算（分钟）
                      <input type="number" min={10} max={600} step={10} value={schedMinutes}
                        onChange={(e) => { setSchedMinutes(Number(e.target.value)); setSchedPreview(null); }} />
                    </label>
                    <button className="btn slim" disabled={schedBusy || !schedStart} onClick={() => void previewSchedule(d)}>预览排期</button>
                    <button className="btn slim ghost" onClick={closeSchedule}>收起</button>
                  </div>
                  {schedPreview && schedPreview.draft_id === d.id && (
                    <div className="sched-preview">
                      <div className="mono sched-range">{schedPreview.start_date} — {schedPreview.end_date} · 每日 {schedPreview.daily_minutes}m · {schedPreview.items.length} 个条目</div>
                      {schedPreview.warnings.length > 0 && (
                        <div className="notice warn">
                          {schedPreview.warnings.map((w, i) => (<div key={i}>· {w}</div>))}
                        </div>
                      )}
                      {schedPreview.conflicts.length > 0 && (
                        <details className="draft-schedule">
                          <summary className="mono">与其他进行中计划的日程重叠（{schedPreview.conflicts.length} 天）</summary>
                          {schedPreview.conflicts.map((c) => (
                            <div key={c.date} className="mono draft-item">
                              {c.date} · 既有 {c.existing_minutes}m + 新排 {c.new_minutes}m / 预算 {c.daily_minutes}m{c.over_budget ? ' · 超出' : ''}
                            </div>
                          ))}
                        </details>
                      )}
                      {schedPreview.dependency_chains.some((c) => c.depends_on.length > 0) && (
                        <details className="draft-schedule">
                          <summary className="mono">依赖顺序（先修在前）</summary>
                          {schedPreview.dependency_chains.filter((c) => c.depends_on.length > 0).map((c) => (
                            <div key={c.key} className="mono draft-item">{c.name} ← {c.depends_on.join('、')}</div>
                          ))}
                        </details>
                      )}
                      {schedPreview.assumptions.length > 0 && (
                        <div className="notice warn draft-assumptions">
                          {schedPreview.assumptions.map((a, i) => (<div key={i}>· {a}</div>))}
                        </div>
                      )}
                      <details className="draft-schedule">
                        <summary className="mono">逐日安排（{schedPreview.items.length}）</summary>
                        {schedPreview.items.map((it, i) => (
                          <div key={i} className="mono draft-item">{it.date} · {TYPE_LABEL[it.item_type] ?? it.item_type} · {it.duration_min}m · {it.content}</div>
                        ))}
                      </details>
                      <div className="row-gap">
                        <button className="btn primary" disabled={schedBusy} onClick={() => void applySchedule(d)}>确认排期</button>
                        <button className="btn ghost" onClick={() => setSchedPreview(null)}>取消预览</button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="row-gap">
                  <button className="btn slim" onClick={() => openSchedule(d)}>排期…</button>
                  <button className="btn slim ghost" onClick={() => void cancelDraft(d)}>取消草案</button>
                </div>
              )}
            </>
          )}

          {/* 已排期草案：原有确认/取消流程 */}
          {d.start_date != null && d.items.length > 0 && (
            <>
              {d.assumptions.length > 0 && (
                <div className="notice warn draft-assumptions">
                  {d.assumptions.map((a, i) => (
                    <div key={i}>· {a}</div>
                  ))}
                </div>
              )}
              <details className="draft-schedule">
                <summary className="mono">逐日安排（{d.items.length}）</summary>
                {d.items.map((it, i) => (
                  <div key={i} className="mono draft-item">{it.date} · {TYPE_LABEL[it.item_type] ?? it.item_type} · {it.duration_min}m · {it.content}</div>
                ))}
              </details>
              <div className="row-gap">
                <button className="btn primary" onClick={() => void confirmDraft(d)}>确认生成计划</button>
                <button className="btn ghost" onClick={() => void cancelDraft(d)}>取消草案</button>
              </div>
            </>
          )}
        </div>
        );
      })}

      {plans.length === 0 && drafts.length === 0 && (
        <EmptyState
          icon={<IconBook width={18} height={18} />}
          title="还没有学习计划"
          hint="在 zcode 中对 AI 说「为某课程制定学习计划」，逐日安排会同步到这里，并自动生成每天的学习待办。"
        />
      )}
      {plans.map((p) => (
        <div key={p.id} className="plan-card" onClick={() => void openDetail(p.id)}>
          <div className="plan-card-head">
            <span className="plan-title">{p.title}</span>
            <span className={`plan-status mono ${p.status}`}>
              {p.status === 'active' ? '进行中' : p.status === 'done' ? '已完成' : '已归档'}
            </span>
          </div>
          <div className="sub mono">
            {p.start_date} — {p.end_date}{p.goal ? ` · ${p.goal}` : ''}
          </div>
          <div className="plan-link mono">
            {courseError ? '课程关联状态暂不可用' : courses.some((c) => c.plan_id === p.id)
              ? `关联课程：${courses.filter((c) => c.plan_id === p.id).map((c) => c.title).join('、')}`
              : '待关联课程'}
          </div>
          <div className="progress"><div style={{ width: `${Math.round(p.progress * 100)}%` }} /></div>
        </div>
      ))}
      </> : <>
      <p className="sub">课程由 AI 导入样课；与学习计划关联后，可从计划详情按天阅读讲义。</p>
      {courseError && <div className="notice error">{courseError}</div>}
      <section className="group">
        {courses.length === 0 && !courseError && (
          <EmptyState icon={<IconBook width={18} height={18} />} title="还没有课程" hint="在 zcode 中对 AI 说「导入 XX 样课课程包」，课程会显示在这里。" />
        )}
        {courses.map((c) => (
          <div key={c.id} className="plan-card plan-course-entry" onClick={() => enterCourse(c.id, null)}>
            <div className="plan-card-head">
              <span className="plan-title">{c.title}</span>
              <span className="plan-status mono">{COURSE_STATUS_LABEL[c.status]}</span>
            </div>
            <div className="sub mono">
              {c.slug}{c.plan_id != null
                ? ` · 关联计划「${plans.find((p) => p.id === c.plan_id)?.title ?? '计划已删除'}」`
                : ' · 未关联计划'}
            </div>
          </div>
        ))}
      </section>
      </>}
    </div>
  );
}
