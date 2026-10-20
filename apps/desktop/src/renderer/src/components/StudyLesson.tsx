import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, call } from '../api';
import EmbeddedFrame from './EmbeddedFrame';
import { courseHtmlDocument } from './courseHtmlDocument';
import { toast } from './Toast';

export interface LessonRow {
  id: number; day: number; title: string; is_sample: boolean; revision: number;
  status: 'pending' | 'generated' | 'read'; estimated_minutes: number;
  concepts: Array<{ name: string; explanation: string }>;
  code_refs: Array<{ path: string; symbol: string; role: string; order: number }>;
  quiz: Array<{ id: string; question: string; options: string[]; answer_index: number; explanation: string }>;
  quiz_answers: Array<{ question_id: string; picked: number; at: string }>;
}

/** 课程阅读页与计划学习详情共用同一份受限讲义和教学资料。 */
export function LessonMaterial({ lesson, html, onRead }: { lesson: LessonRow; html: string; onRead?: () => void }) {
  return <>
    <EmbeddedFrame label={`${lesson.title}讲义`} className="course-embed" title={lesson.title}
      meta={`第 ${lesson.day} 天 · v${lesson.revision} · ${lesson.estimated_minutes} 分钟 · ${lesson.status === 'read' ? '已读' : '可阅读'}`}>
      <iframe className="course-lesson-frame" sandbox="" title={lesson.title} srcDoc={courseHtmlDocument(html)} onLoad={onRead} />
    </EmbeddedFrame>
    {lesson.concepts.length > 0 && <section className="group">
      <div className="group-label mono">核心概念</div>
      {lesson.concepts.map(c => <div key={c.name} className="session-row"><strong>{c.name}</strong><div className="session-body">{c.explanation}</div></div>)}
    </section>}
    {lesson.code_refs.length > 0 && <section className="group">
      <div className="group-label mono">源码导读（文本参考，不执行任何命令）</div>
      {[...lesson.code_refs].sort((a, b) => a.order - b.order).map(c => <div key={`${c.path}:${c.symbol}`} className="session-row">
        <span className="mono">{c.path}</span><strong>{c.symbol}</strong><span className="session-body">{c.role}</span>
      </div>)}
    </section>}
  </>;
}

/** 自测提交沿用课程业务入口，未提交的选择不计入学习进度。 */
export function LessonQuiz({ courseId, lesson, onSaved }: { courseId: number; lesson: LessonRow; onSaved?: () => void }) {
  const [answers, setAnswers] = useState<Record<string, number>>(() => Object.fromEntries(lesson.quiz_answers.map(a => [a.question_id, a.picked])));
  const [showAnswers, setShowAnswers] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const saving = useRef(false);
  const submit = async () => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true); setError('');
    try {
      await call(() => api.courses.submitQuiz({ course_id: courseId, day: lesson.day,
        answers: Object.entries(answers).map(([question_id, picked]) => ({ question_id, picked })) }));
      setSubmitted(true); setShowAnswers(true);
      toast('答案已记录（学习痕迹，非掌握证据）');
      onSaved?.();
    } catch (e) { setError(`答案未能保存：${(e as Error).message}`); }
    finally { saving.current = false; setBusy(false); }
  };
  if (!lesson.quiz.length) return <p className="sub">当天课件没有自测题，可使用「AI 检验学习成果」逐题对话。</p>;
  return <div className="lesson-quiz">
    <p className="sub">自测（{Object.keys(answers).length}/{lesson.quiz.length} 已作答 · 提交后计入学习痕迹，非掌握证据）</p>
    {lesson.quiz.map((q, qi) => <fieldset key={q.id} className="course-quiz" disabled={busy}>
      <legend className="course-quiz-q">{qi + 1}. {q.question}</legend>
      {q.options.map((opt, oi) => <label key={oi} className={`course-quiz-opt ${showAnswers && oi === q.answer_index ? 'correct' : ''} ${showAnswers && answers[q.id] === oi && oi !== q.answer_index ? 'wrong' : ''}`}>
        <input type="radio" name={`course-${courseId}-day-${lesson.day}-${q.id}`} checked={answers[q.id] === oi}
          onChange={() => { setAnswers(prev => ({ ...prev, [q.id]: oi })); setShowAnswers(false); setSubmitted(false); }} />
        {opt}{showAnswers && oi === q.answer_index && ' ✓'}
      </label>)}
      {showAnswers && <div className="course-quiz-expl">解析：{q.explanation}</div>}
    </fieldset>)}
    <div className="row-gap">
      <button className="btn primary" disabled={busy || Object.keys(answers).length === 0} onClick={() => void submit()}>{busy ? '正在提交…' : '提交答案'}</button>
      {submitted && <button className="btn ghost" onClick={() => setShowAnswers(v => !v)}>{showAnswers ? '隐藏解析' : '显示解析'}</button>}
    </div>
    {error && <p className="notice error" role="alert">{error}</p>}
  </div>;
}

/** 直接在安排详情读取课件与自测；重试和卸载保护不影响笔记或完成操作。 */
export function PlanLessonContent({ courseId, day, onChanged, children }: {
  courseId: number; day: number; onChanged: () => void; children?: ReactNode;
}) {
  const [reading, setReading] = useState<{ lesson: LessonRow; html: string } | null>(null);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [retry, setRetry] = useState(0);
  const marked = useRef(false);
  const active = useRef(false);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  useEffect(() => {
    let cancelled = false;
    active.current = true;
    setError(''); setReading(null); marked.current = false;
    void call<{ lesson: LessonRow; html: string }>(() => api.courses.lessonHtml({ course_id: courseId, day }))
      .then(r => { if (!cancelled) setReading(r); })
      .catch(e => { if (!cancelled) setError(`课件未能加载：${(e as Error).message}`); });
    return () => { cancelled = true; active.current = false; };
  }, [courseId, day, retry]);
  const markRead = async () => {
    if (marked.current || !reading || reading.lesson.status === 'read') return;
    marked.current = true;
    try {
      await call(() => api.courses.markRead({ course_id: courseId, day }));
      if (!active.current) return;
      setReadError('');
      setReading(prev => prev ? { ...prev, lesson: { ...prev.lesson, status: 'read' } } : prev);
      changed.current();
    } catch (e) {
      marked.current = false;
      if (active.current) setReadError(`阅读状态未能保存：${(e as Error).message}`);
    }
  };
  return <>
    <section id="learning-materials" className="group learning-detail-section">
      <h2>课件</h2>
      {error ? <div className="notice error" role="alert">{error}<button className="btn slim" onClick={() => setRetry(v => v + 1)}>重试加载</button></div>
        : reading ? <LessonMaterial lesson={reading.lesson} html={reading.html} onRead={() => void markRead()} />
          : <p className="sub" role="status">正在加载课件…</p>}
      {readError && <div className="notice error" role="alert">{readError}<button className="btn slim" onClick={() => void markRead()}>重试保存已读</button></div>}
    </section>
    <section id="learning-assessments" className="group learning-detail-section">
      <h2>评测</h2>
      {reading ? <LessonQuiz key={`${reading.lesson.id}-${reading.lesson.revision}`} courseId={courseId} lesson={reading.lesson} onSaved={() => changed.current()} />
        : <p className="sub">{error ? '课件加载成功后可在这里自测。' : '正在加载自测…'}</p>}
      {children}
    </section>
  </>;
}
