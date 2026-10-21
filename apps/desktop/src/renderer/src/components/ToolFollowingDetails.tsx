import { useEffect,useState } from 'react';
import type { ToolFollowingService } from '../../../../../../packages/core/src';
import { api,call } from '../api';

type Details=ReturnType<ToolFollowingService['getTodo']>;
export default function ToolFollowingDetails({todoId,onChanged}:{todoId:number;onChanged:()=>Promise<void>}) {
  const [info,setInfo]=useState<Details>(null),[zone,setZone]=useState('UTC'),[error,setError]=useState(''),[busy,setBusy]=useState(false),[confirm,setConfirm]=useState(false);
  useEffect(()=>{let active=true;void Promise.all([call<Details>(()=>api.toolFollowing.getTodo({todoId})),call<string>(()=>api.runtime.timezone())]).then(([next,timezone])=>{if(active){setInfo(next);setZone(timezone);}}).catch(e=>{if(active)setError((e as Error).message);});return()=>{active=false;};},[todoId]);
  const execute=async(action:()=>Promise<unknown>)=>{
    setBusy(true);setError('');try{await action();setConfirm(false);setInfo(await call<Details>(()=>api.toolFollowing.getTodo({todoId})));await onChanged();}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };
  if(!info)return error?<p className="notice error" role="alert">{error}</p>:null;
  const time=info.source.startAt?new Intl.DateTimeFormat('zh-CN',{timeZone:zone,dateStyle:'medium',timeStyle:'short'}).format(new Date(info.source.startAt)):info.source.dueDate||'时间待定';
  return <div className="cal-source-detail tool-follow-details" aria-label="HTML 工具持续关注详情">
    <strong>{info.toolTitle} · {!info.following?'已停止关注':info.mode==='completed'?'已完成，保护记录':info.mode==='manual'?'个人安排，暂停覆盖':'持续关注中'}</strong>
    <p>最新来源：{info.source.title}</p><p>{time} · {info.sourceStatus==='cancelled'?'来源已取消':info.sourceStatus==='finished'?'来源已结束':info.sourceStatus==='postponed'?'来源已改期':'来源已排期'}</p>
    {info.pendingSourceRevision!==null&&<p className="sub">来源有更新；手动修改与已完成内容保持保护。</p>}
    {info.following&&<div className="cal-form-row"><button className="btn slim" disabled={busy} onClick={()=>void execute(()=>call(()=>api.toolFollowing.stopTodo({todoId})))}>停止关注并保留待办</button>{info.mode!=='completed'&&(info.mode==='manual'||info.pendingSourceRevision!==null)&&<button className="btn slim" disabled={busy} onClick={()=>setConfirm(true)}>恢复跟随…</button>}</div>}
    {confirm&&<div className="notice">将用上面的最新来源替换个人标题和排期，保留备注、标签及优先级。未保存的编辑不会提交。<div className="cal-form-row"><button className="btn slim" disabled={busy} onClick={()=>setConfirm(false)}>取消恢复</button><button className="btn slim" disabled={busy} onClick={()=>void execute(()=>call(()=>api.toolFollowing.resume({todoId,expectedSourceRevision:info.sourceRevision,expectedTodoRevision:info.todoRevision})))}>确认恢复跟随</button></div></div>}
    {error&&<p className="notice error" role="alert">{error}</p>}
  </div>;
}
