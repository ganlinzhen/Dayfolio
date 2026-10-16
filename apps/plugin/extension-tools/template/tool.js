// 业务差异只来自工具包配置与标准事件；本文件无需宿主构建。
(async () => {
 'use strict';
 const sdk=window.Dayfolio, $=id=>document.getElementById(id);
 const config=await fetch('./page.json').then(response=>{if(!response.ok)throw new Error('页面配置缺失');return response.json();});
 const storageKey='dayfolio.page.'+config.pageId;
 let prefs={timezone:config.timezone||'Asia/Shanghai',date:'',team:'',subscribed:false};
 try{prefs={...prefs,...JSON.parse(localStorage.getItem(storageKey)||'{}')};}catch{}
 if(![...$('timezone').options].some(option=>option.value===prefs.timezone))prefs.timezone='Asia/Shanghai';
 $('title').textContent=config.title;document.title=config.title;$('scope').textContent=config.scope;
 for(const key of ['timezone','subscribed']){const node=$(key);if(node.type==='checkbox')node.checked=prefs[key];else node.value=prefs[key];}
 const save=()=>{try{localStorage.setItem(storageKey,JSON.stringify(prefs));}catch{}};
 const fail=error=>{$('error').hidden=false;$('error').textContent=error.message||String(error);};
 let providerId='',events=[],loading=false,queued=false,pending=new Set(),status=null;
 const label={scheduled:'待赛',postponed:'已延期',cancelled:'已取消',finished:'已结束'};
 const element=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
 const teamsOf=event=>[event.payload.home,event.payload.away].filter(team=>team&&typeof team==='object'&&team.id&&team.name);
 const day=event=>event.timeKind==='timed'?new Intl.DateTimeFormat('sv-SE',{timeZone:prefs.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(event.startAt)):event.startDate||'';
 const when=event=>event.timeKind==='tbd'?'时间待定':event.timeKind==='all_day'?event.startDate+' · 全天':new Intl.DateTimeFormat('zh-CN',{timeZone:prefs.timezone,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(event.startAt));
 const active=event=>event.subscription?.status==='active';
 const taskPrompt=()=>`为「${config.title}」核验并更新「${config.scope}」。现有来源修订 ${status?.revision??'请先读取'}，页面时区 ${prefs.timezone}。请先调用 list_event_providers 查找 ${providerId} 和有效请求。使用来源视图所列公开、可复用来源，核对届次、稳定 ID、真实时间精度和状态；不确定的时间标为 tbd。通过 import_external_events 提交完整标准事件快照，携带当前 provider 修订及本次唯一 batchId。缺失或空响应不删除旧活动，不改用户待办。提交后读回刷新任务、事件和订阅。无事实变化请报告无变化，不伪造自动同步。`;
 const showTeam=team=>{$('team-title').textContent=team.name;const root=$('team-matches');root.replaceChildren();for(const event of events.filter(event=>teamsOf(event).some(value=>value.id===team.id)))root.append(element('p',when(event)+' · '+event.title));$('team-dialog').showModal();};
 function render(){
  const allTeams=new Map();for(const event of events)for(const team of teamsOf(event))allTeams.set(String(team.id),team);
  const replaceOptions=(id,values,all)=>{const node=$(id);node.replaceChildren(new Option(all,''),...values.map(([key,value])=>new Option(value,key)));if(values.some(([key])=>key===String(prefs[id])))node.value=prefs[id];else{prefs[id]='';node.value='';}};
  replaceOptions('date',[...new Set(events.map(day).filter(Boolean))].sort().map(value=>[value,value]),'全部日期');
  replaceOptions('team',[...allTeams].sort((a,b)=>a[1].name.localeCompare(b[1].name)).map(([id,team])=>[id,team.name]),'全部参赛者');
  const shown=events.filter(event=>(!prefs.date||day(event)===prefs.date)&&(!prefs.team||teamsOf(event).some(team=>String(team.id)===prefs.team))&&(!prefs.subscribed||active(event))).sort((a,b)=>(a.startAt||a.startDate||'z').localeCompare(b.startAt||b.startDate||'z'));
  $('count').textContent=`显示 ${shown.length} / ${events.length} 场 · 已订阅 ${events.filter(active).length} 场 · ${prefs.timezone}`;
  const root=$('events');root.replaceChildren();
  if(!shown.length)root.append(element('p','当前筛选没有比赛。','muted'));
  const button=(title,action,id,primary=false)=>{const node=element('button',title,primary?'primary':'');node.disabled=pending.has(id);node.addEventListener('click',async()=>{pending.add(id);node.disabled=true;$('error').hidden=true;try{await action();await load();}catch(error){fail(error);}finally{pending.delete(id);render();}});return node;};
  for(const event of shown){
   const card=element('article',undefined,'event');card.dataset.externalId=event.externalId;
   const date=element('div',when(event),'event-date');date.append(element('div',label[event.status]||event.status,'event-meta'));
   const body=element('div');const teams=teamsOf(event);
   if(teams.length===2){const names=element('div',undefined,'event-name');for(const [index,team]of teams.entries()){if(index)names.append(document.createTextNode('  vs  '));const link=element('button',team.name,'team');link.addEventListener('click',()=>showTeam(team));names.append(link);}body.append(names);}else body.append(element('div',event.title,'event-name'));
   const flags=active(event)?event.subscription.syncMode==='manual'?'已订阅 · 手动安排':'已订阅 · 跟随来源':'尚未订阅';body.append(element('span',flags,'tag'));
   body.append(element('div',event.timeKind==='timed'&&!event.endAt?'结束时间未提供':event.timeKind==='all_day'?'全天区间结束日不包含在内':event.timeKind==='tbd'?'不会猜测开赛时间':'按来源时间显示','event-meta'));
   const controls=element('div',undefined,'event-controls');
   if(active(event)){
    controls.append(button('打开待办',()=>sdk.call('navigation.openTodo',{eventId:event.id}),event.id));
    controls.append(button('取消订阅',async()=>{const current=await sdk.call('subscriptions.get',{eventId:event.id});await sdk.call('subscriptions.unsubscribe',{eventId:event.id,todoPolicy:'keep',...(current.todo?{expectedTodoRevision:current.todo.revision}:{})});},event.id));
    if(event.subscription.syncMode==='manual')controls.append(button('恢复跟随',async()=>{const current=await sdk.call('subscriptions.get',{eventId:event.id});if(!current.todo)throw new Error('待办已删除，请重新读取');if(!confirm('恢复来源标题和排期？个人备注和完成状态保持。'))return;await sdk.call('subscriptions.resumeFollowing',{eventId:event.id,expectedEventRevision:event.revision,expectedTodoRevision:current.todo.revision});},event.id));
   }else controls.append(button('订阅比赛',()=>sdk.call('subscriptions.subscribe',{eventId:event.id}),event.id,true));
   card.append(date,body,controls);root.append(card);
  }
  $('teams').replaceChildren(...[...allTeams.values()].map(team=>{const node=element('button',team.name);node.addEventListener('click',()=>showTeam(team));return node;}));
  if(status){const text=status.activeRun?status.activeRun.mode==='external-agent'?'等待外部助手核验并导入；当前保留上次成功资料。':status.activeRun.status==='queued'?'已排队，等待拉取。':'正在拉取并校验。':status.lastError?'上次请求未完成：'+status.lastError.message:status.lastSuccessAt?'最近成功导入：'+new Date(status.lastSuccessAt).toLocaleString('zh-CN'):'尚未成功导入';$('status').textContent=text;}
  $('prompt').value=taskPrompt();save();
 }
 async function load(){if(loading){queued=true;return;}loading=true;try{
  for(let attempt=0;attempt<2;attempt++)try{let cursor,items=[];do{const page=await sdk.call('events.list',{providerId,limit:500,...(cursor?{cursor}:{})});items.push(...page.items);cursor=page.nextCursor;if(items.length>10000)throw new Error('条目过多，请缩小资料范围');}while(cursor);events=items;break;}catch(error){if(error.code!=='REVISION_CONFLICT'||attempt)throw error;}
  status=await sdk.call('providers.getStatus',{providerId});render();
 }catch(error){fail(error);}finally{loading=false;if(queued){queued=false;void load();}}}
 for(const id of ['date','team','timezone','subscribed'])$(id).addEventListener('change',()=>{const node=$(id);prefs[id]=node.type==='checkbox'?node.checked:node.value;save();render();});
 document.querySelectorAll('nav button').forEach(node=>node.addEventListener('click',()=>{for(const section of ['schedule','participants','sources'])$(section).hidden=section!==node.dataset.view;document.querySelectorAll('nav button').forEach(button=>button.setAttribute('aria-pressed',String(button===node)));}));
 $('close-team').addEventListener('click',()=>$('team-dialog').close());
 for(const source of config.sources){const box=element('div',undefined,'source');box.append(element('strong',source.title),element('p',source.coverage),element('p',source.note||'','muted'));const address=element('input');address.value=source.url;address.readOnly=true;address.setAttribute('aria-label',source.title+'来源地址');address.addEventListener('click',()=>address.select());box.append(address);if(source.lastSuccessAt)box.append(element('p','核验时间：'+source.lastSuccessAt,'muted'));$('source-details').append(box);}
 const license=element('p',config.attribution,'muted');$('source-details').append(license);
 $('request-refresh').addEventListener('click',async()=>{const node=$('request-refresh');node.disabled=true;try{await sdk.call('providers.refresh',{providerId});await load();}catch(error){fail(error);}finally{node.disabled=false;}});
 await sdk.ready;const description=await sdk.call('runtime.describe',{});providerId=`ext:${description.extensionId}/${config.providerLocalId}`;
 sdk.onChanged(()=>void load());await load();
})().catch(error=>{const node=document.getElementById('error');node.hidden=false;node.textContent=error.message||String(error);});
