// 周、月、全天和当日明细共用统一日历投影及同一分类偏好。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, call } from '../api';
import { IconChevronLeft, IconChevronRight, IconPlus, IconTrash } from './icons';
import { addDay, dayOfWeek, pad, clockAt, clockLabel, sliceItems, placeTimed, placeAllDay, type CalendarItem, type CalendarResult } from './calendar-view';
import { loadCalendarPages } from './calendar-pages';
import { useRuntimeRefresh } from './useRuntimeRefresh';
import CalendarItemDetails from './CalendarItemDetails';
import RuntimeCalendarActions from './RuntimeCalendarActions';
import type { CalendarEvent } from '../../../../../../packages/core/src';

export type CalEvent = CalendarEvent;
type Mode = 'week' | 'month';
interface Form { id: number | null; title: string; date: string; endDate: string; allDay: boolean; start: string; end: string; color: string; note: string }
const WEEK = ['日','一','二','三','四','五','六'], COLORS = ['blue','green','violet','amber','rose','slate'];
const KIND: Record<CalendarItem['kind'],string> = { todo:'待办',plan_item:'学习',calendar_event:'日程',external_subscription:'订阅' };
const HOUR_H = 44;
const emptyForm = (date: string,start='',end=''):Form => ({id:null,title:'',date,endDate:'',allDay:!start,start,end,color:'blue',note:''});

export default function CalendarSection({ today }: { today:string }) {
  const [mode,setMode]=useState<Mode>(()=>localStorage.getItem('dayfolio.calView')==='month'?'month':'week');
  const [anchor,setAnchor]=useState(today),[selected,setSelected]=useState(today),[zone,setZone]=useState(''),[zoneDraft,setZoneDraft]=useState('');
  const [result,setResult]=useState<CalendarResult|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  const [form,setForm]=useState<Form|null>(null),[detail,setDetail]=useState<CalendarItem|null>(null),[formError,setFormError]=useState(''),[saving,setSaving]=useState(false);
  const [now,setNow]=useState(()=>new Date()),[changingCollection,setChangingCollection]=useState<string|null>(null);
  const scroll=useRef<HTMLDivElement|null>(null), sequence=useRef(0);
  const days=useMemo(()=>{
    if(mode==='week'){const start=addDay(anchor,-dayOfWeek(anchor));return Array.from({length:7},(_,i)=>addDay(start,i));}
    const [y,m]=anchor.split('-').map(Number), first=`${y}-${pad(m)}-01`, offset=dayOfWeek(first);
    const count=new Date(Date.UTC(y,m,0)).getUTCDate(), start=addDay(first,-offset);
    return Array.from({length:Math.ceil((offset+count)/7)*7},(_,i)=>addDay(start,i));
  },[mode,anchor]);
  const refresh=useCallback(async()=>{
    const request=++sequence.current;setLoading(true);
    for(let attempt=0;attempt<3;attempt++){
      try{
        const currentZone=await call<string>(()=>api.runtime.timezone());
        const next=await loadCalendarPages(p=>api.calendar.queryItems(p),{fromDate:days[0],toDateExclusive:addDay(days[days.length-1],1),displayTimezone:currentZone});
        if(request!==sequence.current)return;
        setResult(next);setZone(currentZone);setZoneDraft(currentZone);setError('');setLoading(false);return;
      }catch(e){if(request!==sequence.current)return;if((e as {code?:string}).code==='REVISION_CONFLICT'&&attempt<2)continue;setError((e as Error).message);setResult(null);setLoading(false);return;}
    }
  },[days]);
  useEffect(()=>{void refresh();return()=>{sequence.current++;};},[refresh]);
  useRuntimeRefresh(refresh);
  useEffect(()=>{const timer=window.setInterval(()=>setNow(new Date()),60000);return()=>window.clearInterval(timer);},[]);
  useEffect(()=>{if(selected<days[0]||selected>days[days.length-1])setSelected(anchor);},[days,anchor,selected]);
  const currentClock=zone?clockAt(now,zone):null;
  useEffect(()=>{if(mode==='week'&&scroll.current&&currentClock&&days.includes(currentClock.day))scroll.current.scrollTop=Math.max(0,currentClock.minute/60*HOUR_H-240);},[mode,days,zone]);
  const slices=useMemo(()=>sliceItems(result?.items??[],days,zone||'UTC'),[result,days,zone]);
  const selectedSlices=slices.filter(s=>s.day===selected), allDay=placeAllDay(slices,days);
  const colorOf=(item:CalendarItem)=>{const color=result?.itemColors?.[item.id]??result?.collections.find(c=>c.id===item.collectionId)?.color??'blue';return COLORS.includes(color)?color:'blue';};
  const openCreate=(date=selected,start='',end='')=>{setDetail(null);setForm(emptyForm(date,start,end));setFormError('');};
  const openItem=async(item:CalendarItem)=>{
    setForm(null);setFormError('');
    if(item.target.objectType!=='calendar_event'){setDetail(item);return;}
    setDetail(null);
    try{const {row}=await call<{row:Record<string,unknown>}>(()=>api.data.getObject({apiName:'calendar_event',id:item.target.id}));
      setForm({id:Number(row.id),title:String(row.title),date:String(row.date),endDate:String(row.end_date??''),allDay:!row.start_time,start:String(row.start_time??''),end:String(row.end_time??''),color:String(row.color),note:String(row.note??'')});
    }catch(e){setError((e as Error).message);}
  };
  const save=async()=>{
    if(!form)return;setSaving(true);setFormError('');
    try{const input={title:form.title,date:form.date,end_date:form.endDate||null,start_time:form.allDay?null:form.start||null,end_time:form.allDay?null:form.end||null,color:form.color,note:form.note};
      if(form.id===null)await call(()=>api.calendar.add(input));else await call(()=>api.calendar.update({id:form.id!,...input}));
      setForm(null);await refresh();
    }catch(e){setFormError((e as Error).message);}finally{setSaving(false);}
  };
  const remove=async()=>{if(form?.id==null)return;setSaving(true);try{await call(()=>api.calendar.delete({id:form.id!}));setForm(null);await refresh();}catch(e){setFormError((e as Error).message);}finally{setSaving(false);}};
  const shift=(n:number)=>{if(mode==='week')setAnchor(addDay(anchor,n*7));else{const[y,m]=anchor.split('-').map(Number);setAnchor(new Date(Date.UTC(y,m-1+n,1)).toISOString().slice(0,10));}};
  const select=(day:string)=>{setSelected(day);if(mode==='week')setAnchor(day);};
  const toggle=async(id:string,visible:boolean)=>{setChangingCollection(id);try{await call(()=>api.calendar.setVisibility({collectionId:id,visible}));await refresh();}catch(e){setError((e as Error).message);}finally{setChangingCollection(null);}};
  const applyZone=async()=>{try{await call(()=>api.runtime.setTimezone({zone:zoneDraft}));await refresh();}catch(e){setError((e as Error).message);}};
  const createSlot=(day:string,e:React.MouseEvent<HTMLDivElement>)=>{const rect=e.currentTarget.getBoundingClientRect(),minute=Math.max(0,Math.min(1439,Math.floor((e.clientY-rect.top)/HOUR_H*2)*30));select(day);openCreate(day,clockLabel(minute),clockLabel(Math.min(1439,minute+60)));};
  return <section className="group cal-section" aria-label="日历" aria-busy={loading}>
    <div className="cal-toolbar">
      <button className="btn slim" onClick={()=>{setAnchor(today);setSelected(today);}}>今天</button>
      <button className="icon-btn" aria-label={mode==='week'?'上一周':'上一月'} onClick={()=>shift(-1)}><IconChevronLeft width={15} height={15}/></button>
      <button className="icon-btn" aria-label={mode==='week'?'下一周':'下一月'} onClick={()=>shift(1)}><IconChevronRight width={15} height={15}/></button>
      <span className="cal-title serif">{mode==='week'?`${days[0]} — ${days[6]}`:`${anchor.slice(0,4)}年${Number(anchor.slice(5,7))}月`}</span><span className="spacer"/>
      <span className="cal-zone mono">{zone}</span>
      <div className="cal-mode-switch" role="tablist" aria-label="视图切换">{(['week','month'] as const).map(m=><button key={m} role="tab" aria-selected={mode===m} className={mode===m?'on':''} onClick={()=>{setMode(m);localStorage.setItem('dayfolio.calView',m);}}>{m==='week'?'周':'月'}</button>)}</div>
      <button className="btn primary slim" onClick={()=>openCreate()}><IconPlus width={13} height={13}/>新建日程</button>
    </div>
    <div className="cal-form-row"><RuntimeCalendarActions /></div>
    <details className="cal-display-panel"><summary>显示内容{result?` · ${result.items.length} 项`:''}</summary><div className="cal-collection-list">
      {result?.collections.map(c=><label className="cal-check" key={c.id}><input type="checkbox" aria-label={`显示${c.title}`} checked={c.visible} disabled={changingCollection!==null} onChange={e=>void toggle(c.id,e.target.checked)}/><i className={`cal-dot ${COLORS.includes(c.color)?c.color:'blue'}`}/>{c.title}{c.extensionStatus==='disabled'?' · 来源停用':c.extensionStatus==='uninstalled'?' · 来源已卸载':c.archived?' · 已归档':''}</label>)}
      <label className="cal-field">显示时区<input className="inline-input" aria-label="日历显示时区" list="calendar-timezones" value={zoneDraft} onChange={e=>setZoneDraft(e.target.value)}/></label>
      <datalist id="calendar-timezones">{['Asia/Shanghai','Europe/London','UTC','America/New_York'].map(z=><option key={z} value={z}/>)}</datalist>
      <button className="btn slim" disabled={!zoneDraft||zoneDraft===zone} onClick={()=>void applyZone()}>应用时区</button>
    </div></details>
    {error&&<div className="notice error">{error}<button className="btn slim" onClick={()=>void refresh()}>重试</button></div>}
    {mode==='week'?<div className="cal-weekview">
      <div className="cal-week-head"><span className="cal-axis-head mono">时间</span>{days.map(day=><button key={day} className={`cal-wd-col ${day===today?'today-col':''} ${day===selected?'sel-col':''}`} onClick={()=>select(day)} aria-label={day}><span className="cal-wd-text">周{WEEK[dayOfWeek(day)]}</span><span className={`cal-num ${day===today?'today-num':''}`}>{Number(day.slice(8))}</span><span className="cal-day-meta mono">{result?.countsByDay[day]??0} 项</span></button>)}</div>
      <div className="cal-allday"><span className="cal-axis-head mono">全天</span><div className="cal-allday-lane" style={{height:Math.max(1,allDay.length)*26}}>{allDay.map((row,ri)=>row.map(({item,start,span})=><button key={item.id} data-calendar-kind={item.kind} data-item-id={item.id} className={`cal-allday-chip ${colorOf(item)}`} style={{left:`calc(${start/7*100}% + 2px)`,width:`calc(${span/7*100}% - 4px)`,top:ri*26+2,height:22}} onClick={()=>{select(days[start]);void openItem(item);}} title={item.title}><i className={`cal-dot ${colorOf(item)}`}/><span className="cal-ev-text">{item.title}</span></button>))}</div></div>
      <div className="cal-weekgrid"><div className="cal-scroll" ref={scroll}><div className="cal-scroll-inner" style={{height:24*HOUR_H}}><div className="cal-axis">{Array.from({length:24},(_,h)=><div key={h} className="cal-axis-tick" style={{top:h*HOUR_H}}>{h%2===0&&<span className="mono">{pad(h)}:00</span>}</div>)}</div>
        <div className="cal-daycols">{days.map(day=><div key={day} className={`cal-col ${day===today?'today-col-bg':''}`} role="gridcell" aria-label={`${day}时间网格`} onClick={e=>createSlot(day,e)}>{placeTimed(slices.filter(s=>s.day===day&&!s.allDay)).map(s=><button key={`${s.item.id}/${day}`} data-calendar-kind={s.item.kind} data-item-id={s.item.id} className={`cal-evt-block ${colorOf(s.item)}`} style={{top:s.startMinute/60*HOUR_H,height:Math.max(20,(s.visualEnd-s.startMinute)/60*HOUR_H),left:`calc(${s.col/s.cols*100}% + 1px)`,width:`calc(${100/s.cols}% - 2px)`}} onClick={e=>{e.stopPropagation();select(day);void openItem(s.item);}} title={`${s.label} ${s.item.title}`}><span className="cal-evt-block-time mono">{s.label}</span><span className="cal-evt-block-title">{s.item.title}</span></button>)}</div>)}
          {currentClock&&days.includes(currentClock.day)&&<div className="cal-nowline" style={{top:currentClock.minute/60*HOUR_H}} aria-hidden><span className="cal-nowtime mono">{currentClock.label}</span></div>}
        </div></div></div></div>
    </div>:<><div className="cal-week" aria-hidden>{WEEK.map(w=><span key={w} className="cal-wd mono">周{w}</span>)}</div><div className="cal-grid" role="grid" aria-label="月视图">{days.map(day=>{const entries=slices.filter(s=>s.day===day);return <button key={day} role="gridcell" className={`cal-cell ${day.slice(0,7)!==anchor.slice(0,7)?'out':''} ${day===today?'today':''} ${day===selected?'sel':''}`} aria-label={day} aria-pressed={day===selected} onClick={()=>select(day)}><span className="cal-num">{Number(day.slice(8))}</span>{entries.slice(0,2).map(s=><span key={s.item.id} className="cal-ev" data-calendar-kind={s.item.kind}><i className={`cal-dot ${colorOf(s.item)}`}/><span className="cal-ev-text">{!s.allDay?`${clockLabel(s.startMinute)} `:''}{s.item.title}</span></span>)}{entries.length>2&&<span className="cal-more mono">+{entries.length-2}</span>}<span className="cal-day-meta mono">{result?.countsByDay[day]??0} 项</span></button>;})}</div></>}
    <div className="cal-day"><div className="cal-day-head"><span className="cal-day-title serif">{Number(selected.slice(5,7))}月{Number(selected.slice(8))}日</span><span className="mono">周{WEEK[dayOfWeek(selected)]} · {selected} · {result?.countsByDay[selected]??0} 项</span>{selected===today&&<span className="cal-badge today-badge">今天</span>}</div>
      {form&&<div className="cal-form" aria-label={form.id===null?'新建日程':'编辑日程'}><div className="cal-form-row"><input className="inline-input cal-title-input" aria-label="日程标题" placeholder="日程标题" value={form.title} onChange={e=>setForm({...form,title:e.target.value})} onKeyDown={e=>{if(e.key==='Enter')void save();}} autoFocus/></div>
        <div className="cal-form-row"><label className="cal-field">日期<input className="chip-date" type="date" aria-label="开始日期" value={form.date} onChange={e=>setForm({...form,date:e.target.value})}/></label><label className="cal-field">结束<input className="chip-date" type="date" aria-label="结束日期" value={form.endDate} onChange={e=>setForm({...form,endDate:e.target.value})}/></label><label className="cal-check"><input type="checkbox" checked={form.allDay} onChange={e=>setForm({...form,allDay:e.target.checked})}/>全天</label><label className="cal-field">开始<input className="cal-time" type="time" aria-label="开始时间" disabled={form.allDay} value={form.start} onChange={e=>setForm({...form,start:e.target.value})}/></label><label className="cal-field">结束<input className="cal-time" type="time" aria-label="结束时间" disabled={form.allDay} value={form.end} onChange={e=>setForm({...form,end:e.target.value})}/></label></div>
        <div className="cal-form-row"><span className="cal-colors" role="radiogroup" aria-label="颜色">{COLORS.map(c=><button key={c} className={`cal-color-btn ${form.color===c?'on':''}`} role="radio" aria-label={c} aria-checked={form.color===c} onClick={()=>setForm({...form,color:c})}><i className={`cal-dot ${c}`}/></button>)}</span><input className="inline-input cal-note-input" aria-label="日程备注" placeholder="备注（可选）" value={form.note} onChange={e=>setForm({...form,note:e.target.value})}/></div>
        {formError&&<div className="notice error">{formError}</div>}<div className="cal-form-row"><button className="btn primary slim" disabled={saving} onClick={()=>void save()}>{form.id===null?'创建日程':'保存修改'}</button><button className="btn slim" onClick={()=>setForm(null)}>取消</button>{form.id!==null&&<button className="btn slim danger-btn" disabled={saving} onClick={()=>void remove()}><IconTrash width={13} height={13}/>删除</button>}</div>
      </div>}
      {detail&&<CalendarItemDetails key={detail.id} item={detail} onClose={()=>setDetail(null)} onChanged={refresh}/>}
      {!selectedSlices.length&&!form&&<p className="sub cal-empty">这一天没有已显示的安排。可调整「显示内容」或新建日程。</p>}
      {selectedSlices.map(s=><div key={s.item.id} className="cal-ev-row" data-calendar-kind={s.item.kind} data-item-id={s.item.id}><i className={`cal-dot ${colorOf(s.item)}`}/><span className="cal-ev-time mono">{s.label}</span><button className="cal-item-open cal-ev-title" onClick={()=>void openItem(s.item)}>{s.item.title}</button><span className="cal-badge">{KIND[s.item.kind]}</span>{s.item.status==='done'&&<span className="cal-badge">已完成</span>}{s.item.sourceStatus==='cancelled'&&<span className="cal-badge">来源已取消</span>}<span className="sub">{result?.collections.find(c=>c.id===s.item.collectionId)?.title}</span></div>)}
    </div><div className="cal-legend mono">所有视图使用相同分类和统计；跨午夜按天展示，结束待定只使用视觉高度。{loading?'正在刷新…':''}</div>
  </section>;
}
