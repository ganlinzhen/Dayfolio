// 日历分类管理与工具待办共用分类身份；菜单脱离滚动容器，避免被裁切。
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CalendarCollection } from '../../../../../../packages/core/src';
import { api, call } from '../api';
import Modal from './Modal';

const COLORS = [['blue','蓝色'],['green','绿色'],['violet','紫色'],['amber','琥珀色'],['rose','玫瑰色'],['slate','灰色']] as const;
interface Edit { collection:CalendarCollection; title:string; color:string }

export default function CalendarCollections({ collections, timezone, onChanged, disabled=false }: {
  collections:CalendarCollection[]; timezone:string; onChanged:()=>Promise<void>; disabled?:boolean;
}) {
  const [menu,setMenu]=useState<{left:number;top:number}|null>(null),[open,setOpen]=useState(false);
  const [edit,setEdit]=useState<Edit|null>(null),[deleting,setDeleting]=useState<CalendarCollection|null>(null);
  const [zoneDraft,setZoneDraft]=useState(timezone),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const trigger=useRef<HTMLButtonElement>(null),menuRef=useRef<HTMLDivElement>(null),menuId=useId(),zoneId=useId();
  const closeMenu=()=>{setMenu(null);trigger.current?.focus();};
  useEffect(()=>{
    if(!menu)return;
    menuRef.current?.querySelector('button')?.focus();
    const outside=(event:PointerEvent)=>{if(!menuRef.current?.contains(event.target as Node)&&!trigger.current?.contains(event.target as Node))setMenu(null);};
    const close=()=>setMenu(null);
    document.addEventListener('pointerdown',outside,true);
    window.addEventListener('resize',close);
    window.addEventListener('scroll',close,true);
    return()=>{document.removeEventListener('pointerdown',outside,true);window.removeEventListener('resize',close);window.removeEventListener('scroll',close,true);};
  },[menu]);
  const showMenu=()=>{
    if(menu){closeMenu();return;}
    const rect=trigger.current!.getBoundingClientRect();
    setMenu({left:Math.max(8,Math.min(rect.right-176,window.innerWidth-184)),top:Math.min(rect.bottom+6,window.innerHeight-56)});
  };
  const manage=()=>{setMenu(null);trigger.current?.focus();setOpen(true);setZoneDraft(timezone);setError('');setEdit(null);setDeleting(null);};
  const run=async(action:()=>Promise<unknown>,done?:()=>void)=>{
    if(busy)return;
    setBusy(true);setError('');
    try{await action();done?.();await onChanged();}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };
  const save=()=>{
    if(!edit)return;
    void run(()=>call(()=>api.calendar.updateCollection({collectionId:edit.collection.id,expectedTitle:edit.collection.title,expectedColor:edit.collection.color,title:edit.title,color:edit.color})),()=>setEdit(null));
  };
  const remove=()=>{
    if(!deleting)return;
    void run(()=>call(()=>api.calendar.deleteCollection({collectionId:deleting.id,expectedTitle:deleting.title})),()=>setDeleting(null));
  };
  const titleOf=(id:string,fallback:string)=>collections.find(c=>c.id===id)?.title??fallback;
  return <>
    <button ref={trigger} type="button" className="btn slim cal-more-button" aria-label="日历更多操作" aria-haspopup="menu" aria-expanded={!!menu} aria-controls={menu?menuId:undefined} disabled={disabled} onClick={showMenu} onKeyDown={event=>{if(event.key==='ArrowDown'){event.preventDefault();showMenu();}}}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>
    </button>
    {menu&&createPortal(<div ref={menuRef} id={menuId} className="cal-actions-menu" role="menu" aria-label="日历更多操作" style={menu} onKeyDown={event=>{
      if(event.key==='Escape'){event.preventDefault();closeMenu();}
      else if(event.key==='Tab'){closeMenu();}
      else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();menuRef.current?.querySelector('button')?.focus();}
    }}><button type="button" role="menuitem" onClick={manage}>管理分类</button></div>,document.body)}
    {open&&<Modal title="管理分类" description="选择要在日历中显示的分类，或编辑分类名称和颜色。显示设置会立即保存。" className="cal-collections-modal" busy={busy} onClose={()=>setOpen(false)} footer={<button type="button" className="btn" disabled={busy} onClick={()=>setOpen(false)}>完成</button>}>
      {error&&<div className="notice error" role="alert">{error}</div>}
      <div className="cal-managed-collections" aria-label="日历分类">
        {collections.map(collection=><div key={collection.id} className="cal-managed-collection" data-collection-id={collection.id}>
          <div className="cal-managed-summary">
            <label className="cal-check"><input type="checkbox" aria-label={`显示${collection.title}`} checked={collection.visible} disabled={busy} onChange={event=>void run(()=>call(()=>api.calendar.setVisibility({collectionId:collection.id,visible:event.target.checked})))}/><i className={`cal-dot ${COLORS.some(([c])=>c===collection.color)?collection.color:'blue'}`}/><span className="cal-managed-title">{collection.title}</span></label>
            <div className="cal-managed-actions"><button type="button" className="btn ghost slim" aria-label={`编辑${collection.title}`} disabled={busy} onClick={()=>{setEdit({collection,title:collection.title,color:collection.color});setDeleting(null);setError('');}}>编辑</button><button type="button" className="btn ghost slim danger-btn" aria-label={`删除${collection.title}`} disabled={busy||!!collection.deleteBlockedReason} title={collection.deleteBlockedReason??'删除分类，保留其中的内容'} onClick={()=>{setDeleting(collection);setEdit(null);setError('');}}>删除</button></div>
          </div>
          {(collection.deleteBlockedReason||collection.archived||collection.extensionStatus==='disabled'||collection.extensionStatus==='uninstalled')&&<p className="cal-managed-hint">{collection.archived?'已归档 · ':collection.extensionStatus==='disabled'?'来源停用 · ':collection.extensionStatus==='uninstalled'?'来源已卸载 · ':''}{collection.deleteBlockedReason}</p>}
          {edit?.collection.id===collection.id&&<form className="cal-collection-editor" aria-label={`编辑分类${collection.title}`} onSubmit={event=>{event.preventDefault();save();}}>
            <label className="cal-field">分类名称<input className="inline-input" aria-label="分类名称" maxLength={80} value={edit.title} disabled={busy} onChange={event=>setEdit({...edit,title:event.target.value})} autoFocus/></label>
            <div className="cal-form-row"><span className="cal-colors" role="group" aria-label="分类颜色">{COLORS.map(([color,label])=><button key={color} type="button" className={`cal-color-btn ${edit.color===color?'on':''}`} aria-label={label} aria-pressed={edit.color===color} disabled={busy} onClick={()=>setEdit({...edit,color})}><i className={`cal-dot ${color}`}/></button>)}</span><span className="spacer"/><button type="button" className="btn slim" disabled={busy} onClick={()=>setEdit(null)}>取消编辑</button><button type="submit" className="btn primary slim" disabled={busy||!edit.title.trim()}>{busy?'保存中…':'保存分类'}</button></div>
          </form>}
          {deleting?.id===collection.id&&<div className="cal-collection-confirm" role="group" aria-label={`确认删除分类${collection.title}`}>
            <p>删除「{collection.title}」？待办移至「{titleOf('builtin.todo','基础待办')}」，日程移至「{titleOf('builtin.local','本地日程')}」，保留内容、日期和完成状态。</p>
            <p className="cal-managed-hint">再次从 HTML 工具确认添加新事项时，该分类可重新创建。</p>
            <div className="cal-form-row"><button type="button" className="btn slim" disabled={busy} onClick={()=>setDeleting(null)}>取消删除</button><button type="button" className="btn slim danger-btn" disabled={busy} onClick={remove}>{busy?'删除中…':'确认删除分类'}</button></div>
          </div>}
        </div>)}
      </div>
      <div className="cal-managed-timezone"><label className="cal-field">显示时区<input className="inline-input" aria-label="日历显示时区" list={zoneId} value={zoneDraft} disabled={busy} onChange={event=>setZoneDraft(event.target.value)}/></label><datalist id={zoneId}>{['Asia/Shanghai','Europe/London','UTC','America/New_York'].map(z=><option key={z} value={z}/>)}</datalist><button type="button" className="btn slim" disabled={busy||!zoneDraft||zoneDraft===timezone} onClick={()=>void run(()=>call(()=>api.runtime.setTimezone({zone:zoneDraft})))}>应用时区</button></div>
    </Modal>}
  </>;
}
