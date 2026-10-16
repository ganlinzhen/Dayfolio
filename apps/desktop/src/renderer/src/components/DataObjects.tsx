// 对象类型详情内的实例浏览：搜索与分页、实例属性、关联跳转和运行动作。
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, call } from '../api';
import { toast } from './Toast';
import { fmtValue, type ActionTypeDef, type LinkRef, type ObjectTypeDef } from './data-shared';
import DataQueryBar, { type QueryViewOptions } from './DataQueryBar';
import type { AggregateResult } from '../../../../../../packages/core/src/ontology/query';
import ActionValuesInput from './ActionValuesInput';
import type { ActionService } from '../../../../../../packages/core/src/ontology/action';

const PAGE_SIZE = 20;

interface ListResult {
  rows: Record<string, unknown>[];
  total: number;
}

interface RelationGroup {targetType:string;targetKeyType:string;writable:boolean;constraintState?:string;apiName:string;title:string;side:'left'|'right';items:LinkRef[];total:number;hasMore:boolean;}
interface DetailResult {
  groups?:RelationGroup[];
  row: Record<string, unknown>;
  links: LinkRef[];
}

export default function DataObjects({ types, actions, objectType, initialObjectId, onJump, onChanged }: {
  types: ObjectTypeDef[];
  actions: ActionTypeDef[];
  objectType: string;
  initialObjectId?: string | number;
  onJump: (apiName: string, id: string | number) => void;
  onChanged: () => void;
}) {
  const selected = objectType;
  const initialTarget = useRef(initialObjectId);
  const request = useRef(0);
  const detailRequest = useRef(0);
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<ListResult>({ rows: [], total: 0 });
  const [detail, setDetail] = useState<DetailResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [queryOptions, setQueryOptions] = useState<QueryViewOptions>({});
  const [aggregate, setAggregate] = useState<AggregateResult | null>(null);
  const [queryError, setQueryError] = useState('');
  const [creating, setCreating] = useState(false);
  const createAction = actions.find(a => a.template?.targetKind === 'object' && a.template.targetName === selected && a.template.operation === 'create');

  const def = types.find((t) => t.apiName === selected) ?? null;

  const refresh = useCallback(async (openId?: string | number) => {
    if (!def) return;
    const token = ++request.current;
    ++detailRequest.current;
    setLoading(true);
    setPage({ rows: [], total: 0 });
    setDetail(null);
    setAggregate(null);
    setQueryError('');
    try {
      const input = { version: 1, objectType: selected, ...queryOptions, search: search || undefined, page: { limit: PAGE_SIZE, offset } };
      const grouped = queryOptions.metrics ? await call<AggregateResult>(() => api.data.aggregateObjects(input)) : null;
      const res = grouped ? { rows: [], total: grouped.groupCount } : await call<ListResult>(() => api.data.queryObjects({ ...input, includeTotal: true }));
      if (token !== request.current) return;
      setAggregate(grouped);
      setPage(res);
      if (openId !== undefined) {
        const row = await call<DetailResult>(() => api.data.getObject({ apiName: selected, id: openId }));
        if (token === request.current) setDetail(row);
      }
    } catch (e) {
      if (token === request.current) { setQueryError((e as Error).message); toast((e as Error).message); }
    } finally {
      if (token === request.current) setLoading(false);
    }
  }, [def, selected, search, offset, queryOptions]);

  useEffect(() => {
    void refresh(initialTarget.current);
    initialTarget.current = undefined;
    return () => { ++request.current; ++detailRequest.current; };
  }, [refresh]);

  const openDetail = async (id: unknown) => {
    const token = ++detailRequest.current;
    try {
      const res = await call<DetailResult>(() => api.data.getObject({ apiName: selected, id: id as string | number }));
      if (token === detailRequest.current) setDetail(res);
    } catch (e) {
      if (token === detailRequest.current) toast((e as Error).message);
    }
  };

  const visibleProps = def
    ? [def.titleProperty, ...def.properties.filter((p) => p.readable !== false && p.apiName !== def.titleProperty).map((p) => p.apiName)].filter(
        (name, i, arr) => arr.indexOf(name) === i,
      ).slice(0, 7)
    : [];

  return (
    <div className="data-explorer">
      <div className="data-main">
        {def && (
          <>
            <div className="toolbar">
              {detail && <button className="btn slim ghost" onClick={() => setDetail(null)}>← 返回对象列表</button>}
              {!detail && <div className="searchbox">
                <input
                  aria-label={`搜索 ${def.title}`}
                  value={search}
                  placeholder={`搜索 ${def.title}…`}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setOffset(0);
                  }}
                />
              </div>}
              <span className="sub">
                {aggregate ? `${aggregate.objectCount} 个对象 · ${page.total} 组` : `共 ${page.total} 条`} · 第 {Math.floor(offset / PAGE_SIZE) + 1} 页
              </span>
              <div className="spacer" />
              {!detail && createAction && <button className="btn primary slim" disabled={createAction.status !== 'active'} onClick={() => setCreating(true)}>新增对象</button>}
              {!detail && <><button className="btn slim ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                上一页
              </button>
              <button
                className="btn slim ghost"
                disabled={offset + PAGE_SIZE >= page.total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                下一页
              </button></>}
            </div>
            {!detail && <DataQueryBar key={selected} def={def} onApply={options => { setOffset(0); setQueryOptions(options); }}/>}
            {!detail && creating && createAction && <CreateObjectForm action={createAction} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); void refresh(); onChanged(); }}/>}
            {!detail && queryError && <p className="notice error" role="alert">{queryError}</p>}
            {!detail && aggregate && <div className="data-table-wrap"><table className="data-table" aria-label="分组统计结果"><thead><tr>{[...Object.keys(aggregate.rows[0]?.dimensions ?? {}), ...Object.keys(aggregate.rows[0]?.metrics ?? {})].map(name => <th key={name}>{name === 'count' ? '数量' : name === 'value' ? '统计值' : name}</th>)}</tr></thead><tbody>{aggregate.rows.map((row, index) => <tr key={index}>{[...Object.values(row.dimensions), ...Object.values(row.metrics)].map((value, i) => <td key={i}>{fmtValue(value)}</td>)}</tr>)}{aggregate.rows.length === 0 && <tr><td>没有符合条件的分组</td></tr>}</tbody></table></div>}
            {!detail && !aggregate && <div className="data-table-wrap">
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
                      {visibleProps.map((name, index) => (
                        <td key={name} className={name === def.titleProperty ? 'title-col' : ''}>
                          {index === 0 ? <button className="data-type-link" onClick={(e) => { e.stopPropagation(); void openDetail(row[def.primaryKey]); }}>{fmtValue(row[name])}</button> : fmtValue(row[name])}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {page.rows.length === 0 && (
                    <tr>
                      <td colSpan={visibleProps.length} className="empty">
                        {loading ? '加载中…' : queryError ? '查询失败，请调整条件后重试' : '暂无数据'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>}
            {detail && (
              <ObjectDetail
                key={String(detail.row[def.primaryKey])}
                def={def}
                detail={detail}
                onClose={() => setDetail(null)}
                actions={actions}
                onChanged={() => { void refresh(); onChanged(); const id=detail.row[def.primaryKey];void api.data.getObject({apiName:def.apiName,id:typeof id==='number'?id:String(id)}).then(result=>setDetail(result.ok?result.data as DetailResult:null)); }}
                onJump={(apiName, id) => {
                  const target = types.find((t) => t.apiName === apiName && !t.isVirtual);
                  if (!target) { toast('该关联是虚拟对象，没有独立的实例表'); return; }
                  if (apiName === selected) void openDetail(id);
                  else onJump(apiName, id as string | number);
                }}
              />
            )}
          </>
        )}
      </div>
    </div>
  );

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
  const [preconditions, setPreconditions] = useState<ReturnType<ActionService['preview']> | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const previewRequest = useRef(0);
  const requestKey = useRef({ signature: '', key: '' });
  const chosen = actions.find((a) => a.apiName === action) ?? null;
  const rowId = detail.row[def.primaryKey];
  const needsPreview = chosen?.template?.targetKind === 'object' && chosen.template.operation !== 'create';
  const loadPreview = (action: ActionTypeDef | undefined, id: string) => {
    const request = ++previewRequest.current;
    setPreconditions(null); setPreviewError(''); setPreviewBusy(false);
    if (!action?.template || action.template.targetKind !== 'object' || action.template.operation === 'create' || !id) return;
    setPreviewBusy(true);
    const p = action.parameters.find(p => p.name === 'id');
    void call<ReturnType<ActionService['preview']>>(() => api.data.previewAction({ apiName: action.apiName, params: { id: p?.dataType === 'integer' ? Number(id) : id } }))
      .then(result => { if (request === previewRequest.current) setPreconditions(result); }).catch(e => { if (request === previewRequest.current) setPreviewError((e as Error).message); }).finally(() => { if (request === previewRequest.current) setPreviewBusy(false); });
  };
  const changeParam = (name: string, value: string) => { setParams(current => ({ ...current, [name]: value })); if (name === 'id') loadPreview(chosen ?? undefined, value); };

  const pickAction = (apiName: string) => {
    setAction(apiName);
    const next: Record<string, string> = {};
    const a = actions.find((x) => x.apiName === apiName);
    for (const p of a?.parameters ?? []) {
      // 预填本行主键：参数名是 id 或 <类型>_id 时
      if (a?.apiName === 'checkin' && p.name === 'ref_type' && ['todo', 'plan_item', 'day'].includes(def.apiName)) next[p.name] = def.apiName;
      else if (a?.apiName === 'checkin' && p.name === 'ref_id' && ['todo', 'plan_item'].includes(def.apiName)) next[p.name] = String(rowId ?? '');
      else if (a?.targetBindings?.some(binding=>binding.objectType===def.apiName&&binding.parameter===p.name)) next[p.name] = String(rowId ?? '');
      else if (p.defaultValue !== undefined) next[p.name] = String(p.defaultValue);
      else if (a?.template && p.dataType === 'json') next[p.name] = '{}';
    }
    setParams(next);
    loadPreview(a, next.id ?? '');
  };

  const run = async () => {
    if (!chosen) return;
    if (chosen.template?.operation === 'delete' && chosen.template.targetKind === 'object' && !confirm(`删除当前对象 ${params.id ?? ''}？此操作不可恢复，仍受关系删除约束。`)) return;
    if (chosen.apiName === 'delete_study_plan') {
      const keepTodos = params.delete_todos === 'false';
      if (!confirm(`删除学习计划 ${params.id ?? ''}？计划、条目及条目打卡将删除，${keepTodos ? '生成的待办保留' : '本计划独占的自动生成待办及其打卡也将删除'}。此操作不可恢复。`)) return;
    }
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {};
      for (const p of chosen.parameters) {
        const raw = params[p.name] ?? '';
        if (raw === '') continue;
        payload[p.name] = p.dataType === 'integer' || p.dataType === 'float' ? Number(raw) : p.dataType==='boolean' ? JSON.parse(raw) : p.dataType==='json' ? JSON.parse(raw) : raw;
      }
      const signature = JSON.stringify({ action: chosen.apiName, params: payload });
      if (signature !== requestKey.current.signature) requestKey.current = { signature, key: crypto.randomUUID() };
      const options = !chosen.isBuiltin || chosen.composable ? { idempotencyKey: requestKey.current.key,
        ...(preconditions ? { expectedDefinitionRevision: preconditions.definitionRevision, expectedObjects: preconditions.targets } : {}) } : undefined;
      const res = await call<{ results: Array<{ kind: string; objectId?: unknown; changes?: number }> }>(() =>
        api.data.invokeAction({ apiName: chosen.apiName, params: payload, options }),
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
            {def.properties.filter(p=>p.readable!==false).map((p) => (
              <div key={p.apiName} className="data-kv-row">
                <dt className={p.apiName === def.primaryKey ? 'accent' : ''}>
                  {p.apiName}
                  <span className="sub"> {p.dataType === 'enum' ? `枚举` : p.dataType}</span>
                </dt>
                <dd className={p.dataType === 'json' ? 'mono' : ''}>{fmtValue(detail.row[p.apiName])}</dd>
              </div>
            ))}
          </dl>
          {(def.extensionWritable || !def.isSystem) && <ExtensionFields def={def} row={detail.row} action={actions.find(a => a.template?.targetKind === 'object' && a.template.targetName === def.apiName && ['update', 'extensions'].includes(a.template.operation))} onChanged={onChanged}/>}
        </section>
        <section>
          <h3>链接</h3>
          {detail.groups?.map(group=><RelationRows key={`${group.apiName}-${group.side}`} group={group} apiName={def.apiName} id={typeof rowId==='number'?rowId:String(rowId)} onJump={onJump} onChanged={onChanged}/>)}
          {detail.links.filter(l=>l.targetType==='day').map((l,i)=><p key={i}>日期：{String(detail.row.date ?? l.targetId)}</p>)}
          {!detail.groups?.length && outLinks.length===0 && inLinks.length===0 && <p className="empty">无链接关系</p>}
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
                    {a.isBuiltin ? '（内置）' : ''}{a.status!=='active'?'（已停用）':a.needsReview?'（需复核）':''}
                  </option>
                ))}
              </select>
              {chosen && <p className="sub">{chosen.description}{chosen.allowedChannels?.includes('app-human')?' 请到对应业务面板操作。':' 执行会真实修改数据。'}</p>}
              {chosen?.parameters.map((p) => (
                <div key={p.name} className="data-param">
                  <span>
                    {p.name}
                    {p.required ? ' *' : ''}
                    <span className="sub"> {p.dataType}</span>
                  </span>
                  {chosen.template && p.dataType === 'json' ? <ActionValuesInput parameter={p} value={params[p.name] ?? '{}'} current={detail.row} onChange={value => changeParam(p.name, value)}/> : p.objectType ? <ObjectParameter type={p.objectType} value={params[p.name]??''} onChange={value=>changeParam(p.name,value)}/> : <input className="form-input" value={params[p.name]??''} placeholder={p.description??''} onChange={e=>changeParam(p.name,e.target.value)}/>}
                </div>
              ))}
              {previewError && <p className="notice error" role="alert">{previewError}</p>}
              <button className="btn primary slim" disabled={!chosen || busy || previewBusy || (needsPreview && !preconditions) || chosen.status!=='active' || chosen.needsReview || chosen.allowedChannels?.includes('app-human')} onClick={() => void run()}>
                执行
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function CreateObjectForm({ action, onClose, onSaved }: { action: ActionTypeDef; onClose: () => void; onSaved: () => void }) {
  const [values, setValues] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef({ values: '', key: '' });
  const parameter = action.parameters.find(p => p.name === 'values')!;
  return <form className="data-create-object" onSubmit={event => {
    event.preventDefault(); setBusy(true); setError('');
    if (request.current.values !== values) request.current = { values, key: crypto.randomUUID() };
    void call(() => api.data.invokeAction({ apiName: action.apiName, params: { values: JSON.parse(values) }, options: { idempotencyKey: request.current.key } })).then(onSaved).catch(e => setError((e as Error).message)).finally(() => setBusy(false));
  }}><h3>{action.title}</h3><ActionValuesInput parameter={parameter} value={values} onChange={setValues}/>{error && <p className="notice error" role="alert">{error}</p>}<div className="data-query-row"><button className="btn primary slim" disabled={busy}>保存对象</button><button type="button" className="btn slim ghost" disabled={busy} onClick={onClose}>取消新增</button></div></form>;
}

function RelationRows({group,apiName,id,onJump,onChanged}:{group:RelationGroup;apiName:string;id:string|number;onJump:(type:string,id:unknown)=>void;onChanged:()=>void}) {
  const [target,setTarget]=useState('');const [properties,setProperties]=useState('{}');
  const [items,setItems]=useState(group.items);const [more,setMore]=useState(group.hasMore);const [busy,setBusy]=useState(false);
  useEffect(()=>{setItems(group.items);setMore(group.hasMore);},[group]);
  const load=async()=>{setBusy(true);try{
    const result=await call<{items:LinkRef[];hasMore:boolean}>(()=>api.data.listLinks({apiName,id,linkType:group.apiName,side:group.side,offset:items.length}));
    setItems(prev=>[...prev,...result.items]);setMore(result.hasMore);
  }catch(e){toast((e as Error).message);}finally{setBusy(false);}};
  const change=async(create:boolean,targetId:string|number)=>{setBusy(true);try{
    const args={linkType:group.apiName,leftId:group.side==='left'?id:targetId,rightId:group.side==='left'?targetId:id};
    await call(()=>create?api.data.createLink({...args,properties:JSON.parse(properties)}):api.data.deleteLink(args));
    onChanged();toast(create?'关联已建立':'关联已解除');
  }catch(e){toast((e as Error).message);}finally{setBusy(false);}};
  return <div className="data-link-group"><h4>{group.title} · {group.total}</h4>{group.constraintState==='needs_repair'&&<p className="notice">历史关联需要修复，当前只读。</p>}{items.map((l,i)=><div key={`${String(l.targetId)}-${i}`}><button className="data-link-row" disabled={l.targetExists===false} onClick={()=>onJump(l.targetType,l.targetId)}>{l.targetTitle??String(l.targetId)} ({l.targetType}){l.targetExists===false?'（历史目标已删除）':''}</button>{group.writable&&<button className="btn slim ghost" disabled={busy} onClick={()=>void change(false,typeof l.targetId==='number'?l.targetId:String(l.targetId))}>解除关联</button>}</div>)}{more&&<button className="btn slim" disabled={busy} onClick={()=>void load()}>加载更多</button>}{group.writable&&<div><ObjectParameter type={group.targetType} value={target} onChange={setTarget}/><input className="form-input" aria-label="关系附加属性" placeholder="关系附加属性（JSON，可留 {}）" value={properties} onChange={e=>setProperties(e.target.value)}/><button className="btn slim" disabled={busy||!target} onClick={()=>void change(true,group.targetKeyType==='integer'?Number(target):target)}>建立关联</button></div>}</div>;

}

export function ObjectParameter({type,value,onChange}:{type:string;value:string;onChange:(value:string)=>void}) {
  const [rows,setRows]=useState<Record<string,unknown>[]>([]);const [title,setTitle]=useState('id');const [pk,setPk]=useState('id');
  const [search,setSearch]=useState('');
  useEffect(()=>{let active=true;void (async()=>{try{
    const meta=await call<{objects:ObjectTypeDef[]}>(()=>api.data.listTypes());const def=meta.objects.find(t=>t.apiName===type);
    const result=await call<ListResult>(()=>api.data.listObjects({apiName:type,search,limit:200}));
    if(active){setRows(result.rows);setTitle(def?.titleProperty??'id');setPk(def?.primaryKey??'id');}
  }catch(e){if(active)toast((e as Error).message);}})();return()=>{active=false;};},[type,search]);
  return <span><input className="form-input" aria-label="搜索关联对象" placeholder="搜索对象标题" value={search} onChange={e=>setSearch(e.target.value)}/><select className="form-select" value={value} onChange={e=>onChange(e.target.value)}><option value="">选择对象…</option>{value&&!rows.some(r=>String(r[pk])===value)&&<option value={value}>当前对象 · {value}</option>}{rows.map(r=><option key={String(r[pk])} value={String(r[pk])}>{String(r[title]??r[pk])} · {String(r[pk])}</option>)}</select></span>;
}
function ExtensionFields({def,row,action,onChanged}:{def:ObjectTypeDef;row:Record<string,unknown>;action?:ActionTypeDef;onChanged:()=>void}) {
  const props=def.properties.filter(p=>p.origin==='user'&&p.readable!==false);const [values,setValues]=useState<Record<string,string>>({});const [busy,setBusy]=useState(false);
  const [preview,setPreview]=useState<ReturnType<ActionService['preview']>|null>(null);const [error,setError]=useState('');const request=useRef({signature:'',key:''});
  useEffect(()=>{let active=true;setPreview(null);setError('');if(action&&props.length)void call<ReturnType<ActionService['preview']>>(()=>api.data.previewAction({apiName:action.apiName,params:{id:row[def.primaryKey]}})).then(result=>{if(active)setPreview(result);}).catch(e=>{if(active)setError((e as Error).message);});return()=>{active=false;};},[action?.apiName,row,def.primaryKey]);
  if(!props.length)return null;
  const save=async()=>{setBusy(true);try{const patch:Record<string,unknown>={};for(const [name,text] of Object.entries(values)){const p=props.find(p=>p.apiName===name)!;patch[name]=text===''&&p.nullable?null:p.dataType==='integer'||p.dataType==='float'?Number(text):p.dataType==='boolean'?JSON.parse(text):p.dataType==='json'?JSON.parse(text):text;}
    const signature=JSON.stringify(patch);if(request.current.signature!==signature)request.current={signature,key:crypto.randomUUID()};
    await call(()=>api.data.updateObject({apiName:def.apiName,id:typeof row[def.primaryKey]==='number'?Number(row[def.primaryKey]):String(row[def.primaryKey]),values:patch,options:{idempotencyKey:request.current.key,expectedDefinitionRevision:preview?.definitionRevision,expectedObjects:preview?.targets}}));setValues({});onChanged();toast('扩展字段已更新');
  }catch(e){toast((e as Error).message);}finally{setBusy(false);}};
  return <div><h3>用户扩展字段</h3>{props.map(p=><label className="data-param" key={p.apiName}>{p.apiName}<input className="form-input" value={values[p.apiName]??String(row[p.apiName]??'')} onChange={e=>setValues({...values,[p.apiName]:e.target.value})}/></label>)}{error&&<p className="notice error" role="alert">{error}</p>}<button className="btn slim" disabled={busy||!Object.keys(values).length||!preview||action?.status!=='active'} onClick={()=>void save()}>保存扩展字段</button>{action?.status==='disabled'&&<p className="sub">对应基础编辑动作已停用。</p>}</div>;
}
