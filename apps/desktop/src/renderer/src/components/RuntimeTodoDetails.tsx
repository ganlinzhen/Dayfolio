// 导航只接受主进程确认过的实际待办引用，沿用待办和订阅业务详情。
import { useEffect, useState } from 'react';
import { api, call } from '../api';
import CalendarItemDetails, { type CalendarDetailsTarget } from './CalendarItemDetails';

export default function RuntimeTodoDetails({ id, onClose }: { id: number; onClose: () => void }) {
  const [item, setItem] = useState<CalendarDetailsTarget|null>(null), [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [data, types] = await Promise.all([
          call<{links:Array<{targetType:string}>}>(()=>api.data.getObject({apiName:'todo',id})),
          call<{actions:Array<{apiName:string;status:string}>}>(()=>api.data.listTypes()),
        ]);
        if (!active) return;
        const allowedActions: CalendarDetailsTarget['allowedActions'] = ['open'];
        const enabled = (name: string) => types.actions.some(action=>action.apiName===name&&action.status==='active');
        if (enabled('complete_todo') && enabled('checkin')) allowedActions.push('complete');
        if (enabled('reopen_todo') && enabled('remove_checkin')) allowedActions.push('reopen');
        if (enabled('update_todo')) allowedActions.push('edit');
        if (enabled('delete_todo')) allowedActions.push('delete');
        if (enabled('unsubscribe_event') && enabled('update_todo')) allowedActions.push('unsubscribe');
        setItem({id:'todo:'+id,target:{objectType:'todo',id},kind:data.links.some(link=>link.targetType==='event_subscription')?'external_subscription':'todo',allowedActions});
      } catch(error) { if(active)setError((error as Error).message); }
    })();
    return()=>{active=false;};
  },[id]);
  return <div className="modal-mask" onClick={event=>event.target===event.currentTarget&&onClose()}><div className="modal wide runtime-todo-modal" role="dialog" aria-label="工具关联待办详情">
    {error?<div className="notice error">{error}<button className="btn slim" onClick={onClose}>关闭</button></div>:item?<CalendarItemDetails item={item} onClose={onClose} onChanged={async()=>{window.dispatchEvent(new Event('dayfolio:changed'));}}/>:<p>正在读取关联待办…</p>}
  </div></div>;
}
