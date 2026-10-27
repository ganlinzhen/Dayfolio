import { useCallback, useEffect, useRef, useState } from 'react';
import type { NewsFeedConfig, NewsFeedModule, NewsFeedPreview } from '../../../../../../packages/core/src/news-types';
import { api, call } from '../api';
import { toast } from './Toast';
import NewsFeedInterests from './NewsFeedInterests';
const prepared = (config: NewsFeedConfig): NewsFeedConfig => ({ ...config, modules: config.modules.map(module => ({ ...module, source_preferences: module.source_preferences?.map(s => s.trim()).filter(Boolean), source_exclusions: module.source_exclusions?.map(s => s.trim()).filter(Boolean) })) });

export default function NewsCollectionEditor({ onDirtyChange, onSaved, moduleSeed, onSeedConsumed }: { onDirtyChange: (dirty: boolean) => void; onSaved?: () => void; moduleSeed?: { name: string; scope: string } | null; onSeedConsumed?: () => void }) {
  const seedConsumed = useRef(false);
  const [saved, setSaved] = useState<NewsFeedConfig | null>(null);
  const [draft, setDraft] = useState<NewsFeedConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [preview, setPreview] = useState<NewsFeedPreview | null>(null);
  const [previewDirty, setPreviewDirty] = useState(false);
  const dirty = !!saved && !!draft && JSON.stringify(saved) !== JSON.stringify(draft);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { if (!dirty) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty]);
  const load = useCallback(async () => {
    setBusy(true);
    try { const value = await call<NewsFeedConfig>(() => api.news.feedConfig()); setSaved(value); setDraft(value); setError(''); setConflict(false); setPreview(null); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const patch = (value: Partial<NewsFeedConfig>) => { if (draft) { setDraft({ ...draft, ...value }); setPreview(null); } };
  const patchModule = (id: string, value: Partial<NewsFeedModule>) => { if (draft) patch({ modules: draft.modules.map(m => m.id === id ? { ...m, ...value } : m) }); };
  const addModule = (name = '', scope = '') => {
    if (!draft) return;
    patch({ modules: [...draft.modules, { id: `topic-${crypto.randomUUID()}`, name, enabled: true, kind: 'topic', scope, exclusions: '', window_hours: 24, headline_count: 5, max_items: 10, content: {} }] });
  };
  useEffect(() => { if (!draft || !moduleSeed || seedConsumed.current) return; seedConsumed.current = true; addModule(moduleSeed.name, moduleSeed.scope); onSeedConsumed?.(); }, [draft, moduleSeed]);
  const move = (index: number, delta: number) => {
    if (!draft) return; const modules = [...draft.modules]; const other = index + delta;
    if (other < 0 || other >= modules.length) return; [modules[index], modules[other]] = [modules[other], modules[index]]; patch({ modules });
  };
  const save = async () => {
    if (!draft || !saved || busy) return; setBusy(true); setError('');
    try { const value = await call<NewsFeedConfig>(() => api.news.feedUpdateConfig({ config: prepared(draft), expected_revision: saved.revision })); setSaved(value); setDraft(value); setConflict(false); setPreview(null); onSaved?.(); toast('新闻配置已保存，下轮采集使用最新要求'); }
    catch (e) { setError((e as Error).message); setConflict(true); } finally { setBusy(false); }
  };
  const showPreview = async () => {
    if (!draft) return; setBusy(true); setError('');
    try { setPreview(await call<NewsFeedPreview>(() => api.news.feedPreview({ config: prepared(draft) }))); setPreviewDirty(dirty); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  if (!draft) return <section className="nf-settings"><p>{error || '正在读取新闻配置…'}</p>{error && <button className="btn" onClick={() => void load()}>重新读取</button>}</section>;
  return <section className="nf-settings" aria-label="新闻模块配置">
    <header className="nf-section-head"><div><h2>新闻配置</h2><p>告诉 AI 想看什么。每轮根据模块、有效时事和兴趣生成采集要求。</p></div><span>{dirty ? '有未保存修改' : `已保存 · 版本 ${saved?.revision}`}</span></header>
    {error && <div className="notice error" role="alert">{error}{conflict && <p>当前草稿已保留。可复制草稿，或明确载入最新配置后重新修改。</p>}<button className="btn slim" onClick={() => { void navigator.clipboard.writeText(JSON.stringify(draft, null, 2)).then(() => toast('配置草稿已复制')); }}>复制草稿</button><button className="btn slim" disabled={busy} onClick={() => { if (!dirty || window.confirm('载入最新配置会放弃当前草稿，继续？')) void load(); }}>载入最新配置</button></div>}
    <fieldset disabled={busy} className="nf-fieldset"><legend>阅读模块</legend><p className="nf-note">默认先看 5 则重点，展开到最多 10 则；来源不足时显示实际结果。</p>
      {draft.modules.map((m, index) => <details key={m.id} className="nf-module-editor" open={!m.name}>
        <summary><span>{m.name || '新模块'}</span><span className="nf-note">{m.enabled ? '已启用' : '已停用'} · {m.headline_count} / {m.max_items} 则</span></summary>
        <div className="nf-form-grid">
          <label>模块名称<input aria-label={`模块名称 ${index + 1}`} value={m.name} maxLength={40} onChange={e => patchModule(m.id, { name: e.target.value })} /></label>
          <label>类型<select value={m.kind} onChange={e => patchModule(m.id, { kind: e.target.value as NewsFeedModule['kind'] })}><option value="public">公共重要新闻</option><option value="topic">长期主题</option><option value="events">阶段性时事</option></select></label>
          <label className="nf-wide">想看什么<textarea rows={2} value={m.scope} onChange={e => patchModule(m.id, { scope: e.target.value })} placeholder="主题、地区与关注方向" /></label>
          <label className="nf-check"><input type="checkbox" checked={m.enabled} onChange={e => patchModule(m.id, { enabled: e.target.checked })} />启用模块</label>
          <div className="nf-actions"><button className="btn slim" disabled={index === 0} onClick={() => move(index, -1)}>上移</button><button className="btn slim" disabled={index === draft.modules.length - 1} onClick={() => move(index, 1)}>下移</button><button className="btn slim danger" disabled={draft.modules.length === 1} title={draft.modules.length === 1 ? '最后一个模块可停用，至少保留一个配置' : undefined} onClick={() => { if (window.confirm(`移除模块「${m.name}」？历史新闻和收藏保留。`)) patch({ modules: draft.modules.filter(x => x.id !== m.id) }); }}>移除模块</button></div>
        </div>
        <details className="nf-advanced"><summary>更多模块选项</summary><div className="nf-form-grid">
          <label>重点显示<input type="number" min={1} max={5} value={m.headline_count} onChange={e => patchModule(m.id, { headline_count: Number(e.target.value) })} /></label>
          <label>最多整理<input type="number" min={5} max={10} value={m.max_items} onChange={e => patchModule(m.id, { max_items: Number(e.target.value) })} /></label>
          <label>最近多少小时<input type="number" min={1} max={720} value={m.window_hours} onChange={e => patchModule(m.id, { window_hours: Number(e.target.value) })} /></label>
          <label>摘要深度<select value={m.content.summary_depth || ''} onChange={e => patchModule(m.id, { content: e.target.value ? { ...m.content, summary_depth: e.target.value as 'brief' | 'standard' | 'deep' } : Object.fromEntries(Object.entries(m.content).filter(([key]) => key !== 'summary_depth')) })}><option value="">继承全局</option><option value="brief">简短</option><option value="standard">标准</option><option value="deep">深入</option></select></label>
          <label>图片展示<select value={m.content.image_display || ''} onChange={e => patchModule(m.id, { content: e.target.value ? { ...m.content, image_display: e.target.value as 'list_thumbnail' | 'detail_only' } : Object.fromEntries(Object.entries(m.content).filter(([key]) => key !== 'image_display')) })}><option value="">继承全局</option><option value="list_thumbnail">列表缩略图与详情</option><option value="detail_only">仅详情加载</option></select></label>
          <label className="nf-wide">暂不看什么<textarea rows={2} value={m.exclusions} onChange={e => patchModule(m.id, { exclusions: e.target.value })} /></label>
          <label>配图策略<select value={m.content.image_policy || ''} onChange={e => patchModule(m.id, { content: e.target.value ? { ...m.content, image_policy: e.target.value as 'none' | 'prefer_original' } : Object.fromEntries(Object.entries(m.content).filter(([key]) => key !== 'image_policy')) })}><option value="">继承全局</option><option value="prefer_original">优先来源原图</option><option value="none">不提取或加载图片</option></select></label>
          <label>优先来源（每行一个）<textarea rows={3} value={(m.source_preferences || []).join('\n')} onChange={e => patchModule(m.id, { source_preferences: e.target.value.split('\n') })} /></label>
          <label>排除来源（每行一个）<textarea rows={3} value={(m.source_exclusions || []).join('\n')} onChange={e => patchModule(m.id, { source_exclusions: e.target.value.split('\n') })} /></label>
          <label className="nf-wide">补充采集要求<textarea rows={3} maxLength={1500} value={m.extra_instructions || ''} onChange={e => patchModule(m.id, { extra_instructions: e.target.value })} placeholder="不覆盖数量、时间窗与来源核实规则" /></label>
        </div></details>
      </details>)}
      <button className="btn" onClick={() => addModule()}>新增模块</button>
    </fieldset>
    <fieldset disabled={busy} className="nf-fieldset"><legend>更新安排</legend><label className="nf-check"><input type="checkbox" checked={draft.schedule.enabled} onChange={e => patch({ schedule: { ...draft.schedule, enabled: e.target.checked } })} />每天自动更新</label>
      <p className="nf-note">北京时间（Asia/Shanghai）到点开始整理。电脑恢复后合并补采一次；退出 App 时不会运行。</p>
      <div className="nf-actions">{draft.schedule.times.map((time, index) => <label key={index}>更新 {index + 1}<input aria-label={`自动更新时间 ${index + 1}`} type="time" value={time} onChange={e => patch({ schedule: { ...draft.schedule, times: draft.schedule.times.map((v, i) => i === index ? e.target.value : v) } })} /><button className="btn slim" disabled={draft.schedule.times.length <= 1} onClick={() => patch({ schedule: { ...draft.schedule, times: draft.schedule.times.filter((_, i) => i !== index) } })}>移除此时间</button></label>)}{draft.schedule.times.length < 6 && <button className="btn slim" onClick={() => patch({ schedule: { ...draft.schedule, times: [...draft.schedule.times, '20:00'] } })}>添加时间</button>}</div>
      <label>整轮时间预算（分钟）<input type="number" min={5} max={120} value={draft.budget_minutes} onChange={e => patch({ budget_minutes: Number(e.target.value) })} /></label><p className="nf-note">先覆盖各模块重点，再补足内容。到限保留结果，可手动继续，不自动追加预算。</p>
    </fieldset>
    <details className="nf-fieldset"><summary>内容与展示</summary><fieldset disabled={busy} className="nf-fieldset nf-form-grid">
      <label>摘要深度<select value={draft.content.summary_depth} onChange={e => patch({ content: { ...draft.content, summary_depth: e.target.value as 'brief' | 'standard' | 'deep' } })}><option value="brief">简短</option><option value="standard">标准</option><option value="deep">深入</option></select></label>
      <label>配图策略<select value={draft.content.image_policy} onChange={e => patch({ content: { ...draft.content, image_policy: e.target.value as 'none' | 'prefer_original' } })}><option value="prefer_original">优先来源原图</option><option value="none">不提取或加载图片</option></select></label>
      <label>图片展示<select value={draft.content.image_display || 'list_thumbnail'} onChange={e => patch({ content: { ...draft.content, image_display: e.target.value as 'list_thumbnail' | 'detail_only' } })}><option value="list_thumbnail">列表缩略图与详情</option><option value="detail_only">仅详情加载</option></select></label>
      {([['show_background', '必要背景'], ['show_impact', '影响与后续（分析）'], ['show_uncertainty', '不确定性']] as const).map(([key, label]) => <label key={key} className="nf-check"><input type="checkbox" checked={draft.content[key]} onChange={e => patch({ content: { ...draft.content, [key]: e.target.checked } })} />{label}</label>)}
      <p className="nf-note nf-wide">核心事实和来源始终保留。摘要要求影响后续整理，旧新闻不会自动重写；没有可靠原图时无图展示。</p>
    </fieldset></details>
    <fieldset disabled={busy} className="nf-fieldset"><legend>兴趣学习</legend>
      <label className="nf-check"><input type="checkbox" checked={draft.learning.enabled} onChange={e => patch({ learning: { ...draft.learning, enabled: e.target.checked } })} />根据我的阅读与明确反馈改善推荐</label>
      <p className="nf-note">启用后使用 App 内的阅读、原文点击及反馈，不分析其他应用。公共重要新闻保留；推断仅用于猜你喜欢和主题补充。关闭停止使用推断，清空另行执行。</p>
      <label className="nf-check"><input type="checkbox" checked={draft.learning.exploration_enabled} onChange={e => patch({ learning: { ...draft.learning, exploration_enabled: e.target.checked } })} />每轮探索一个新方向，提供少量试读</label>
    </fieldset>
    <div className="nf-savebar"><button className="btn primary" disabled={busy || !dirty || draft.modules.length === 0 || draft.modules.some(m => !m.name.trim() || !m.scope.trim() || m.max_items < m.headline_count)} onClick={() => void save()}>{busy ? '处理中…' : '保存配置'}</button><button className="btn" disabled={busy || !dirty} onClick={() => { setDraft(saved); setPreview(null); }}>撤销修改</button><button className="btn" disabled={busy} onClick={() => void showPreview()}>预览动态提示词</button><span className="nf-note">更新新闻只使用已保存配置</span></div>
    {preview && <section className="nf-preview" aria-label="动态提示词预览"><h3>{previewDirty ? '草稿预览 · 尚未用于采集' : `已保存配置预览 · 版本 ${preview.config_revision}`}</h3>{preview.modules.map(m => <details key={m.module_id}><summary>{m.name}</summary><pre>{m.instructions}</pre><button className="btn slim" onClick={() => void navigator.clipboard.writeText(m.instructions).then(() => toast('本模块提示词已复制'))}>复制提示词</button></details>)}</section>}
    <NewsFeedInterests onChanged={onSaved} onAddModule={(name, scope) => { addModule(name, scope); toast('模块草稿已添加，请核对并保存配置'); }} />
  </section>;
}
