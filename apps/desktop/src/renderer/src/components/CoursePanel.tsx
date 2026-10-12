// 课程面板（内嵌组件）：无独立侧栏入口，由「学习计划」面板承载。
// 独立课程总览（不计入日课）→ 每日卡片（日期/第几天/主题/概要/时长/状态）
// → 讲义阅读（消毒 HTML iframe sandbox + CSP 渲染）+ 源码导读 + 自测答题 + 样课确认。
// 绑定计划的课程按计划大纲补齐未生成天（「待生成」卡，显示当日计划安排），总数为计划天数。
// 样课确认后出现「请求完整版」按钮（生成排队，agent 经 MCP 处理）；未确认不可请求。
// 支持从计划详情的每日摘要卡直达某天讲义：该天返回按钮直接退出到上层（不经过总览）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, call } from '../api';
import EmbeddedFrame from './EmbeddedFrame';
import { IconChevronLeft } from './icons';
import { toast } from './Toast';

interface CourseRow {
  id: number; slug: string; title: string; goal: string;
  status: 'imported' | 'sample_confirmed' | 'generating' | 'complete';
  plan_id: number | null; sample_content_hash: string | null; sample_confirmed_at: string | null; version: string;
}
interface LessonRow {
  id: number; day: number; title: string; is_sample: boolean;
  status: 'pending' | 'generated' | 'read'; estimated_minutes: number;
  concepts: Array<{ name: string; explanation: string }>;
  code_refs: Array<{ path: string; symbol: string; role: string; order: number }>;
  quiz: Array<{ id: string; question: string; options: string[]; answer_index: number; explanation: string }>;
  quiz_answers: Array<{ question_id: string; picked: number; at: string }>;
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
// 讲义正文 CSP：外部资源一律不加载（default-src 'none'，仅放行内联样式）——
// 与导入消毒（中和 http/https/协议相对 src、删 srcset）构成双保险
const LESSON_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`;
const courseHtmlDocument = (html: string) => `<!doctype html><html><head><meta charset="utf-8">${LESSON_CSP}<style>body{font-family:-apple-system,'PingFang SC',sans-serif;line-height:1.8;padding:24px;max-width:76ch;margin:0 auto;color:#1a1a19}h1,h2,h3{line-height:1.4}pre{background:#f5f4f0;padding:12px;border-radius:8px;overflow-x:auto}table{border-collapse:collapse}td,th{border:1px solid #e8e7e3;padding:6px 10px}</style></head><body>${html}</body></html>`;

export default function CoursePanel({ target, exitLabel, onExit }: { target: CourseNavTarget; exitLabel: string; onExit: () => void }) {
  const [courses, setCourses] = useState<CourseRow[]>([]);
  const [selected, setSelected] = useState<CourseRow | null>(null);
  const [lessons, setLessons] = useState<LessonRow[]>([]);
  const [overview, setOverview] = useState<{ html: string } | null>(null);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [reading, setReading] = useState<{ lesson: LessonRow; html: string } | null>(null);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [showAnswers, setShowAnswers] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
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

  const openLesson = async (courseId: number, day: number) => {
    const r = await call<{ lesson: LessonRow; html: string }>(() => api.courses.lessonHtml({ course_id: courseId, day }));
    setReading(r);
    setShowAnswers(false);
    const prev: Record<string, number> = {};
    for (const a of r.lesson.quiz_answers) prev[a.question_id] = a.picked;
    setAnswers(prev);
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

  const submitQuiz = async () => {
    if (!reading || !selected) return;
    const arr = Object.entries(answers).map(([question_id, picked]) => ({ question_id, picked }));
    if (arr.length === 0) { toast('请先作答'); return; }
    await call(() => api.courses.submitQuiz({ course_id: selected.id, day: reading.lesson.day, answers: arr }));
    toast('答案已记录（学习痕迹，非掌握证据）');
    setShowAnswers(true);
  };

  const confirmSample = async () => {
    if (!selected) return;
    if (!window.confirm(`确认样课「${lessons.find((l) => l.is_sample)?.title ?? ''}」？\n确认将绑定当前样课内容版本；样课内容变更后确认过期，需重新确认。确认后才能请求完整版课程。`)) return;
    setConfirming(true);
    try {
      await call(() => api.courses.confirmSample({ course_id: selected.id }));
      await refresh();
      await openCourse({ ...selected, status: 'sample_confirmed' });
      toast('样课已确认（绑定内容版本）——现在可以请求完整版了');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setConfirming(false);
    }
  };

  const requestFull = async () => {
    if (!selected) return;
    if (!window.confirm('请求生成完整版课程？\n请求将进入待执行队列，由 AI agent 认领处理（App 本身不生成内容）；生成完成后再导入。')) return;
    try {
      await call(() => api.courses.createRequest({ course_id: selected.id }));
      await refresh();
      toast('完整版生成请求已排队（待 agent 处理）');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // ---------- 独立课程总览正文（不占 D1，也不改变日课进度） ----------
  if (overviewOpen && overview && selected) {
    return (
      <div className="panel">
        <button className="backlink" onClick={backFromOverview}>
          <IconChevronLeft width={14} height={14} /> 返回课程
        </button>
        <header className="panel-head">
          <h1>课程总览</h1>
          <div className="head-meta mono">{selected.title} · 独立内容</div>
        </header>
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
    const answeredCount = Object.keys(answers).length;
    return (
      <div className="panel">
        <button className="backlink" onClick={backFromLesson}>
          <IconChevronLeft width={14} height={14} /> {directDay != null ? exitLabel : '返回课程总览'}
        </button>
        <header className="panel-head">
          <h1>{l.title}</h1>
          <div className="head-meta mono">第 {l.day} 天 · {l.estimated_minutes} 分钟 · {LESSON_STATUS[l.status]}</div>
        </header>
        {l.is_sample && <div className="notice">这是样课：阅读并确认后才能请求完整版课程（确认绑定当前内容版本）</div>}

        {/* 消毒 HTML 正文：iframe sandbox + CSP 双保险（导入时已剥 script/事件/危险协议并中和外部资源） */}
        <EmbeddedFrame
          label={`${l.title}讲义`}
          className="course-embed"
          title={l.title}
          meta={`第 ${l.day} 天 · ${l.estimated_minutes} 分钟 · ${LESSON_STATUS[l.status]}`}
        >
          <iframe
            className="course-lesson-frame"
            sandbox=""
            title={l.title}
            srcDoc={courseHtmlDocument(reading.html)}
          />
        </EmbeddedFrame>

        {l.concepts.length > 0 && (
          <section className="group">
            <div className="group-label mono">核心概念</div>
            {l.concepts.map((c) => (
              <div key={c.name} className="session-row">
                <strong>{c.name}</strong>
                <div className="session-body">{c.explanation}</div>
              </div>
            ))}
          </section>
        )}

        {l.code_refs.length > 0 && (
          <section className="group">
            <div className="group-label mono">源码导读（文本参考，不执行任何命令）</div>
            {l.code_refs.sort((a, b) => a.order - b.order).map((c) => (
              <div key={`${c.path}:${c.symbol}`} className="session-row">
                <span className="mono">{c.path}</span>
                <strong>{c.symbol}</strong>
                <span className="session-body">{c.role}</span>
              </div>
            ))}
          </section>
        )}

        {l.quiz.length > 0 && (
          <section className="group">
            <div className="group-label mono">自测（{answeredCount}/{l.quiz.length} 已作答 · 学习痕迹，非掌握证据）</div>
            {l.quiz.map((q, qi) => (
              <div key={q.id} className="course-quiz">
                <div className="course-quiz-q">{qi + 1}. {q.question}</div>
                {q.options.map((opt, oi) => (
                  <label key={oi} className={`course-quiz-opt ${showAnswers && oi === q.answer_index ? 'correct' : ''} ${showAnswers && answers[q.id] === oi && oi !== q.answer_index ? 'wrong' : ''}`}>
                    <input
                      type="radio"
                      name={q.id}
                      checked={answers[q.id] === oi}
                      onChange={() => setAnswers((prev) => ({ ...prev, [q.id]: oi }))}
                    />
                    {opt}
                    {showAnswers && oi === q.answer_index && ' ✓'}
                  </label>
                ))}
                {showAnswers && <div className="course-quiz-expl">解析：{q.explanation}</div>}
              </div>
            ))}
            <div className="row-gap">
              <button className="btn primary" onClick={() => void submitQuiz()}>提交答案</button>
              <button className="btn ghost" onClick={() => setShowAnswers((v) => !v)}>{showAnswers ? '隐藏解析' : '显示解析（提交后）'}</button>
            </div>
          </section>
        )}
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
          </div>
        </header>
        <p className="sub">{selected.goal}</p>
        {selected.plan_id != null && <p className="sub mono">关联学习计划 #{selected.plan_id}（进度与打卡互不影响）</p>}
        {error && <div className="notice error" onClick={() => setError('')}>{error}</div>}

        {selected.status === 'imported' && lessons.some((l) => l.is_sample) && (
          <div className="notice course-confirm-bar">
            <span>样课待确认：请先阅读样课（标有「样课」的卡片），确认后才能请求完整版。</span>
            <button className="btn primary slim" disabled={confirming || !lessons.find((l) => l.is_sample && l.status === 'read')} onClick={() => void confirmSample()}>
              {confirming ? '确认中…' : '确认样课（绑定版本）'}
            </button>
            {!lessons.find((l) => l.is_sample && l.status === 'read') && <span className="mono">（先阅读样课后解锁确认）</span>}
          </div>
        )}
        {selected.status === 'sample_confirmed' && !pendingReq && (
          <div className="notice course-confirm-bar">
            <span>样课已确认（{selected.sample_confirmed_at?.slice(0, 10)} 绑定版本 {selected.sample_content_hash?.slice(0, 8)}…）。可请求完整版：</span>
            <button className="btn primary slim" onClick={() => void requestFull()}>请求完整版（排队待生成）</button>
          </div>
        )}
        {pendingReq && (
          <div className="notice course-confirm-bar">
            完整版生成请求 #{pendingReq.id} · {pendingReq.status === 'pending' ? '待执行（等待 AI agent 认领处理，App 不自带生成模型）' : `agent 处理中`}
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
                  <span className="course-card-title">{card.lesson.title}{card.lesson.is_sample && <em className="course-sample-badge">样课</em>}</span>
                  <span className="course-card-summary">{card.lesson.concepts.map((c) => c.name).join(' · ') || '点击进入阅读'}</span>
                </span>
                <span className="course-card-meta mono">{card.lesson.estimated_minutes}m · {LESSON_STATUS[card.lesson.status]}</span>
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
          <header className="panel-head"><h1>课程</h1></header>
          <div className="notice error">课程不存在或已被删除（计划与学习进度不受影响）。</div>
        </>
      ) : (
        <p className="sub">正在打开课程…</p>
      )}
    </div>
  );
}
