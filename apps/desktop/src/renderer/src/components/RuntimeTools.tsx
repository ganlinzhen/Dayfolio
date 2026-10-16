// 安装预览和权限审阅由宿主渲染；工具不能提供授权按钮或替换管理流程。
import { useState } from 'react';
import { api, call } from '../api';
import type { ExtensionPreview, TodoDeskCore } from '../../../../../../packages/core/src';
import { useRuntimeRefresh } from './useRuntimeRefresh';
import { IconTool } from './icons';

type Extension = ReturnType<TodoDeskCore['extensions']['list']>[number];
const PERMISSIONS: Record<string, string> = { 'events.read': '读取自身活动', 'events.import': '导入自身活动', 'subscriptions.write': '创建、取消和恢复订阅', 'providers.refresh': '刷新自身数据源', 'navigation.openTodo': '打开关联待办' };
export const openRuntimeTool = (extensionId: string) => window.dispatchEvent(new CustomEvent('dayfolio:openTool', { detail: { extensionId } }));

export default function RuntimeTools({ onCount }: { onCount?: (count: number) => void }) {
  const [extensions, setExtensions] = useState<Extension[]>([]), [preview, setPreview] = useState<ExtensionPreview | null>(null);
  const [directory, setDirectory] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const refresh = async () => { try { const next=await call<Extension[]>(() => api.extensions.list());setExtensions(next);onCount?.(next.filter(extension=>extension.status!=='uninstalled').length); } catch (error) { setError((error as Error).message); } };
  useRuntimeRefresh(refresh);
  const execute = async (action: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await action(); await refresh(); } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  };
  const choose = () => execute(async () => {
    const selected = await call<string|null>(() => api.extensions.pickDirectory());
    if (!selected) return;
    setDirectory(selected);
    setPreview(await call<ExtensionPreview>(() => api.extensions.previewInstall({ stagingDirectory: selected })));
  });
  const install = () => execute(async () => {
    if (!preview) return;
    const input = { stagingDirectory: directory, expectedPackageDigest: preview.digest, expectedExtensionRevision: preview.currentRevision };
    const authorizationRef = preview.authorizationRef ?? (await call<{authorizationRef:string}>(() => api.extensions.authorizeInstall(input))).authorizationRef;
    await call(() => api.extensions.install({ ...input, authorizationRef })); setPreview(null);
  });
  return <section className="group runtime-tools" aria-label="运行时工具管理">
    <div className="cal-day-head"><strong>运行时工具</strong><span className="spacer" /><button className="btn slim" disabled={busy} onClick={() => void choose()}>安装或更新工具包</button></div>
    <p className="sub">工具包安装后自动增加日历分类和帮助。停用或卸载会保留订阅与待办。</p>
    {error && <div className="notice error" role="alert">{error}</div>}
    <div className="tool-grid">{extensions.map(extension => <div className="runtime-tool-card" key={extension.id}>
      <button className="tool-card" disabled={extension.status !== 'active'} onClick={() => openRuntimeTool(extension.id)}>{extension.status==='active'&&Object.hasOwn(extension.manifest.files,extension.icon)?<img width={20} height={20} alt="" src={extension.origin+'/'+extension.digest+'/'+extension.icon}/>:<IconTool name={extension.icon} width={20} height={20}/>}<span className="tool-card-title">{extension.title}</span><span className="sub">{extension.version} · {extension.status === 'active' ? '已启用' : extension.status === 'disabled' ? '已停用' : '已卸载'}</span></button>
      <p className="sub">{extension.description}</p>
      <div className="cal-form-row">
        {extension.status !== 'uninstalled' && <button className="btn slim" disabled={busy} onClick={() => void execute(() => call(() => api.extensions.setEnabled({extensionId:extension.id,expectedRevision:extension.revision,enabled:extension.status!=='active'})))}>{extension.status === 'active' ? '停用' : '启用'}</button>}
        {extension.status !== 'uninstalled' && <button className="btn slim" disabled={busy} onClick={() => { if (window.confirm(`卸载「${extension.title}」入口？事件、分类和待办会保留。`)) void execute(() => call(() => api.extensions.uninstall({extensionId:extension.id,expectedRevision:extension.revision}))); }}>卸载入口</button>}
        {extension.status !== 'uninstalled' && extension.releases.some(release=>release.state==='ready'&&release.digest!==extension.digest) && <select className="inline-input" aria-label={`${extension.title}回滚版本`} value="" disabled={busy} onChange={event=>{const version=event.target.value;if(version&&window.confirm(`回滚页面到 ${version}？不会回退事件、个人修改和完成记录。`))void execute(()=>call(()=>api.extensions.rollback({extensionId:extension.id,expectedRevision:extension.revision,version})));}}><option value="">回滚页面版本…</option>{extension.releases.filter(release=>release.state==='ready'&&release.digest!==extension.digest).map(release=><option key={release.digest} value={release.version}>{release.version}</option>)}</select>}
      </div>
    </div>)}</div>
    {preview && <div className="modal-mask"><div className="modal wide" role="dialog" aria-modal="true" aria-label="工具包安装预览">
      <header className="modal-head"><h3>{preview.currentVersion ? '更新工具包' : '安装工具包'}：{preview.title}</h3><button className="icon-btn" disabled={busy} onClick={()=>setPreview(null)}>×</button></header>
      <div className="modal-body"><p>版本 {preview.currentVersion ?? '未安装'} → {preview.version}</p><h4>请求的权限</h4><ul>{preview.requestedPermissions.map(permission=><li key={permission.name+permission.providerLocalId}>{PERMISSIONS[permission.name] ?? permission.name} · 来源 {permission.providerLocalId}{preview.permissionDelta.some(delta=>delta.name===permission.name&&delta.providerLocalId===permission.providerLocalId)?'（新增）':''}</li>)}</ul>
        {preview.networkTargets.length>0 && <><h4>网络来源</h4><ul>{preview.networkTargets.map(url=><li key={url}>{url}{preview.networkChanges.includes(url)?'（新增或变更）':''}</li>)}</ul></>}
        <h4>新增或更新的日历分类</h4><p>{preview.collections.map(collection=>collection.title).join('、')}</p>
        <p className="sub">确认仅针对本次预览的包内容与权限。包内容或安装状态变化后会要求重新预览。</p>
        <div className="cal-form-row"><button className="btn primary" disabled={busy} onClick={()=>void install()}>{busy?'正在安装…':preview.authorizationRef?'确认安装':'同意所列权限并安装'}</button><button className="btn" disabled={busy} onClick={()=>setPreview(null)}>取消</button></div>
      </div>
    </div></div>}
  </section>;
}
