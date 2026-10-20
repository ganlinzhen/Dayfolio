import { useEffect, useRef, useState } from 'react';
import { api, call } from '../api';
import { toast } from './Toast';
import { buildStudyPrompt, type StudyPromptContext } from './studyPrompt';
import type { ItemLearningProgress, PlanLearningProgress } from '../../../../../../packages/core/src/services/study-progress';

export function LearningTotals({ progress }: { progress?: PlanLearningProgress }) {
  if (!progress) return <p className="sub learning-loading">学习进度暂不可用</p>;
  return <div className="learning-totals" aria-label="学习进度">
    <span>课件已读 <b>{progress.read_items}/{progress.total_items}</b></span>
    <span>评测已做 <b>{progress.assessed_items}/{progress.total_items}</b></span>
    <span>笔记已输出 <b>{progress.noted_items}/{progress.total_items}</b></span>
  </div>;
}

export function LearningSignals({ progress }: { progress?: ItemLearningProgress }) {
  if (!progress) return <span className="sub">进度暂不可用</span>;
  const quizDone = progress.quiz_total > 0 && progress.quiz_answered === progress.quiz_total;
  const assessed = quizDone || progress.assessment_count > 0;
  return <div className="learning-signals" aria-label="条目学习进度">
    <span className={progress.lesson_status === 'read' ? 'is-done' : ''}>{progress.lesson_status === 'read' ? '✓ 课件已读' : progress.lesson_status === 'unbound' ? '课件未关联' : progress.lesson_status === 'pending' ? '课件待生成' : '课件待阅读'}</span>
    <span className={assessed ? 'is-done' : ''}>{assessed ? '✓ 评测已做' : progress.quiz_total > 0 ? `评测 ${progress.quiz_answered}/${progress.quiz_total}` : '评测待进行'}</span>
    <span className={progress.note_count > 0 ? 'is-done' : ''}>{progress.note_count > 0 ? `✓ 笔记 ${progress.note_count} 篇` : '笔记待输出'}</span>
  </div>;
}

export function AiStudyAction({ context, disabled = false }: { context: StudyPromptContext; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const prompt = buildStudyPrompt(context);
  const copy = async () => {
    setBusy(true); setError('');
    try {
      await call(() => api.study.copyPrompt({ text: prompt }));
      setCopied(true);
      toast('提示词已复制，粘贴到已连接 Dayfolio 的 AI 对话即可开始');
    } catch (e) { setError(`复制失败，可展开下方提示词手动复制：${(e as Error).message}`); }
    finally { setBusy(false); }
  };
  return <section id="learning-ai" className="ai-study-action" aria-label="AI 检验学习成果">
    <div><h2>AI 检验学习成果</h2><p>让 AI 围绕{context.item ? '这一项安排' : '整个学习计划'}逐题提问，帮你发现理解中的遗漏。</p></div>
    <button className="btn primary" disabled={busy || disabled} onClick={() => void copy()}>{busy ? '正在复制…' : copied ? '再次复制提示词' : '复制提示词，去 AI 聊天'}</button>
    <p className="ai-study-hint">复制后粘贴到已连接 Dayfolio 的 AI 客户端；AI 读取课件和笔记后会主动提问。</p>
    {error && <p className="notice error" role="alert">{error}</p>}
    <details className="ai-prompt-preview"><summary>查看提示词</summary><textarea aria-label="AI 学习检验提示词" readOnly value={prompt} rows={12} onFocus={e => e.target.select()} /></details>
  </section>;
}

export function StudyNoteEditor({ planId, item, onSaved }: {
  planId: number; item: { id: number; content: string; knowledge_key: string | null }; onSaved: () => Promise<void>;
}) {
  const draftKey = `dayfolio:study-note:${planId}:${item.id}`;
  const [text, setText] = useState(() => sessionStorage.getItem(draftKey) ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<{ id: string; date: string } | null>(null);
  useEffect(() => { if (text) sessionStorage.setItem(draftKey, text); else sessionStorage.removeItem(draftKey); }, [draftKey, text]);
  const save = async () => {
    setBusy(true); setError('');
    pending.current ??= { id: `app-note-${crypto.randomUUID()}`, date: new Date().toLocaleDateString('sv-SE') };
    try {
      await call(() => api.study.recordSession({
        ...pending.current, plan_id: planId, plan_item_id: item.id,
        knowledge_key: item.knowledge_key || `plan-item-${item.id}`, topic: item.content,
        explanation: text.trim(), material_source: 'App 学习笔记',
      }));
      setText(''); pending.current = null;
      toast('学习笔记已保存');
      await onSaved();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="study-note-editor">
    <label htmlFor={`note-${item.id}`}>用自己的话写下理解、例子或还没想通的问题</label>
    <textarea id={`note-${item.id}`} value={text} disabled={busy} onChange={e => setText(e.target.value)} placeholder="我学到了什么？能举一个例子吗？" rows={5} />
    <div className="study-note-footer"><button className="btn" disabled={busy || !text.trim()} onClick={() => void save()}>{busy ? '正在保存…' : '保存学习笔记'}</button></div>
    {error && <p className="notice error" role="alert">{error}</p>}
  </div>;
}
