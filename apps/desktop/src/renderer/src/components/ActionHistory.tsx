import { useEffect, useState } from 'react';
import { api, call } from '../api';
import type { ActionRun } from '../../../../../../packages/core/src/services/action-run';

export default function ActionHistory({ refreshToken }: { refreshToken: unknown }) {
  const [rows, setRows] = useState<ActionRun[]>([]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    void call<{ rows: ActionRun[] }>(() => api.data.listActionExecutions({ limit: 20, ...(status ? { status: status as 'succeeded' | 'failed' } : {}) }))
      .then(value => { if (active) setRows(value.rows); }).catch(e => { if (active) setError((e as Error).message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refreshToken, status]);
  return <details className="data-query-controls action-history"><summary>最近动作执行 · 全部类型</summary>
    <div className="toolbar"><label className="data-query-field">状态<select className="form-select" aria-label="执行记录状态" value={status} onChange={e => setStatus(e.target.value)}><option value="">全部</option><option value="succeeded">成功</option><option value="failed">失败</option></select></label><span className="sub">最近 20 次 · 完整记录可在“动作执行记录”类型中查询</span></div>
    {error && <p className="notice error" role="alert">{error}</p>}
    <div className="data-table-wrap"><table className="data-table" aria-label="动作执行记录"><thead><tr><th>动作</th><th>结果</th><th>入口</th><th>时间</th><th>说明</th></tr></thead><tbody>
      {rows.map(row => <tr key={row.id}><td className="mono" title={row.id}>{row.action}</td><td>{row.status === 'succeeded' ? '成功' : '失败'}{row.attempts > 1 ? ` · ${row.attempts} 次尝试` : ''}</td><td>{row.channel === 'app' ? 'App' : row.channel === 'mcp' ? 'MCP' : '核心调用'}</td><td className="mono">{row.completedAt.replace('T', ' ').slice(0, 19)}</td><td>{row.error ?? '已完成'}</td></tr>)}
      {!rows.length && <tr><td colSpan={5}>{loading ? '正在读取执行记录…' : '还没有动作执行记录'}</td></tr>}
    </tbody></table></div>
  </details>;
}
