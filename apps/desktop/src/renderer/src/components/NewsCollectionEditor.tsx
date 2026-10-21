import { useEffect, useState } from 'react';
import type { NewsCollectionSettings } from '../../../../../../packages/core/src/types';
import { api, call } from '../api';
import { toast } from './Toast';

/** 持久提示词与临时请求分开：先保存要求，再按已保存版本发起采集。 */
export default function NewsCollectionEditor({ onDirtyChange }: {
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [saved, setSaved] = useState<NewsCollectionSettings | null>(null);
  const [draft, setDraft] = useState<NewsCollectionSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dirty = !!saved && !!draft && (saved.prompt !== draft.prompt || saved.max_items !== draft.max_items || saved.window_hours !== draft.window_hours);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  const load = async () => {
    setBusy(true);
    try {
      const settings = await call<NewsCollectionSettings>(() => api.news.collectionSettings());
      setSaved(settings); setDraft(settings); setError('');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, []);
  const save = async () => {
    if (!draft || !saved || busy) return;
    setBusy(true); setError('');
    try {
      const settings = await call<NewsCollectionSettings>(() => api.news.updateCollectionSettings({
        prompt: draft.prompt, max_items: draft.max_items, window_hours: draft.window_hours, expected_revision: saved.revision,
      }));
      setSaved(settings); setDraft(settings); toast('采集提示词已保存，下次采集使用新要求');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="news3-prompt" aria-label="新闻采集提示词">
    <div className="news3-prompt-head">
      <div><h3>采集提示词</h3><p>保存你想看的内容与简报格式，每日采集会读取这里的最新要求。</p></div>
      <span className="mono">{dirty ? '有未保存修改' : saved ? (saved.revision ? `已保存 · 版本 ${saved.revision}` : '默认要求') : '正在读取…'}</span>
    </div>
    {error && <div className="notice error" role="alert">{error}<button className="btn slim ghost" disabled={busy} onClick={() => void load()}>重新加载已保存版本</button></div>}
    {draft && <>
      <label htmlFor="news-collection-prompt">给 AI 的长期采集要求</label>
      <textarea id="news-collection-prompt" aria-label="新闻采集提示词内容" rows={12} maxLength={12000} value={draft.prompt}
        disabled={busy} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
      <div className="news3-request-form-row">
        <label>最多收录 <input aria-label="提示词收录上限" type="number" min={1} max={11} disabled={busy} value={draft.max_items} onChange={(e) => setDraft({ ...draft, max_items: Number(e.target.value) })} /> 条</label>
        <label>最近 <input aria-label="提示词时间范围小时" type="number" min={1} max={720} disabled={busy} value={draft.window_hours} onChange={(e) => setDraft({ ...draft, window_hours: Number(e.target.value) })} /> 小时</label>
        <span>一份专题简报按 1 条计算</span>
      </div>
      <div className="news3-request-form-row">
        <button className="btn slim primary" disabled={busy || !dirty || !draft.prompt.trim()} onClick={() => void save()}>保存提示词</button>
        {dirty && <button className="btn slim ghost" disabled={busy} onClick={() => setDraft(saved)}>撤销修改</button>}
      </div>
      <p className="news3-prompt-note">保存后，点击「更新今日新闻」立即调用已配置的 Agent；也可在 Agent 对话中说「按 Dayfolio 保存的要求更新今日新闻」。本次采集使用开始时的要求，后续修改用于下次采集。</p>
    </>}
    {!draft && error && <p>提示词未读取成功，重新加载后可编辑。</p>}
  </section>;
}
