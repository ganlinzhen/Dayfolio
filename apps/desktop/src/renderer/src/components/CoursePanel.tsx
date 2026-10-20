// 课程面板（内嵌组件）：无独立侧栏入口，由「学习计划」面板承载。
// 独立课程总览（不计入日课）→ 每日卡片（日期/第几天/主题/概要/时长/状态）
// → 讲义阅读（消毒 HTML iframe sandbox + CSP 渲染）+ 源码导读 + 自测答题 + 样课确认。
// 绑定计划的课程按计划大纲补齐未生成天（「待生成」卡，显示当日计划安排），总数为计划天数。
// App 负责阅读；样课确认与完整版生成意愿在对话中表达，agent 经 MCP 记录并处理。
// 支持从计划详情的每日摘要卡直达某天讲义：该天返回按钮直接退出到上层（不经过总览）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, call } from '../api';
import EmbeddedFrame from './EmbeddedFrame';
import { IconChevronLeft } from './icons';
import { toast } from './Toast';
import { courseHtmlDocument } from './courseHtmlDocument';
import { LessonMaterial, LessonQuiz, type LessonRow } from './StudyLesson';

interface CourseRow {
  id: number; slug: string; title: string; goal: string;
  status: 'imported' | 'sample_confirmed' | 'generating' | 'complete';
  plan_id: number | null; sample_content_hash: string | null; sample_confirmed_at: string | null; version: string;
}
interface RequestRow { id: number; course_id: number; status: string; created_at: string; error: string | null }
/** 绑定计划的逐日大纲（用于渲染未生成天的「待生成」卡：第 N 天 = 计划第 N 个日期） */
interface PlanOutlineDay { day: number; date: string; summary: string }

/** 内嵌导航目标：courseId 定位课程；day 非 null 时直达该天讲义（返回直接回到上层） */
export interface CourseNavTarget { courseId: number; day?: number | null }

export const COURSE_STATUS_LABEL: Record<string, string> = {
  imported: '样课待确认', sample_confirmed: '样课已确认', generating: '完整版生成中', complete: '完整版已就绪',
};
const STATUS_LABEL = COURSE_STATUS_LABEL;
const LESSON_STATUS: Record<string, string> = { pending: '待生成', generated: '可阅读', read: '已读' };

export default function CoursePanel({ target, exitLabel, onExit }: { target: CourseNavTarget; exitLabel: string; onExit: () => void }) {
  const [courses, setCourses] = useState<CourseRow[]>([]);
  const [selected, setSelected] = useState<CourseRow | null>(null);
  const [lessons, setLessons] = useState<LessonRow[]>([]);
  const [overview, setOverview] = useState<{ html: string } | null>(null);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [reading, setReading] = useState<{ lesson: LessonRow; html: string } | null>(null);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  // 目标课程不存在（已被删除等）：给可返回的兜底视图，不影响计划数据
  const [missing, setMissing] = useState(false);
  // 直达讲义标记：正在阅读的这一天若来自上层直达，返回按钮直接退出到上层（不回总览）
  const [directDay, setDirectDay] = useState<number | null>(null);
  // 绑定计划的逐日大纲（无绑定或加载失败为 null——此时不显示待生成卡）
  const [planOutline, setPlanOutline] = useState<PlanOutlineDay[] | null>(null);

  // 总览 ↔ 讲义的滚动位置记忆：进入讲义前记录总览滚动，返回总览后恢复原位
  const overviewScrollRef = useRef(0);
  const restoreOverviewRef = useRef(false);

  const refresh = useCallback(async () => {
    const [list, reqs] = await Promise.all([
      call<CourseRow[]>(() => api.courses.list()),
      call<RequestRow[]>(() => api.courses.listRequests({})),
    ]);
    setCourses(list);
    setRequests(reqs);
    return list;
  }, []);

  // 挂载即按 target 打开：定位课程 → 总览；（day 非 null 时）直达该天讲义。
  // 组件由父级按导航 key 重挂载，target 只在挂载时消费一次——不存在焦点残留重复消费的问题
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await refresh();
        if (cancelled) return;
        const c = list.find((x) => x.id === target.courseId) ?? null;
        if (!c) { setMissing(true); return; }
        await openCourse(c);
        if (cancelled) return;
        if (target.day != null) {
          setDirectDay(target.day);
          await openLesson(c.id, target.day);
        }
      } catch (e) {
        setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时执行一次（父级用 key 重挂载来重新导航）
  }, []);

  useEffect(() => {
    if (!reading && !overviewOpen && restoreOverviewRef.current) {
      restoreOverviewRef.current = false;
      const el = document.querySelector<HTMLElement>('.content');
      if (el) el.scrollTop = overviewScrollRef.current;
    }
  }, [reading, overviewOpen]);

  const openCourse = async (c: CourseRow) => {
    setSelected(c);
    setLessons(await call<LessonRow[]>(() => api.courses.lessons({ course_id: c.id })));
    try {
      setOverview(await call<{ html: string } | null>(() => api.courses.overviewHtml({ course_id: c.id })));
    } catch (e) {
      setOverview(null);
      setError(`课程总览无法读取：${(e as Error).message}`);
    }
    // 绑定计划：取逐日大纲，未生成天从大纲渲染「待生成」卡（第 N 天 = 计划第 N 个日期）
    const planId = c.plan_id;
    if (planId != null) {
      try {
        const plan = await call<{ items: Array<{ date: string; content: string }> }>(() => api.plans.get({ id: planId }));
        const dates = [...new Set(plan.items.map((i) => i.date))].sort();
        setPlanOutline(dates.map((d, i) => ({
          day: i + 1,
          date: d,
          summary: plan.items.filter((i) => i.date === d).map((i) => i.content).join('；'),
        })));
      } catch {
        setPlanOutline(null); // 计划已删或加载失败：只显示已生成天
      }
    } else {
      setPlanOutline(null);
    }
  };

  // 用户在对话中确认或生成后，切回 App 即同步状态，不打断当前阅读和答题。
  useEffect(() => {
    let cancelled = false;
    let loading = false;
    const sync = async () => {
      if (document.hidden || loading) return;
      loading = true;
      try {
        const [list, reqs, currentLessons, currentOverview] = await Promise.all([
          call<CourseRow[]>(() => api.courses.list()),
          call<RequestRow[]>(() => api.courses.listRequests({})),
          call<LessonRow[]>(() => api.courses.lessons({ course_id: target.courseId })),
          call<{ html: string } | null>(() => api.courses.overviewHtml({ course_id: target.courseId })),
        ]);
        if (cancelled) return;
        const current = list.find((c) => c.id === target.courseId);
        if (!current) { setMissing(true); return; }
        setCourses(list);
        setRequests(reqs);
        setSelected(current);
        setLessons(currentLessons);
        setOverview(currentOverview);
      } catch (e) {
        if (!cancelled) setError(`课程状态同步失败：${(e as Error).message}`);
      } finally {
        loading = false;
      }
    };
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [target.courseId]);

  const openLesson = async (courseId: number, day: number) => {
    const r = await call<{ lesson: LessonRow; html: string }>(() => api.courses.lessonHtml({ course_id: courseId, day }));
    setReading(r);
    void call(() => api.courses.markRead({ course_id: courseId, day })).then(() => {
      setLessons((prevLessons) => prevLessons.map((l) => (l.day === day ? { ...l, status: 'read' } : l)));
    }).catch(() => { /* 已读标记失败不阻塞阅读 */ });
  };

  // 从总览每日卡片进入讲义：返回时回总览并恢复总览滚动位置
  const openLessonFromCard = async (day: number) => {
    if (!selected) return;
    const el = document.querySelector<HTMLElement>('.content');
    if (el) overviewScrollRef.current = el.scrollTop;
    restoreOverviewRef.current = true;
    setDirectDay(null);
    await openLesson(selected.id, day);
  };

  const openOverview = () => {
    if (!overview) return;
    const el = document.querySelector<HTMLElement>('.content');
    if (el) overviewScrollRef.current = el.scrollTop;
    restoreOverviewRef.current = true;
    setOverviewOpen(true);
    if (el) el.scrollTop = 0;
  };

  // 讲义返回：直达进入（来自计划摘要卡）→ 退出到上层；否则回课程总览
  const backFromLesson = () => {
    if (directDay != null) { onExit(); return; }
    setReading(null);
  };

  const backFromOverview = () => {
    setOverviewOpen(false);
  };

  const deleteCourse = async () => {
    if (!selected || deleting) return;
    if (!window.confirm(`永久删除课程「${selected.title}」？\n将删除总览、${lessons.length} 节讲义、阅读与自测记录、生成请求和课程资产，不可恢复。学习计划和待办需单独删除。`)) return;
    setDeleting(true);
    try {
      const result = await call<{ assets_removed: boolean; cleanup_warning?: string }>(() => api.courses.remove({ course_id: selected.id, expected_slug: selected.slug }));
      toast(result.cleanup_warning ?? '课程已删除');
      onExit();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  // ---------- 独立课程总览正文（不占 D1，也不改变日课进度） ----------
  if (overviewOpen && overview && selected) {
    return (
      <div className="panel">
        <button className="backlink" onClick={backFromOverview}>
          <IconChevronLeft width={14} height={14} /> 返回课程
        </button>
        <EmbeddedFrame
          label={`${selected.title}课程总览`}
          className="course-embed"
          title="课程总览"
          meta={`${selected.title} · 独立内容`}
        >
          <iframe className="course-lesson-frame" sandbox="" title={`${selected.title}课程总览`} srcDoc={courseHtmlDocument(overview.html)} />
        </EmbeddedFrame>
      </div>
    );
  }

  // ---------- 讲义阅读视图 ----------
  if (reading && selected) {
    const l = reading.lesson;
    return (
      <div className="panel">
        <button className="backlink" onClick={backFromLesson}>
          <IconChevronLeft width={14} height={14} /> {directDay != null ? exitLabel : '返回课程总览'}
        </button>
        {l.is_sample && !selected.sample_confirmed_at && <div className="notice course-sample-notice">这是样课：看完后回到对话，告诉助手「样课确认，继续生成完整版」即可。确认绑定当前内容版本。</div>}

        <LessonMaterial lesson={l} html={reading.html} />
        {l.quiz.length > 0 && <section className="group">
          <div className="group-label mono">自测</div>
          <LessonQuiz key={`${l.id}-${l.revision}`} courseId={selected.id} lesson={l} />
        </section>}

      </div>
    );
  }

  // ---------- 单课程总览（每日卡片） ----------
  if (selected) {
    const pendingReq = requests.find((r) => r.course_id === selected.id && (r.status === 'pending' || r.status === 'claimed'));
    const readCount = lessons.filter((l) => l.status === 'read').length;
    // 每日卡片：已生成与待生成按 day 升序混排（缺口天按真实位置插入，不排到末尾）
    const pendingDays = (planOutline ?? []).filter((o) => !lessons.some((l) => l.day === o.day));
    const dayCards = [
      ...lessons.map((l) => ({ kind: 'lesson' as const, day: l.day, lesson: l })),
      ...pendingDays.map((o) => ({ kind: 'pending' as const, day: o.day, outline: o })),
    ].sort((a, b) => a.day - b.day);
    return (
      <div className="panel">
        <button className="backlink" onClick={onExit}>
          <IconChevronLeft width={14} height={14} /> {exitLabel}
        </button>
        <header className="panel-head">
          <h1>{selected.title}</h1>
          <div className="head-meta mono">
            {STATUS_LABEL[selected.status]} · 已读讲义 {readCount}/{lessons.length}
            {planOutline ? ` · 计划 ${planOutline.length} 天` : ''}
            <button className="btn ghost slim course-delete-button" disabled={deleting} onClick={() => void deleteCourse()}>{deleting ? '删除中…' : '删除课程'}</button>
          </div>
        </header>
        <p className="sub">{selected.goal}</p>
        {selected.plan_id != null && <p className="sub mono">关联学习计划 #{selected.plan_id}（进度与打卡互不影响）</p>}
        {error && <div className="notice error" onClick={() => setError('')}>{error}</div>}

        {selected.status === 'imported' && lessons.some((l) => l.is_sample) && (
          <div className="notice course-confirm-bar">
            <span>{lessons.some((l) => l.is_sample && l.status === 'read')
              ? '看完样课后，在对话中告诉助手「样课确认，继续生成完整版」即可。'
              : '请先打开标有「样课」的讲义阅读，看完后回到对话确认。'}</span>
          </div>
        )}
        {selected.status === 'sample_confirmed' && !pendingReq && (
          <div className="notice course-confirm-bar">
            <span>样课已确认。需要完整版时，在对话中告诉助手「继续生成完整版」即可。</span>
          </div>
        )}
        {pendingReq && (
          <div className="notice course-confirm-bar">
            {pendingReq.status === 'pending' ? '完整版待生成：在对话中告诉助手「继续生成完整版」即可。' : '助手正在生成完整版，完成后可在这里阅读。'}
            {pendingReq.error && ` · ${pendingReq.error}`}
          </div>
        )}

        <section className="group">
          <div className="group-label mono">课程总览<span className="group-count">独立内容</span></div>
          {overview ? (
            <button className="course-card course-overview-entry" onClick={openOverview}>
              <span className="course-card-day mono">总览</span>
              <span className="course-card-main">
                <span className="course-card-title">{selected.title} · 课程总览</span>
                <span className="course-card-summary">{selected.goal || '学习目标与课程路线'}</span>
              </span>
              <span className="course-card-meta mono">阅读总览 →</span>
            </button>
          ) : (
            <div className="course-card pending course-overview-entry">
              <span className="course-card-day mono">总览</span>
              <span className="course-card-main">
                <span className="course-card-title">课程总览待生成</span>
                <span className="course-card-summary">请让 AI 单独生成总览并重新导入课程包；旧 D1 内容不会自动拆分。</span>
              </span>
              <span className="course-card-meta mono">待生成</span>
            </div>
          )}
        </section>

        <section className="group">
          <div className="group-label mono">
            每日课程
            <span className="group-count">
              {lessons.length}{planOutline ? `/${planOutline.length}` : ''} 天
              {planOutline && planOutline.length > lessons.length ? `（${planOutline.length - lessons.length} 天待生成）` : ''}
            </span>
          </div>
          {dayCards.map((card) =>
            card.kind === 'lesson' ? (
              <button key={`l-${card.lesson.id}`} className={`course-card ${card.lesson.status === 'read' ? 'read' : ''}`} onClick={() => void openLessonFromCard(card.lesson.day)}>
                <span className="course-card-day mono">{card.lesson.day === 0 ? '样' : `D${card.lesson.day}`}</span>
                <span className="course-card-main">
                  <span className="course-card-title">{card.lesson.title}{card.lesson.is_sample && !selected.sample_confirmed_at && <em className="course-sample-badge">样课</em>}</span>
                  <span className="course-card-summary">{card.lesson.concepts.map((c) => c.name).join(' · ') || '点击进入阅读'}</span>
                </span>
                <span className="course-card-meta mono"><span className="course-lesson-version">v{card.lesson.revision}</span> · {card.lesson.estimated_minutes}m · {LESSON_STATUS[card.lesson.status]}</span>
              </button>
            ) : (
              /* 未生成的天：从绑定计划的大纲推导，按 day 位置混排，显示当日安排与「待生成」 */
              <div key={`pending-${card.outline.day}`} className="course-card pending" title="讲义尚未生成：完整版生成后解锁">
                <span className="course-card-day mono">D{card.outline.day}</span>
                <span className="course-card-main">
                  <span className="course-card-title">{card.outline.summary || `第 ${card.outline.day} 天安排`}</span>
                  <span className="course-card-summary">计划 {card.outline.date} 的当日安排 · 讲义待完整版生成后解锁</span>
                </span>
                <span className="course-card-meta mono">待生成</span>
              </div>
            ),
          )}
          {lessons.length === 0 && !planOutline && <div className="empty">尚无讲义（待生成）</div>}
        </section>
      </div>
    );
  }

  // ---------- 目标课程不存在 / 加载中 ----------
  return (
    <div className="panel">
      <button className="backlink" onClick={onExit}>
        <IconChevronLeft width={14} height={14} /> {exitLabel}
      </button>
      {missing ? (
        <>
          <div className="notice error">课程不存在或已被删除（计划与学习进度不受影响）。</div>
        </>
      ) : (
        <p className="sub">正在打开课程…</p>
      )}
    </div>
  );
}
