// 数据面板·对象浏览：选类型 → 实例表格 → 详情（全部属性 + 出链/入链 + 运行动作）
import { useCallback, useEffect, useState } from 'react';
import { api, call } from '../api';
import { toast } from './Toast';
import { fmtValue, type ActionTypeDef, type LinkRef, type ObjectTypeDef } from './data-shared';

const PAGE_SIZE = 20;

interface ListResult {
  rows: Record<string, unknown>[];
  total: number;
}

interface DetailResult {
  row: Record<string, unknown>;
  links: LinkRef[];
}

export default function DataObjects({ types, actions }: { types: ObjectTypeDef[]; actions: ActionTypeDef[] }) {
  const browsable = types.filter((t) => !t.isVirtual);
  const [selected, setSelected] = useState<string>(browsable[0]?.apiName ?? '');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<ListResult>({ rows: [], total: 0 });
  const [detail, setDetail] = useState<DetailResult | null>(null);
  const [loading, setLoading] = useState(false);

  const def = browsable.find((t) => t.apiName === selected) ?? null;

  const refresh = useCallback(async () => {
    if (!def) return;
    setLoading(true);
    try {
      const res = await call<ListResult>(() => api.data.listObjects({ apiName: selected, search: search || undefined, limit: PAGE_SIZE, offset }));
      setPage(res);
      setDetail(null);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [def, selected, search, offset]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setOffset(0);
    setSearch('');
  }, [selected]);

  const openDetail = async (id: unknown) => {
    try {
      const res = await call<DetailResult>(() => api.data.getObject({ apiName: selected, id: id as string | number }));
      setDetail(res);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const visibleProps = def
    ? [def.titleProperty, ...def.properties.filter((p) => p.apiName !== def.titleProperty).map((p) => p.apiName)].filter(
        (name, i, arr) => arr.indexOf(name) === i,
      ).slice(0, 7)
    : [];

  return (
    <div className="data-explorer">
      <aside className="data-side">
        {browsable.map((t) => (
          <button
            key={t.apiName}
            className={`data-side-item${t.apiName === selected ? ' on' : ''}`}
            onClick={() => setSelected(t.apiName)}
          >
            <span>{t.title}</span>
            <span className="mono subtle">{t.apiName}</span>
          </button>
        ))}
      </aside>
      <div className="data-main">
        {def && (
          <>
            <div className="toolbar">
              <div className="searchbox">
                <input
                  value={search}
                  placeholder={`搜索 ${def.title}…`}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setOffset(0);
                  }}
                />
              </div>
              <span className="sub">
                共 {page.total} 条 · 第 {Math.floor(offset / PAGE_SIZE) + 1} 页
              </span>
              <div className="spacer" />
              <button className="btn slim ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                上一页
              </button>
              <button
                className="btn slim ghost"
                disabled={offset + PAGE_SIZE >= page.total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                下一页
              </button>
            </div>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    {visibleProps.map((name) => (
                      <th key={name} className={name === def.titleProperty ? 'title-col' : ''}>
                        {name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {page.rows.map((row, i) => (
                    <tr key={String(row[def.primaryKey] ?? i)} onClick={() => void openDetail(row[def.primaryKey])}>
                      {visibleProps.map((name) => (
                        <td key={name} className={name === def.titleProperty ? 'title-col' : ''}>
                          {fmtValue(row[name])}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {page.rows.length === 0 && (
                    <tr>
                      <td colSpan={visibleProps.length} className="empty">
                        {loading ? '加载中…' : '暂无数据'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {detail && (
              <ObjectDetail
                def={def}
                detail={detail}
                onClose={() => setDetail(null)}
                actions={actions.filter((a) => a.status === 'active')}
                onChanged={refresh}
                onJump={(apiName, id) => {
                  const t = browsable.find((x) => x.apiName === apiName);
                  if (!t) return;
                  setSelected(apiName);
                  setTimeout(() => void openDetailFor(apiName, id), 30);
                }}
              />
            )}
          </>
        )}
      </div>
    </div>
  );

  async function openDetailFor(apiName: string, id: unknown) {
    try {
      const res = await call<DetailResult>(() => api.data.getObject({ apiName, id: id as string | number }));
      setDetail(res);
    } catch (e) {
      toast((e as Error).message);
    }
  }
}

function ObjectDetail({
  def,
  detail,
  actions,
  onChanged,
  onJump,
  onClose,
}: {
  def: ObjectTypeDef;
  detail: DetailResult;
  actions: ActionTypeDef[];
  onChanged: () => void;
  onJump: (apiName: string, id: unknown) => void;
  onClose: () => void;
}) {
  const [action, setAction] = useState('');
  const [params, setParams] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const chosen = actions.find((a) => a.apiName === action) ?? null;
  const rowId = detail.row[def.primaryKey];

  const pickAction = (apiName: string) => {
    setAction(apiName);
    const next: Record<string, string> = {};
    const a = actions.find((x) => x.apiName === apiName);
    for (const p of a?.parameters ?? []) {
      // 预填本行主键：参数名是 id 或 <类型>_id 时
      if (p.name === 'id' || p.name === `${def.apiName}_id`) next[p.name] = String(rowId ?? '');
      else if (p.defaultValue !== undefined) next[p.name] = String(p.defaultValue);
    }
    setParams(next);
  };

  const run = async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {};
      for (const p of chosen.parameters) {
        const raw = params[p.name] ?? '';
        if (raw === '') continue;
        payload[p.name] = p.dataType === 'integer' || p.dataType === 'float' ? Number(raw) : raw;
      }
      const res = await call<{ results: Array<{ kind: string; objectId?: unknown; changes?: number }> }>(() =>
        api.data.invokeAction({ apiName: chosen.apiName, params: payload }),
      );
      toast(`动作已执行：${res.results.map((r) => r.kind).join('、') || '内置动作'}`);
      onChanged();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const outLinks = detail.links.filter((l) => l.direction === 'out');
  const inLinks = detail.links.filter((l) => l.direction === 'in');

  return (
    <div className="data-detail">
      <header className="panel-head">
        <h2>
          {def.title} · <span className="mono">{String(rowId)}</span>
        </h2>
        <button className="icon-btn" title="关闭" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="data-detail-grid">
        <section>
          <h3>属性</h3>
          <dl className="data-kv">
            {def.properties.map((p) => (
              <div key={p.apiName} className="data-kv-row">
                <dt className={p.apiName === def.primaryKey ? 'accent' : ''}>
                  {p.apiName}
                  <span className="sub"> {p.dataType === 'enum' ? `枚举` : p.dataType}</span>
                </dt>
                <dd className={p.dataType === 'json' ? 'mono' : ''}>{fmtValue(detail.row[p.apiName])}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section>
          <h3>链接</h3>
          {outLinks.length === 0 && inLinks.length === 0 && <p className="empty">无链接关系</p>}
          {[...outLinks, ...inLinks].map((l, i) => (
            <button key={i} className="data-link-row" onClick={() => onJump(l.targetType, l.targetId)}>
              <span className="tag">{l.direction === 'out' ? '出链' : '入链'}</span>
              <span className="mono subtle">{l.linkApiName}</span>
              <span>
                {l.targetTitle ?? String(l.targetId)} <span className="sub">({l.targetType})</span>
              </span>
            </button>
          ))}
          <h3>运行动作</h3>
          {actions.length === 0 ? (
            <p className="empty">暂无可用动作</p>
          ) : (
            <div className="data-run">
              <select className="form-select" value={action} onChange={(e) => pickAction(e.target.value)}>
                <option value="">选择动作…</option>
                {actions.map((a) => (
                  <option key={a.apiName} value={a.apiName}>
                    {a.title}
                    {a.isBuiltin ? '（内置）' : ''}
                  </option>
                ))}
              </select>
              {chosen?.parameters.map((p) => (
                <label key={p.name} className="data-param">
                  <span>
                    {p.name}
                    {p.required ? ' *' : ''}
                    <span className="sub"> {p.dataType}</span>
                  </span>
                  <input
                    className="form-input"
                    value={params[p.name] ?? ''}
                    placeholder={p.description ?? ''}
                    onChange={(e) => setParams({ ...params, [p.name]: e.target.value })}
                  />
                </label>
              ))}
              <button className="btn primary slim" disabled={!chosen || busy} onClick={() => void run()}>
                执行
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
