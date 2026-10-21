import { useEffect, useRef, useState } from 'react';
import type { ToolTodoDraft, ToolTodoService } from '../../../../../../packages/core/src';
import { api, call } from '../api';
import Modal from './Modal';
import { toast } from './Toast';

type Preview = ReturnType<ToolTodoService['preview']>;
type Reply = (result: { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } }) => void;
type Pending = { preview: Preview; reply: Reply };
const origin = 'tool-file://t';

/** HTML 仅获得本 iframe 的消息端口；创建必须经过宿主预览与人工点击。 */
export default function HtmlToolFrame({ toolId, title, entryFile }: { toolId: number; title: string; entryFile: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let port: MessagePort | null = null, stopped = false, creating = false, inFlight = 0, nonce = '';
    const release = () => {
      port?.close(); port = null; nonce = ''; creating = false;
      setPending(null); setSelected([]); setError('');
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
          if (request.apiMajor !== 1 || JSON.stringify(request).length > 65536 || !request.params || typeof request.params !== 'object' || Array.isArray(request.params)) throw new Error('待办请求格式无效或超出限额');
          if (request.method === 'todos.getStatus' && Object.keys(request.params).every(key => key === 'sourceKeys')) {
            const data = await call(() => api.toolTodos.getStatus({ toolId, sourceKeys: request.params.sourceKeys }));
            reply({ ok: true, data });
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
          } else throw Object.assign(new Error('此页面接口只开放添加待办和查询关联状态'), { code: 'METHOD_NOT_SUPPORTED' });
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
    setPending(null);
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
    {pending && <Modal title="添加到待办" description={`来自「${pending.preview.toolTitle}」`} onClose={close} busy={busy} className="tool-todo-modal" footer={<>
      <button className="btn" onClick={close} disabled={busy}>取消</button>
      <button className="btn primary" onClick={() => void confirm()} disabled={busy || !selected.length}>{busy ? '正在添加…' : `添加 ${selected.length} 条待办`}</button>
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
