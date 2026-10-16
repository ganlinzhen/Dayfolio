// 操作项来自当前激活包的有限声明，不接受任意组件、IPC 或脚本。
import { useState } from 'react';
import { api, call } from '../api';
import type { ProviderStatus, TodoDeskCore } from '../../../../../../packages/core/src';
import { useRuntimeRefresh } from './useRuntimeRefresh';
import { openRuntimeTool } from './RuntimeTools';

type Extension = ReturnType<TodoDeskCore['extensions']['list']>[number];
const providerIdFor = (extensionId: string, localId: string) => `ext:${extensionId}/${localId}`;
function statusText(status: ProviderStatus | undefined): string {
  if (!status) return '尚未刷新';
  if (status.activeRun) {
    if (status.activeRun.mode === 'external-agent') return '等待外部助手核验并导入';
    return status.activeRun.status === 'queued' ? '已排队，等待拉取' : '正在拉取并校验';
  }
  if (status.lastError) return `上次刷新未完成：${status.lastError.message}`;
  if (status.lastSuccessAt) return `最近成功：${new Date(status.lastSuccessAt).toLocaleString()}`;
  return status.mode === 'external-agent' ? '由外部助手核验后导入' : '尚未刷新';
}
export default function RuntimeCalendarActions() {
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [statuses, setStatuses] = useState<Record<string, ProviderStatus>>({});
  const [busy, setBusy] = useState<string[]>([]), [error, setError] = useState('');
  const refresh = async () => {
    try {
      const next = await call<Extension[]>(() => api.extensions.list());
      const ids = [...new Set(next.filter(extension => extension.status === 'active').flatMap(extension =>
        (extension.manifest.contributions?.calendarActions ?? []).filter(action => action.kind === 'refresh_provider').map(action => providerIdFor(extension.id, action.providerLocalId))))];
      const entries = await Promise.all(ids.map(async providerId => [providerId, await call<ProviderStatus>(() => api.events.getStatus({ providerId }))] as const));
      setExtensions(next); setStatuses(Object.fromEntries(entries)); setError('');
    } catch (error) { setError((error as Error).message); }
  };
  useRuntimeRefresh(refresh);
  const request = async (providerId: string) => {
    setBusy(current => [...current, providerId]); setError('');
    try { await call(() => api.events.refresh({ providerId })); await refresh(); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(current => current.filter(id => id !== providerId)); }
  };
  return <>{extensions.filter(extension => extension.status === 'active').flatMap(extension =>
    (extension.manifest.contributions?.calendarActions ?? []).map(action => {
      const providerId = providerIdFor(extension.id, action.providerLocalId);
      return action.kind === 'open_tool'
        ? <button className="btn slim" key={extension.id + ':' + action.localId} onClick={() => openRuntimeTool(extension.id)}>{action.title}</button>
        : <span className="runtime-refresh-action" key={extension.id + ':' + action.localId}>
          <button className="btn slim" disabled={busy.includes(providerId)} onClick={() => void request(providerId)}>{busy.includes(providerId) ? '正在提交…' : action.title}</button>
          <span className="sub" role="status">{statusText(statuses[providerId])}</span>
        </span>;
    }))}{error && <span className="notice error" role="alert">{error}</span>}</>;
}
