import ActionButton from './ActionButton';
import { IconHeart, IconPlus, IconUnlink, IconX } from './icons';
import { useEffect, useRef, useState } from 'react';
import type { ToolTodoDraft, ToolTodoService,ToolFollowingService } from '../../../../../../packages/core/src';
import { api, call } from '../api';
import Modal from './Modal';
import { toast } from './Toast';

type Preview = ReturnType<ToolTodoService['preview']>;
type Reply = (result: { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } }) => void;
type Pending = { preview: Preview; reply: Reply };
type FollowPreview=ReturnType<ToolFollowingService['preview']>;
type PendingFollow={preview:FollowPreview;action:'follow'|'unfollow';reply:Reply};
const origin = 'tool-file://t';

/** HTML 仅获得本 iframe 的消息端口；创建必须经过宿主预览与人工点击。 */
export default function HtmlToolFrame({ toolId, title, entryFile }: { toolId: number; title: string; entryFile: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [pendingFollow,setPendingFollow]=useState<PendingFollow|null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let port: MessagePort | null = null, stopped = false, creating = false, inFlight = 0, nonce = '';
    const release = () => {
      port?.close(); port = null; nonce = ''; creating = false;
      setPending(null);setPendingFollow(null); setSelected([]); setError('');
    };
    const hello = (event: MessageEvent) => {
      if (stopped || event.source !== frame.current?.contentWindow || event.origin !== origin || event.data?.type !== 'dayfolio:tool:hello' || event.data.apiMajor !== 1 || typeof event.data.nonce !== 'string' || event.data.nonce.length > 100) return;
      if (nonce === event.data.nonce && port) return;
      release(); nonce = event.data.nonce;
      const channel = new MessageChannel(); port = channel.port1;
      const active = port;
      active.onmessage = async ({ data: request }) => {
        const requestId = request?.requestId;
        if (stopped || port !== active || typeof requestId !== 'string' || requestId.length > 100) return;
        const reply: Reply = result => { if (!stopped && port === active) active.postMessage({ requestId, ...result }); };
        if (inFlight >= 8) { reply({ ok: false, error: { code: 'REQUEST_LIMIT', message: '请求过多，请稍后再试' } }); return; }
        inFlight++;
        try {
          const maxBytes=request.method==='following.publish'?512*1024:65536;
          if (request.apiMajor !== 1 || new TextEncoder().encode(JSON.stringify(request)).byteLength > maxBytes || !request.params || typeof request.params !== 'object' || Array.isArray(request.params)) throw new Error('待办请求格式无效或超出限额');
          if (request.method === 'todos.getStatus' && Object.keys(request.params).every(key => key === 'sourceKeys')) {
            const data = await call(() => api.toolTodos.getStatus({ toolId, sourceKeys: request.params.sourceKeys }));
            reply({ ok: true, data });
          } else if(request.method==='todos.open'&&Object.keys(request.params).every(key=>key==='sourceKey')){
            if(creating)throw Object.assign(new Error('请先完成当前确认'),{code:'REQUEST_BUSY'});
            const states=await call<ReturnType<ToolTodoService['getStatus']>>(()=>api.toolTodos.getStatus({toolId,sourceKeys:[request.params.sourceKey]}));
            const id=states[0]?.todoId;if(!id)throw new Error('关联待办不存在或已删除');
            window.dispatchEvent(new CustomEvent('dayfolio:openTodo',{detail:{id}}));reply({ok:true,data:{todoId:id}});
          } else if (request.method === 'todos.create' && Object.keys(request.params).every(key => key === 'items' || key === 'category')) {
            if (creating) { reply({ ok: false, error: { code: 'REQUEST_BUSY', message: '请先完成当前待办确认' } }); return; }
            creating = true;
            try {
              const preview = await call<Preview>(() => api.toolTodos.preview({ toolId, items: request.params.items, category: request.params.category }));
              if (stopped || port !== active) return;
              if (preview.items.every(item => item.status !== 'missing')) {
                reply({ ok: true, data: { created: 0, reused: preview.items.filter(i => i.status !== 'deleted').length, deleted: preview.items.filter(i => i.status === 'deleted').length, items: preview.items.map(({ sourceKey, todoId, status }) => ({ sourceKey, todoId, status })), category: preview.category.exists ? preview.category : null } });
                creating = false;
              } else {
                setError(''); setSelected(preview.items.filter(i => i.status === 'missing').map(i => i.sourceKey));
                setPending({ preview, reply: result => { creating = false; reply(result); } });
              }
            } catch (error) { creating = false; throw error; }
          } else if(request.method==='following.publish'&&Object.keys(request.params).every(key=>key==='snapshot')){
            reply({ok:true,data:await call(()=>api.toolFollowing.publish({toolId,snapshot:request.params.snapshot}))});
          } else if(request.method==='following.getState'&&Object.keys(request.params).every(key=>key==='sourceKeys')){
            reply({ok:true,data:await call(()=>api.toolFollowing.getState({toolId,sourceKeys:request.params.sourceKeys}))});
          } else if(['following.preview','following.follow','following.unfollow'].includes(request.method)&&Object.keys(request.params).every(key=>key==='scope')){
            if(request.method==='following.preview'){reply({ok:true,data:await call(()=>api.toolFollowing.preview({toolId,scope:request.params.scope}))});return;}
            if(creating){reply({ok:false,error:{code:'REQUEST_BUSY',message:'请先完成当前待办确认'}});return;}
            creating=true;
            try{
              const preview=await call<FollowPreview>(()=>api.toolFollowing.preview({toolId,scope:request.params.scope}));
              if(stopped||port!==active)return;
              if(request.method==='following.follow'&&preview.active){creating=false;reply({ok:true,data:{created:0,...await call<ReturnType<ToolFollowingService['getState']>>(()=>api.toolFollowing.getState({toolId}))}});return;}
              setError('');setPendingFollow({preview,action:request.method==='following.follow'?'follow':'unfollow',reply:result=>{creating=false;reply(result);}});
            }catch(error){creating=false;throw error;}
          } else throw Object.assign(new Error('此页面接口只开放本工具的待办与持续关注'), { code: 'METHOD_NOT_SUPPORTED' });
        } catch (error) {
          reply({ ok: false, error: { code: (error as { code?: string }).code ?? 'CONTRACT_INVALID', message: (error as Error).message } });
        } finally { inFlight--; }
      };
      active.start();
      frame.current?.contentWindow?.postMessage({ type: 'dayfolio:tool:port', nonce }, origin, [channel.port2]);
    };
    const element = frame.current;
    element?.addEventListener('load', release);
    window.addEventListener('message', hello);
    return () => { stopped = true; port?.close(); element?.removeEventListener('load', release); window.removeEventListener('message', hello); };
  }, [toolId, entryFile]);

  const close = () => {
    if (busy) return;
    pending?.reply({ ok: false, error: { code: 'USER_CANCELLED', message: '已取消添加待办' } });
    pendingFollow?.reply({ok:false,error:{code:'USER_CANCELLED',message:'已取消关注操作'}});
    setPending(null);
    setPendingFollow(null);
  };
  const confirmFollow=async()=>{
    if(!pendingFollow||busy)return;setBusy(true);setError('');
    try{
      const p=pendingFollow.preview,input={toolId,scope:p.scope};
      const data=pendingFollow.action==='follow'?await call(()=>api.toolFollowing.follow({...input,expectedRevision:p.revision})):await call(()=>api.toolFollowing.unfollow(input));
      pendingFollow.reply({ok:true,data});toast(pendingFollow.action==='follow'?'已持续关注，后续资料更新时自动同步':'已取消关注，已有待办保留');setPendingFollow(null);
    }catch(error){setError((error as Error).message);}finally{setBusy(false);}
  };
  const confirm = async () => {
    if (!pending || !selected.length || busy) return;
    setBusy(true); setError('');
    try {
      const items: ToolTodoDraft[] = pending.preview.items.filter(i => selected.includes(i.sourceKey)).map(({ todoId: _id, status: _status, ...draft }) => draft);
      const { key, title, color } = pending.preview.category;
      const data = await call<ReturnType<ToolTodoService['create']>>(() => api.toolTodos.create({ toolId, items, category: { key, title, color } }));
      pending.reply({ ok: true, data }); setPending(null);
      toast(`已添加 ${data.created} 条待办${data.reused ? `，${data.reused} 条已存在` : ''}`);
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  const formatTime = (item: Preview['items'][number]) => item.startAt
    ? new Intl.DateTimeFormat('zh-CN', { timeZone: pending!.preview.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(item.startAt))
    : item.dueDate || '时间待定 · 不排期';

  return <>
    <iframe ref={frame} className="tool-iframe" title={title} sandbox="allow-scripts allow-same-origin" src={`tool-file://t/${toolId}/${encodeURI(entryFile)}`} />
    {pendingFollow&&<Modal title={pendingFollow.action==='follow'?'持续关注':'取消持续关注'} description={`来自「${pendingFollow.preview.toolTitle}」`} onClose={close} busy={busy} className="tool-follow-modal" footer={<><ActionButton icon={IconX} className="btn" disabled={busy} onClick={close}>取消</ActionButton><ActionButton icon={pendingFollow.action === 'follow' ? IconHeart : IconUnlink} className="btn primary" disabled={busy} onClick={()=>void confirmFollow()}>{busy?'正在保存…':pendingFollow.action==='follow'?'确认持续关注':'取消关注并保留待办'}</ActionButton></>}>
      <h3>{pendingFollow.preview.title}</h3>
      <p>{pendingFollow.action==='follow'?(pendingFollow.preview.scope.kind==='group'?'关注此分组的未来事项。首次加入当前已知事项；后续资料更新时，新增事项会自动加入，改期同步到尚未手动接管的待办。':'关注此事项，后续资料更新时自动同步标题和排期。'):'停止此范围的后续自动同步，已有待办及完成记录全部保留。其他仍有效的分组规则继续生效；取消单项会阻止分组重新启用该事项。'}</p>
      <p className="sub">手动修改标题或时间后转为个人安排；备注、标签和优先级保留。已完成记录不改动，已删除记录不自动恢复。资料需要由页面或助手更新，这项能力不会自行联网采集。</p>
      <p className="tool-todo-category">待办分类：<strong>{pendingFollow.preview.category.title}</strong>{!pendingFollow.preview.category.exists&&<span className="sub"> · 实际新增待办时创建</span>}</p>
      {!pendingFollow.preview.items.length&&<p className="notice">目前没有可加入的未来事项。确认后保存关注，资料更新出现匹配事项时再加入。</p>}
      <div className="tool-todo-list">{pendingFollow.preview.items.map(item=><div className="tool-todo-row" key={item.sourceKey}><span><strong>{item.title}</strong><small>{item.startAt?new Intl.DateTimeFormat('zh-CN',{timeZone:pendingFollow.preview.timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(item.startAt)):item.dueDate||'时间待定 · 不排期'}</small></span><small>{item.status==='done'?'已完成，保留':item.status==='deleted'?'已删除，不恢复':item.mode==='manual'?'个人安排，保留':item.status==='open'?'复用已有待办':'将加入'}</small></div>)}</div>
      {error&&<p className="notice error" role="alert">{error}</p>}
    </Modal>}
    {pending && <Modal title="添加到待办" description={`来自「${pending.preview.toolTitle}」`} onClose={close} busy={busy} className="tool-todo-modal" footer={<>
      <ActionButton icon={IconX} className="btn" onClick={close} disabled={busy}>取消</ActionButton>
      <ActionButton icon={IconPlus} className="btn primary" onClick={() => void confirm()} disabled={busy || !selected.length}>{busy ? '正在添加…' : `添加 ${selected.length} 条待办`}</ActionButton>
    </>}>
      <p className="sub">选择要添加的事项，时间按 {pending.preview.timezone} 显示。本次添加保存当前内容，后续资料变化不会自动修改待办。</p>
      <p className="tool-todo-category">待办分类：<strong>{pending.preview.category.title}</strong><span className="sub">{pending.preview.category.exists ? ' · 已有分类' : ' · 确认添加后创建'}{!pending.preview.category.visible ? ' · 当前在日历中隐藏' : ''}</span></p>
      {pending.preview.items.length > 1 && <label className="tool-todo-select-all"><input type="checkbox" disabled={busy} checked={selected.length === pending.preview.items.filter(i => i.status === 'missing').length} onChange={e => setSelected(e.target.checked ? pending.preview.items.filter(i => i.status === 'missing').map(i => i.sourceKey) : [])} />全选可添加事项</label>}
      <div className="tool-todo-list">{pending.preview.items.map(item => <label className="tool-todo-row" key={item.sourceKey}>
        <input type="checkbox" checked={selected.includes(item.sourceKey)} disabled={busy || item.status !== 'missing'} onChange={e => setSelected(keys => e.target.checked ? [...keys, item.sourceKey] : keys.filter(key => key !== item.sourceKey))} />
        <span><strong>{item.title}</strong><small>{formatTime(item)}{item.endAt ? ` — ${new Intl.DateTimeFormat('zh-CN', { timeZone: pending.preview.timezone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(item.endAt))}` : ''}</small>{item.notes && <small>{item.notes}</small>}{item.sourceUrl && <small className="mono">{item.sourceUrl}</small>}</span>
        {item.status !== 'missing' && <small>{item.status === 'deleted' ? '已移除，不重复添加' : item.status === 'done' ? '已完成' : '已添加'}</small>}
      </label>)}</div>
      {error && <p className="notice error" role="alert">{error}</p>}
    </Modal>}
  </>;
}
