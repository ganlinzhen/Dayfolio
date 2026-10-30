import ActionButton from './ActionButton';
import { IconCheck, IconExternal, IconPencil, IconSave, IconTrash, IconUndo, IconUnlink, IconX } from './icons';
import Modal from './Modal';
// 固定目标路由：待办、学习条目与本地日程使用各自业务入口。
import { useEffect, useState } from 'react';
import { api, call } from '../api';
import type { CalendarItem } from './calendar-view';
import TodoSchedule, { type TodoScheduleValue } from './TodoSchedule';
import ToolFollowingDetails from './ToolFollowingDetails';
import type { Todo, ExternalEventRecord, EventSubscription } from '../../../../../../packages/core/src';

interface ObjectData { row: Record<string, unknown>; links: Array<{ targetType: string; targetId: string | number }> }
const STATUS: Record<string, string> = { scheduled: '已排期', postponed: '已改期', cancelled: '来源已取消', finished: '来源已结束' };
export type CalendarDetailsTarget = Pick<CalendarItem, 'id'|'kind'|'target'|'allowedActions'>;
export default function CalendarItemDetails({ item, onClose, onChanged, inModal = false, preview = false, previewTime, onBusyChange }: { inModal?: boolean; preview?: boolean; previewTime?: string; onBusyChange?: (busy:boolean)=>void; item: CalendarDetailsTarget; onClose: () => void; onChanged: () => Promise<void> }) {
  const [row, setRow] = useState<Record<string, unknown> | null>(null), [title, setTitle] = useState(''), [notes, setNotes] = useState('');
  const [schedule, setSchedule] = useState<TodoScheduleValue>({ due: '', dateOnly: true, start: '', end: '' });
  const [event, setEvent] = useState<ExternalEventRecord | null>(null), [subscription, setSubscription] = useState<EventSubscription | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirmResume, setConfirmResume] = useState(false);
  const [editing,setEditing]=useState(!preview);
  useEffect(()=>{onBusyChange?.(busy);return()=>onBusyChange?.(false);},[busy,onBusyChange]);
  const [deleteArmed,setDeleteArmed]=useState(false);
  useEffect(() => {
    let active = true; setRow(null); setEvent(null); setError(''); setConfirmResume(false);setDeleteArmed(false);
    void (async () => {
      try {
        const data = await call<ObjectData>(() => api.data.getObject({ apiName: item.target.objectType, id: item.target.id }));
        if (!active) return;
        setRow(data.row); setTitle(String(data.row.title ?? data.row.content ?? '')); setNotes(String(data.row.notes ?? ''));
        setSchedule({ due: String(data.row.due_date ?? ''), endDate: String(data.row.end_date ?? ''), dateOnly: !data.row.start_time, start: String(data.row.start_time ?? ''), end: String(data.row.end_time ?? '') });
        if (item.kind === 'external_subscription') {
          const link = data.links.find(l => l.targetType === 'event_subscription');
          if (!link) throw new Error('订阅关联已变化，请关闭后重新打开');
          const sub = await call<ObjectData>(() => api.data.getObject({ apiName: 'event_subscription', id: link.targetId }));
          const eventId = String(sub.row.event_id);
          const source = await call<ExternalEventRecord>(() => api.events.get({ eventId })); const current = await call<{subscription:EventSubscription|null;todo:Todo|null}>(() => api.subscriptions.get({ eventId }));
          if (!active) return;
          setEvent(source); setSubscription(current.subscription);
        }
      } catch (e) { if (active) setError((e as Error).message); }
    })();
    return () => { active = false; };
  }, [item.id, item.target.id, item.kind]);
  const execute = async (action: () => Promise<unknown>, close = true) => {
    setBusy(true); setError('');
    try { await action(); await onChanged(); if (close) onClose(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const saveTodo = () => execute(() => {
    if (!row) throw new Error('请等待待办加载');
    if (!schedule.dateOnly && (!schedule.due || !schedule.start)) throw new Error('请填写日期和开始时间');
    const timeChanged=schedule.due!==String(row.due_date??'')||(schedule.endDate??'')!==String(row.end_date??'')||schedule.dateOnly!==!row.start_time||schedule.start!==String(row.start_time??'')||schedule.end!==String(row.end_time??'');
    // 只改备注时保留固定时刻的权威字段，不能因重交相同钟点而误判为手动接管。
    return call(() => api.todos.update({ id: Number(item.target.id), expected_revision: Number(row.revision), title, notes,
      ...(timeChanged?{due_date: schedule.due || null, end_date: schedule.endDate || null, start_time: schedule.dateOnly ? null : schedule.start, end_time: schedule.dateOnly ? null : schedule.end || null}:{}) }));
  });
  const complete = () => execute(() => item.kind === 'plan_item'
    ? call(() => api.plans.updateItemStatus({ id: Number(item.target.id), status: row?.status === 'done' ? 'pending' : 'done' }))
    : call(() => row?.status === 'done' ? api.todos.reopen({ id: Number(item.target.id) }) : api.todos.complete({ id: Number(item.target.id) })));
  const resume = () => execute(async () => {
    if (!event || !row) return;
    return call(() => api.subscriptions.resumeFollowing({ eventId: event.id, expectedEventRevision: event.revision, expectedTodoRevision: Number(row.revision) }));
  });
  const actions = row && (<>
        {!inModal && <ActionButton icon={row.status === 'done' ? IconUndo : IconCheck} className="btn primary slim" disabled={busy||!item.allowedActions.includes(row.status==='done'?'reopen':'complete')} onClick={() => void complete()}>{row.status === 'done' ? '重新打开' : '完成'}</ActionButton>}
        {item.allowedActions.includes('edit') && item.kind!=='plan_item' && <ActionButton icon={editing ? IconSave : IconPencil} className="btn slim" disabled={busy} onClick={() => editing?void saveTodo():setEditing(true)}>{editing?'保存待办修改':'编辑待办'}</ActionButton>}
        {event && <>
          <ActionButton icon={IconUnlink} className="btn slim" disabled={busy||!item.allowedActions.includes('unsubscribe')} onClick={() => void execute(() => call(() => api.subscriptions.unsubscribe({ eventId: event.id, todoPolicy: 'keep', expectedTodoRevision: Number(row.revision) })))}>取消订阅并保留待办</ActionButton>
          {row.status !== 'done' && subscription?.syncMode === 'manual' && <ActionButton icon={IconUndo} className="btn slim" disabled={busy} onClick={() => setConfirmResume(true)}>恢复跟随…</ActionButton>}
        </>}
        {item.allowedActions.includes('delete') && <ActionButton icon={IconTrash} className="btn slim danger-btn" disabled={busy} onClick={() => deleteArmed?void execute(() => call(() => api.todos.delete({ id: Number(item.target.id) }))):setDeleteArmed(true)}>{deleteArmed?'确认删除待办':'删除待办…'}</ActionButton>}
        {inModal && <ActionButton icon={row.status === 'done' ? IconUndo : IconCheck} className="btn primary slim" disabled={busy||!item.allowedActions.includes(row.status==='done'?'reopen':'complete')} onClick={() => void complete()}>{row.status === 'done' ? '重新打开' : '完成'}</ActionButton>}
      </>);
  const content = <div className="cal-item-details" role="region" aria-label={item.kind === 'plan_item' ? '学习条目详情' : '待办与来源详情'}>
    {!inModal && !preview && <div className="cal-day-head"><strong>{item.kind === 'plan_item' ? '学习条目' : item.kind === 'external_subscription' ? '订阅待办' : '待办'}</strong><span className="spacer" /><ActionButton icon={IconX} className="btn slim" onClick={onClose}>关闭详情</ActionButton></div>}
    {error && <div className="notice error">{error}</div>}
    {!row ? <p className="sub">正在读取…</p> : <>
      {item.kind === 'plan_item' ? <><p>{String(row.content)}</p><p className="sub">计划日期 {String(row.date)} · {row.status === 'done' ? '已完成' : row.status === 'skipped' ? '已跳过' : '待完成'}</p></> : editing ? <>
        <label className="cal-field">标题<input className="inline-input" aria-label="待办详情标题" value={title} onChange={e => setTitle(e.target.value)} /></label>
        <TodoSchedule editing value={schedule} onChange={setSchedule} />
        <label className="cal-field">备注<textarea className="inline-input" aria-label="待办详情备注" value={notes} onChange={e => setNotes(e.target.value)} /></label>
        <p className="sub">修改标题或排期会转为个人安排；仅改备注继续跟随来源。</p>
      </>:<div className="cal-detail-preview"><h4>{title}</h4><p className="mono">{previewTime??`${schedule.due||'未安排日期'}${schedule.endDate&&schedule.endDate!==schedule.due?` 至 ${schedule.endDate}`:''} · ${schedule.dateOnly?'全天':`${schedule.start}${schedule.end?` – ${schedule.end}`:' · 结束待定'}`}`}</p><p>{row.status==='done'?'已完成':'待完成'}</p>{notes&&<p className="cal-preview-note">{notes}</p>}</div>}
      {event && <div className="cal-source-detail">
        <strong>{STATUS[event.status]} · {subscription?.syncMode === 'manual' ? '个人安排' : '跟随来源'}</strong>
        <p>{event.title}</p><p className="mono">{event.timeKind === 'timed' ? `${event.startAt}${event.endAt ? ' — ' + event.endAt : ' · 结束待定'}` : event.timeKind === 'all_day' ? `${event.startDate} 至 ${event.endDateExclusive}（结束日不含）` : '时间待定'}</p>
        <ActionButton icon={IconExternal} className="btn slim" onClick={() => void call(() => api.news.openUrl({url:event.sourceUrl}))}>查看原始来源</ActionButton>
        {subscription?.pendingEventRevision !== null && <p className="sub">来源有更新。个人安排和已完成记录保持保护。</p>}
        {confirmResume && <div className="notice">将用上面的来源标题与时间替换当前个人标题和排期；已保存的备注、标签、优先级保留；未保存的编辑不会被提交。<ActionButton icon={IconUndo} className="btn slim" disabled={busy} onClick={() => void resume()}>确认恢复跟随</ActionButton></div>}
      </div>}
      {item.target.objectType==='todo'&&<ToolFollowingDetails todoId={Number(item.target.id)} onChanged={async()=>{await onChanged();onClose();}}/>}
      {!inModal && <div className="cal-form-row">{actions}</div>}

    </>}
  </div>;
  return inModal ? <Modal title="工具关联待办详情" onClose={onClose} busy={busy} wide className="runtime-todo-modal" footer={actions}>{content}</Modal> : content;
}
