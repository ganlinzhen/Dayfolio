import ActionButton from './ActionButton';
import { IconPencil, IconRefresh, IconSave, IconX } from './icons';
// 周、月、全天和范围明细共用统一日历投影及同一分类偏好。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CalendarPopover from './CalendarPopover';
import CalendarAgenda from './CalendarAgenda';
import { CALENDAR_HOUR_HEIGHT as HOUR_H, CALENDAR_STEP, slotMinute, draftEnd, draftTimes, type CalendarDraft } from './calendar-draft';
import { api, call } from '../api';
import { IconChevronLeft, IconChevronRight, IconPlus, IconTrash } from './icons';
import { addDay, dayOfWeek, weekDays, pad, clockAt, clockLabel, sliceItems, placeTimed, placeAllDay, type AgendaMode, type CalendarItem, type CalendarResult } from './calendar-view';
import { loadCalendarPages } from './calendar-pages';
import { useRuntimeRefresh } from './useRuntimeRefresh';
import CalendarItemDetails from './CalendarItemDetails';
import RuntimeCalendarActions from './RuntimeCalendarActions';
import CalendarCollections from './CalendarCollections';
import type { CalendarEvent } from '../../../../../../packages/core/src';

export type CalEvent = CalendarEvent;
type Mode = 'week' | 'month';
interface Form { id: number | null; title: string; date: string; endDate: string; allDay: boolean; start: string; end: string; color: string; note: string }
const WEEK = ['日','一','二','三','四','五','六'], COLORS = ['blue','green','violet','amber','rose','slate'];
const emptyForm = (date: string,start='',end=''):Form => ({id:null,title:'',date,endDate:'',allDay:!start,start,end,color:'blue',note:''});

export default function CalendarSection({ today }: { today:string }) {
  const [mode,setMode]=useState<Mode>(()=>localStorage.getItem('dayfolio.calView')==='month'?'month':'week');
  const [agendaMode,setAgendaMode]=useState<AgendaMode>('day'),[detailTime,setDetailTime]=useState('');
  const [anchor,setAnchor]=useState(today),[selected,setSelected]=useState(today),[zone,setZone]=useState('');
  const [result,setResult]=useState<CalendarResult|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  const [form,setForm]=useState<Form|null>(null),[detail,setDetail]=useState<CalendarItem|null>(null),[formError,setFormError]=useState(''),[saving,setSaving]=useState(false),[detailBusy,setDetailBusy]=useState(false);
  const [popoverAnchor,setPopoverAnchor]=useState<HTMLElement|null>(null),[draft,setDraft]=useState<CalendarDraft|null>(null),[dragging,setDragging]=useState(false);
  const draftElement=useRef<HTMLDivElement>(null),draftValue=useRef<CalendarDraft|null>(null);
  const gesture=useRef<{pointerId:number;column:HTMLElement;offset:number;clientY:number}|null>(null);
  const [now,setNow]=useState(()=>new Date());
  const scroll=useRef<HTMLDivElement|null>(null), sequence=useRef(0);
  const days=useMemo(()=>{
    if(mode==='week')return weekDays(anchor);
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
        setResult(next);setZone(currentZone);setError('');setLoading(false);return;
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
  const allDay=placeAllDay(slices,days);
  const colorOf=(item:CalendarItem)=>{const color=result?.itemColors?.[item.id]??result?.collections.find(c=>c.id===item.collectionId)?.color??'blue';return COLORS.includes(color)?color:'blue';};
  const dismissPopover=()=>{setPopoverAnchor(null);setForm(null);setDetail(null);setDetailBusy(false);setDraft(null);draftValue.current=null;};
  const closePopover=()=>{if(!saving&&!detailBusy)dismissPopover();};
  const openCreate=(element:HTMLElement,date=selected,start='',end='')=>{if(saving||detailBusy)return;setDraft(null);draftValue.current=null;setDetail(null);setPopoverAnchor(element);setForm(emptyForm(date,start,end));setFormError('');};
  const openItem=(item:CalendarItem,element:HTMLElement,time='')=>{
    if(saving||detailBusy)return;
    setDraft(null);draftValue.current=null;setForm(null);setFormError('');setDetailTime(time);setDetail(item);setPopoverAnchor(element);
  };
  const editEvent=async()=>{
    if(!detail||saving)return;
    setSaving(true);
    const item=detail;
    try{const {row}=await call<{row:Record<string,unknown>}>(()=>api.data.getObject({apiName:'calendar_event',id:item.target.id}));
      if(!popoverAnchor?.isConnected)return;
      setDetail(null);setForm({id:Number(row.id),title:String(row.title),date:String(row.date),endDate:String(row.end_date??''),allDay:!row.start_time,start:String(row.start_time??''),end:String(row.end_time??''),color:String(row.color),note:String(row.note??'')});
    }catch(e){setFormError((e as Error).message);}finally{setSaving(false);}
  };
  const save=async()=>{
    if(!form||saving)return;setSaving(true);setFormError('');
    try{const input={title:form.title,date:form.date,end_date:form.endDate||null,start_time:form.allDay?null:form.start||null,end_time:form.allDay?null:form.end||null,color:form.color,note:form.note};
      if(form.id===null)await call(()=>api.calendar.add(input));else await call(()=>api.calendar.update({id:form.id!,...input}));
      setPopoverAnchor(null);setForm(null);setDraft(null);draftValue.current=null;await refresh();
    }catch(e){setFormError((e as Error).message);}finally{setSaving(false);}
  };
  const remove=async()=>{if(form?.id==null)return;setSaving(true);try{await call(()=>api.calendar.delete({id:form.id!}));setPopoverAnchor(null);setForm(null);setDraft(null);await refresh();}catch(e){setFormError((e as Error).message);}finally{setSaving(false);}};
  const shift=(n:number)=>{closePopover();if(mode==='week')setAnchor(addDay(anchor,n*7));else{const[y,m]=anchor.split('-').map(Number);setAnchor(new Date(Date.UTC(y,m-1+n,1)).toISOString().slice(0,10));}};
  const select=(day:string)=>{setSelected(day);setAgendaMode('day');};
  const updateDraft=(value:CalendarDraft)=>{draftValue.current=value;setDraft(value);};
  useEffect(()=>{
    const value=draftValue.current;
    if(!value||!form||form.id!==null||dragging||form.allDay||!form.date||!form.start||!form.end)return;
    const minute=(time:string)=>Number(time.slice(0,2))*60+Number(time.slice(3));
    const start=minute(form.start),end=form.endDate===addDay(form.date,1)&&form.end==='00:00'?1440:!form.endDate||form.endDate===form.date?minute(form.end):0;
    if(end<=start)return;
    if(value.day!==form.date||value.start!==start||value.end!==end)updateDraft({day:form.date,start,end});
  },[form?.date,form?.start,form?.end,form?.endDate,form?.allDay,dragging]);
  const finishDraft=()=>{
    const value=draftValue.current;gesture.current=null;setDragging(false);
    if(!value||!draftElement.current)return;
    setForm(current=>({...current??emptyForm(value.day),...draftTimes(value),allDay:false}));setFormError('');setPopoverAnchor(draftElement.current);
  };
  const beginDraft=(day:string,event:React.PointerEvent<HTMLDivElement>,resize=false)=>{
    if(event.button!==0||saving||detailBusy||(!resize&&event.target!==event.currentTarget))return;
    event.preventDefault();event.stopPropagation();
    const column=resize?event.currentTarget.closest<HTMLElement>('.cal-col')!:event.currentTarget;
    const start=slotMinute(event.clientY-column.getBoundingClientRect().top);
    const value=resize&&draftValue.current?draftValue.current:{day,start,end:start+CALENDAR_STEP};
    updateDraft(value);setSelected(day);setAgendaMode('day');setDetail(null);if(!resize)setForm(null);setPopoverAnchor(null);setDragging(true);
    gesture.current={pointerId:event.pointerId,column,offset:value.end-(event.clientY-column.getBoundingClientRect().top)/HOUR_H*60,clientY:event.clientY};
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDraft=(clientY:number)=>{
    const current=gesture.current,value=draftValue.current;if(!current||!value)return;
    current.clientY=clientY;
    updateDraft({...value,end:draftEnd(value.start,(clientY-current.column.getBoundingClientRect().top)/HOUR_H*60+current.offset)});
  };
  // 拖到可视网格边缘时继续滚动，保持结束刻度与指针一致。
  useEffect(()=>{
    if(!dragging)return;
    let frame:number;
    const tick=()=>{const current=gesture.current,container=scroll.current;if(current&&container){const rect=container.getBoundingClientRect();const delta=current.clientY>rect.bottom-28?8:current.clientY<rect.top+28?-8:0;if(delta){container.scrollTop+=delta;moveDraft(current.clientY);}}frame=requestAnimationFrame(tick);};
    frame=requestAnimationFrame(tick);
    const cancel=(event:KeyboardEvent)=>{if(event.key==='Escape'){gesture.current=null;setDragging(false);setDraft(null);draftValue.current=null;setForm(null);setPopoverAnchor(null);}};
    window.addEventListener('keydown',cancel);
    return()=>{cancelAnimationFrame(frame);window.removeEventListener('keydown',cancel);};
  },[dragging]);
  const pointerMove=(event:React.PointerEvent)=>{if(gesture.current?.pointerId===event.pointerId)moveDraft(event.clientY);};
  const pointerEnd=(event:React.PointerEvent)=>{if(gesture.current?.pointerId===event.pointerId)finishDraft();};
  const pointerCancel=()=>{gesture.current=null;setDragging(false);setDraft(null);draftValue.current=null;setForm(null);setPopoverAnchor(null);};
  return <section className="group cal-section" aria-label="日历" aria-busy={loading}>
    <div className="cal-toolbar">
      <button className="btn slim" onClick={()=>{closePopover();setAnchor(today);setSelected(today);setAgendaMode('day');}}>今天</button>
      <button className="icon-btn" aria-label={mode==='week'?'上一周':'上一月'} onClick={()=>shift(-1)}><IconChevronLeft width={15} height={15}/></button>
      <button className="icon-btn" aria-label={mode==='week'?'下一周':'下一月'} onClick={()=>shift(1)}><IconChevronRight width={15} height={15}/></button>
      <span className="cal-title serif">{mode==='week'?`${days[0]} — ${days[6]}`:`${anchor.slice(0,4)}年${Number(anchor.slice(5,7))}月`}</span><span className="spacer"/>
      <span className="cal-zone mono">{zone}</span>
      <div className="cal-mode-switch" role="tablist" aria-label="视图切换">{(['week','month'] as const).map(m=><button key={m} role="tab" aria-selected={mode===m} className={mode===m?'on':''} onClick={()=>{closePopover();setMode(m);localStorage.setItem('dayfolio.calView',m);}}>{m==='week'?'周':'月'}</button>)}</div>
      <div className="cal-create-actions"><ActionButton icon={IconPlus} className="btn primary slim" onClick={e=>openCreate(e.currentTarget)}>新建日程</ActionButton>
        <CalendarCollections collections={result?.collections??[]} timezone={zone} onChanged={refresh} disabled={!result}/></div>
    </div>
    <div className="cal-form-row"><RuntimeCalendarActions /></div>

    {error&&<div className="notice error">{error}<ActionButton icon={IconRefresh} className="btn slim" onClick={()=>void refresh()}>重试</ActionButton></div>}
    {mode==='week'?<div className="cal-weekview">
      <div className="cal-week-head"><span className="cal-axis-head mono">时间</span>{days.map(day=><button key={day} className={`cal-wd-col ${day===today?'today-col':''} ${day===selected?'sel-col':''}`} onClick={()=>select(day)} aria-label={day}><span className="cal-wd-text">周{WEEK[dayOfWeek(day)]}</span><span className={`cal-num ${day===today?'today-num':''}`}>{Number(day.slice(8))}</span><span className="cal-day-meta mono">{result?.countsByDay[day]??0} 项</span></button>)}</div>
      <div className="cal-allday"><span className="cal-axis-head mono">全天</span><div className="cal-allday-lane" style={{height:Math.max(1,allDay.length)*26}}>{allDay.map((row,ri)=>row.map(({item,start,span})=><button key={item.id} data-calendar-kind={item.kind} data-item-id={item.id} className={`cal-allday-chip ${colorOf(item)}`} style={{left:`calc(${start/7*100}% + 2px)`,width:`calc(${span/7*100}% - 4px)`,top:ri*26+2,height:22}} onClick={e=>{select(days[start]);openItem(item,e.currentTarget);}} title={item.title}><i className={`cal-dot ${colorOf(item)}`}/><span className="cal-ev-text">{item.title}</span></button>))}</div></div>
      <div className="cal-weekgrid"><div className="cal-scroll" ref={scroll}><div className="cal-scroll-inner" style={{height:24*HOUR_H}}><div className="cal-axis">{Array.from({length:24},(_,h)=><div key={h} className="cal-axis-tick" style={{top:h*HOUR_H}}>{h%2===0&&<span className="mono">{pad(h)}:00</span>}</div>)}</div>
        <div className="cal-daycols">{days.map(day=><div key={day} className={`cal-col ${day===today?'today-col-bg':''}`} role="gridcell" aria-label={`${day}时间网格`} tabIndex={0} onPointerDown={e=>beginDraft(day,e)} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerCancel} onLostPointerCapture={pointerEnd} onKeyDown={e=>{if(e.target===e.currentTarget&&(e.key==='Enter'||e.key===' ')){e.preventDefault();openCreate(e.currentTarget,day,'09:00','09:15');}}}>{placeTimed(slices.filter(s=>s.day===day&&!s.allDay)).map(s=><button key={`${s.item.id}/${day}`} data-calendar-kind={s.item.kind} data-item-id={s.item.id} className={`cal-evt-block ${colorOf(s.item)}`} style={{top:s.startMinute/60*HOUR_H,height:Math.max(20,(s.visualEnd-s.startMinute)/60*HOUR_H),left:`calc(${s.col/s.cols*100}% + 1px)`,width:`calc(${100/s.cols}% - 2px)`}} onClick={e=>{e.stopPropagation();select(day);openItem(s.item,e.currentTarget);}} title={`${s.label} ${s.item.title}`}><span className="cal-evt-block-time mono">{s.label}</span><span className="cal-evt-block-title">{s.item.title}</span></button>)}{draft?.day===day&&<div ref={draftElement} className={`cal-draft ${dragging?'dragging':''}`} style={{top:draft.start/60*HOUR_H,height:(draft.end-draft.start)/60*HOUR_H}} onClick={e=>e.stopPropagation()}>
            <span className="cal-draft-label">{form?.title||'添加日程'}{draft.end-draft.start>=30&&<span className="mono">{clockLabel(draft.start)} – {clockLabel(draft.end)}</span>}</span>
            <div className="cal-draft-resize" role="slider" tabIndex={0} aria-label="拖动调整结束时间" aria-valuemin={draft.start+15} aria-valuemax={1440} aria-valuenow={draft.end} aria-valuetext={clockLabel(draft.end)} onPointerDown={e=>beginDraft(day,e,true)} onKeyDown={e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();const value={...draft,end:draftEnd(draft.start,draft.end+(e.key==='ArrowDown'?15:-15))};updateDraft(value);setForm(current=>current?{...current,...draftTimes(value)}:current);}else if(e.key==='Enter'){e.preventDefault();finishDraft();}}}><span/></div>
          </div>}</div>)}
          {currentClock&&days.includes(currentClock.day)&&<div className="cal-nowline" style={{top:currentClock.minute/60*HOUR_H}} aria-hidden><span className="cal-nowtime mono">{currentClock.label}</span></div>}
        </div></div></div></div>
    </div>:<><div className="cal-week" aria-hidden>{WEEK.map(w=><span key={w} className="cal-wd mono">周{w}</span>)}</div><div className="cal-grid" role="grid" aria-label="月视图">{days.map(day=>{const entries=slices.filter(s=>s.day===day);return <div key={day} role="gridcell" tabIndex={0} className={`cal-cell cal-month-cell ${day.slice(0,7)!==anchor.slice(0,7)?'out':''} ${day===today?'today':''} ${day===selected?'sel':''}`} aria-label={day} aria-selected={day===selected} onClick={()=>select(day)} onKeyDown={e=>{if(e.target===e.currentTarget&&(e.key==='Enter'||e.key===' ')){e.preventDefault();select(day);}}}><span className="cal-num">{Number(day.slice(8))}</span>{entries.slice(0,2).map(s=><button key={s.item.id} className="cal-ev cal-month-item" onClick={e=>{e.stopPropagation();select(day);openItem(s.item,e.currentTarget);}} data-calendar-kind={s.item.kind}><i className={`cal-dot ${colorOf(s.item)}`}/><span className="cal-ev-text">{!s.allDay?`${clockLabel(s.startMinute)} `:''}{s.item.title}</span></button>)}{entries.length>2&&<span className="cal-more mono">+{entries.length-2}</span>}<span className="cal-day-meta mono">{result?.countsByDay[day]??0} 项</span></div>;})}</div></>}
    <CalendarAgenda today={today} selected={selected} mode={agendaMode} zone={zone} revision={result?.revision} onModeChange={value=>{closePopover();if(value==='day'){setAnchor(today);setSelected(today);}setAgendaMode(value);}} onOpen={openItem}/>
    {popoverAnchor&&(form||detail)&&<CalendarPopover anchor={popoverAnchor} title={form?(form.id===null?'新建日程':'编辑日程'):'事项详情'} busy={saving||detailBusy} onClose={closePopover}>
      {form&&<div className="cal-form" aria-label={form.id===null?'新建日程':'编辑日程'}><div className="cal-form-row"><input className="inline-input cal-title-input" aria-label="日程标题" placeholder="添加主题" data-autofocus value={form.title} onChange={e=>setForm({...form,title:e.target.value})} onKeyDown={e=>{if(e.key==='Enter'&&!e.nativeEvent.isComposing)void save();}} autoFocus/></div>
        <div className="cal-form-row"><label className="cal-field">日期<input className="chip-date" type="date" aria-label="开始日期" value={form.date} onChange={e=>setForm({...form,date:e.target.value})}/></label><label className="cal-field">结束<input className="chip-date" type="date" aria-label="结束日期" value={form.endDate} onChange={e=>setForm({...form,endDate:e.target.value})}/></label><label className="cal-check"><input type="checkbox" checked={form.allDay} onChange={e=>setForm({...form,allDay:e.target.checked})}/>全天</label><label className="cal-field">开始<input className="cal-time" type="time" aria-label="开始时间" disabled={form.allDay} value={form.start} onChange={e=>setForm({...form,start:e.target.value})}/></label><label className="cal-field">结束<input className="cal-time" type="time" aria-label="结束时间" disabled={form.allDay} value={form.end} onChange={e=>setForm({...form,end:e.target.value})}/></label></div>
        <div className="cal-form-row"><span className="cal-colors" role="radiogroup" aria-label="颜色">{COLORS.map(c=><button key={c} className={`cal-color-btn ${form.color===c?'on':''}`} role="radio" aria-label={c} aria-checked={form.color===c} onClick={()=>setForm({...form,color:c})}><i className={`cal-dot ${c}`}/></button>)}</span><input className="inline-input cal-note-input" aria-label="日程备注" placeholder="备注（可选）" value={form.note} onChange={e=>setForm({...form,note:e.target.value})}/></div>
        {formError&&<div className="notice error">{formError}</div>}<div className="cal-form-row"><ActionButton icon={form.id === null ? IconPlus : IconSave} className="btn primary slim" disabled={saving} onClick={()=>void save()}>{saving?'保存中…':form.id===null?'创建日程':'保存修改'}</ActionButton><ActionButton icon={IconX} className="btn slim" disabled={saving} onClick={closePopover}>取消</ActionButton>{form.id!==null&&<ActionButton icon={IconTrash} className="btn slim danger-btn" disabled={saving} onClick={()=>void remove()}>删除</ActionButton>}</div>
      </div>}
      {detail&&(detail.target.objectType==='calendar_event'?<div className="cal-event-preview">
        <h4><i className={`cal-dot ${colorOf(detail)}`}/>{detail.title}</h4>
        <p className="mono">{detailTime||slices.filter(s=>s.item.id===detail.id).map(s=>`${s.day} ${s.label}`).join(' · ')}</p>
        <CalendarEventNote key={detail.id} item={detail}/>
        {formError&&<div className="notice error">{formError}</div>}
        <div className="cal-form-row"><span className="cal-badge">日程</span><span className="spacer"/><ActionButton icon={IconPencil} className="btn primary slim" disabled={saving} onClick={()=>void editEvent()}>编辑日程</ActionButton></div>
      </div>:<CalendarItemDetails key={detail.id} item={detail} preview previewTime={detailTime||slices.filter(s=>s.item.id===detail.id).map(s=>`${s.day} ${s.label}`).join(' · ')+` (${zone})`} onBusyChange={setDetailBusy} onClose={dismissPopover} onChanged={refresh}/>)}
    </CalendarPopover>}
    <div className="cal-legend mono">所有视图使用相同分类和统计；跨午夜按天展示，结束待定只使用视觉高度。{loading?'正在刷新…':''}</div>
  </section>;
}

function CalendarEventNote({item}:{item:CalendarItem}) {
  const [note,setNote]=useState('');
  useEffect(()=>{let active=true;void call<{row:Record<string,unknown>}>(()=>api.data.getObject({apiName:'calendar_event',id:item.target.id})).then(({row})=>{if(active)setNote(String(row.note??''));}).catch(()=>{if(active)setNote('备注读取失败，请重新打开');});return()=>{active=false;};},[item.id]);
  return note?<p className="cal-preview-note">{note}</p>:null;
}
