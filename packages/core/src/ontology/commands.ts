// 公共写入口：命令目录与业务服务 facade 共用启停、入口和对象引用校验。
import { COMMAND_INPUTS } from './command-inputs';
import { validateCommandInput } from './input-validation';
import { ensureValidDateStr } from '../utils/date';
import type { ExtensionService } from '../services/extensions';
import type { CourseService } from '../services/course';
import type { MediaService } from '../services/media';
import type { DbAdapter } from '../db';
import { inTx } from '../db';
import { OntologyError } from './policy';
import type { ActionParamDef, ActionTypeDef } from './types';
import type { OntologyService } from './registry';

type Param = [string, ActionParamDef['dataType'], boolean?, string?];
interface CommandDef {
  apiName: string; title: string; service: string; method: string;
  parameters: ActionParamDef[]; targetBindings: Array<{ objectType: string; parameter?: string }>;
  form: 'flat' | 'args'; human?: boolean; atomic?: boolean;
}
const defs: CommandDef[] = [];
function command(name: string, title: string, service: string, method: string, targets: string[], params: Param[], form: CommandDef['form'] = 'args', human = false, atomic = false) {
  defs.push({ apiName: name, title, service, method, form, human, atomic,
    parameters: params.map(([n,t,required=true,objectType]) => ({ name:n, dataType:t, required, objectType })),
    targetBindings: targets.map(objectType => ({ objectType, parameter: params.find(p => p[3] === objectType)?.[0] })) });
}
const input: Param = ['input','json']; const id = (t: string): Param => ['id','integer',true,t]; const patch: Param = ['patch','json'];
command('add_todo','新增待办','todos','add',['todo'],[['title','string'],['notes','string',false],['priority','string',false],['due_date','date',false],['start_time','string',false],['end_time','string',false],['end_date','date',false],['time_mode','string',false],['scheduled_start_at','string',false],['scheduled_end_at','string',false],['collection_id','string',false],['tags','json',false],['source','string',false]],'flat');
command('update_todo','更新待办','todos','update',['todo'],[id('todo'),patch], 'args', false, true);
command('complete_todo','完成待办','todos','complete',['todo'],[id('todo')],'args',false,true);
command('reopen_todo','撤销完成','todos','reopen',['todo'],[id('todo')],'args',false,true);
command('delete_todo','删除待办','todos','remove',['todo'],[id('todo')]);
command('create_study_plan','创建学习计划','plans','create',['study_plan'],[input]);
command('update_study_plan','更新学习计划','plans','update',['study_plan'],[id('study_plan'),patch]);
command('update_plan_item','更新计划条目','plans','updateItemStatus',['plan_item'],[id('plan_item'),['status','string']],'args',false,true);
command('delete_study_plan','删除学习计划','plans','remove',['study_plan'],[id('study_plan'),['delete_todos','boolean',false]]);
command('checkin','打卡','checkins','checkin',['checkin','todo','plan_item','day'],[['ref_type','string'],['ref_id','integer',false],['date','date',false],['note','string',false]],'flat');
command('remove_checkin','解除打卡','checkins','remove',['checkin'],[['ref_type','string'],['ref_id','integer',false],['date','date']]);
command('create_review_schedule','安排间隔复习','reviews','schedule',['study_plan'],[input]);
for (const [name,title,method,params] of [
  ['draft_study_plan','创建排期草案','draft',[input]],['draft_study_topic','创建专题草案','draftDateless',[input]],
  ['update_study_topic_draft','更新专题草案','updateDraftMeta',[id('study_plan_draft'),patch]],
  ['schedule_study_draft','草案排期','scheduleDraft',[id('study_plan_draft'),['start_date','date'],['daily_minutes','integer'],['options','json',false]]],
  ['confirm_study_plan_draft','确认学习草案','confirmDraft',[id('study_plan_draft'),['options','json',false]]],
  ['cancel_study_plan_draft','取消草案','cancelDraft',[id('study_plan_draft')]],
  ['record_study_session','记录学习会话','recordSession',[input]],['record_study_assessment','记录测评','recordAssessment',[input]],
  ['apply_plan_adjustments','应用计划调整','applyAdjustments',[id('study_plan'),['selection','json']]],
  ['export_study_cards','导出学习卡片','exportCards',[['selector','json'],['export_dir','string']]],
] as Array<[string,string,string,Param[]]>) {
  const targets = name.includes('session') ? ['study_session'] : name.includes('assessment') ? ['study_assessment'] : name.includes('cards') ? ['card_export'] : name.includes('adjustments') ? ['study_plan','plan_adjustment'] : ['study_plan_draft'];
  command(name,title,'study',method,targets,params);
}
for (const [name,title,method,params] of [
  ['create_news_task','创建新闻任务','createTask',[input,['created_by','string',false]]],
  ['claim_news_task','认领新闻任务','claimTask',[['task_id','integer',false,'news_task'],['claimed_by','string',false]]],
  ['submit_news_items','提交新闻','submitItems',[['task_id','integer',true,'news_task'],['claim_token','string'],['items','json']]],
  ['complete_news_task','完成新闻任务','completeTask',[['task_id','integer',true,'news_task'],['claim_token','string'],['note','string',false]]],
  ['release_news_task','释放新闻任务','releaseTask',[['task_id','integer',true,'news_task'],['claim_token','string'],['reason','string',false]]],
  ['cancel_news_task','取消新闻任务','cancelTask',[id('news_task')]],
  ['mark_news_read','标记新闻已读','markRead',[id('news_item'),['read','boolean',false]]],
  ['mark_news_starred','收藏新闻','markStarred',[id('news_item'),['starred','boolean',false]]],
  ['mark_all_news_read','批量标记已读','markAllRead',[['filter','json',false]]],
  ['delete_news_item','删除新闻','deleteItem',[id('news_item')]],
] as Array<[string,string,string,Param[]]>) command(name,title,'news',method,name.includes('task')||name==='submit_news_items'?['news_task','news_item']:['news_item'],params);
command('import_course','导入课程','courses','importCourse',['course','course_lesson','course_overview'],[['staging_dir','string']]);
command('mark_lesson_read','标记讲义已读','courses','markLessonRead',['course','course_lesson'],[['course_id','integer',true,'course'],['day','integer']]);
command('submit_lesson_quiz','提交讲义自测','courses','submitQuiz',['course','course_lesson'],[['course_id','integer',true,'course'],['day','integer'],['answers','json']]);
command('confirm_course_sample','确认样课','courses','confirmSample',['course'],[id('course')],'args',true);
command('create_course_request','请求生成课程','courses','createGenerationRequest',['course','course_request'],[['course_id','integer',true,'course'],['requested_by','string',false]]);
command('claim_course_request','认领课程生成','courses','claimRequest',['course_request'],[id('course_request'),['claimed_by','string']]);
command('complete_course_request','完成课程生成','courses','completeRequest',['course_request'],[id('course_request'),['claimed_by','string']]);
for (const [name,title,method,params,targets] of [
  ['add_tool','新增工具','addTool',[input],['tool']],['update_tool','更新工具','updateTool',[id('tool'),patch],['tool']],['delete_tool','删除工具','deleteTool',[id('tool')],['tool']],
  ['add_tool_category','新增工具分类','addCategory',[input],['tool_category']],['rename_tool_category','重命名工具分类','renameCategory',[id('tool_category'),['name','string']],['tool_category']],
  ['delete_tool_category','删除工具分类','deleteCategory',[id('tool_category')],['tool_category']],['reorder_tool_categories','排列工具分类','reorderCategories',[['ids','json']],['tool_category']],
] as Array<[string,string,string,Param[],string[]]>) command(name,title,'tools',method,targets,params);
for (const [name,title,method,params,targets] of [
  ['register_vault','注册知识库','register',[input],['vault']],['update_vault','更新知识库配置','update',[id('vault'),patch],['vault']],['remove_vault','移除知识库注册','remove',[id('vault')],['vault']],
  ['scan_vault','扫描知识库','scan',[id('vault')],['vault','vault_note']],['link_concept_note','关联知识笔记','linkConcept',[input],['vault_note','vault_concept_link']],['unlink_concept_note','解除知识笔记关联','unlinkConcept',[id('vault_concept_link')],['vault_concept_link']],
] as Array<[string,string,string,Param[],string[]]>) command(name,title,'vaults',method,targets,params);
for (const [noun,title,methods] of [
  ['topic','选题',['addTopic','updateTopic','deleteTopic']],['content','母稿',['addContent','updateContent','deleteContent']],['material','素材',['addMaterial','updateMaterial','deleteMaterial']],
] as Array<[string,string,string[]]>) {
  command(`add_media_${noun}`,`新增${title}`,'media',methods[0],[`media_${noun}`],[input]);
  command(`update_media_${noun}`,`更新${title}`,'media',methods[1],[`media_${noun}`],[id(`media_${noun}`),patch]);
  command(`delete_media_${noun}`,`删除${title}`,'media',methods[2],[`media_${noun}`],[id(`media_${noun}`)]);
}
command('add_media_version','新增平台版本','media','addVersion',['media_content','media_content_version'],[['content_id','integer',true,'media_content'],input]);
command('update_media_version','编辑平台版本','media','updateVersion',['media_content_version'],[id('media_content_version'),patch]);
command('review_media_version','审核平台版本','media','reviewVersion',['media_content_version'],[id('media_content_version'),['action','string'],['note','string',false]],'args',true);
command('submit_media_version','提交平台版本审核','media','reviewVersion',['media_content_version'],[id('media_content_version'),['note','string',false]]);
command('attach_media_material','关联创作素材','media','attachMaterial',['media_content','media_material'],[['content_id','integer',true,'media_content'],['material_id','integer',true,'media_material']]);
command('detach_media_material','解除创作素材','media','detachMaterial',['media_content','media_material'],[['content_id','integer',true,'media_content'],['material_id','integer',true,'media_material']]);
command('schedule_media_post','安排发布','media','schedule',['media_calendar_entry','media_content_version'],[input]);
command('mark_media_published','回填发布结果','media','markPublished',['media_calendar_entry'],[id('media_calendar_entry'),['input','json',false]]);
command('cancel_media_schedule','取消发布排期','media','cancelSchedule',['media_calendar_entry'],[id('media_calendar_entry')]);
command('add_media_metric','录入发布指标','media','addMetric',['media_metric'],[input]);
command('export_media_package','导出素材包','media','exportPackage',['media_content'],[['content_id','integer',true,'media_content'],['export_dir','string']]);
for (const [name,title,method,params] of [
  ['add_calendar_event','新增日程','add',[input]],
  ['update_calendar_event','更新日程','update',[id('calendar_event'),patch]],
  ['delete_calendar_event','删除日程','remove',[id('calendar_event')]],
] as Array<[string,string,string,Param[]]>) command(name,title,'calendar',method,['calendar_event'],params);
for(const d of defs)for(const p of d.parameters){if(d.apiName==='delete_study_plan'&&p.name==='delete_todos')p.defaultValue=true;if(d.apiName==='checkin'&&p.name==='ref_id')p.defaultValue=0;}
command('set_display_timezone','设置显示时区','runtime','setDisplayTimezone',[],[['zone','string']],'args',false,true);
command('set_calendar_collection_visibility','设置日历分类显示','runtime','setVisibility',[],[input],'args',false,true);
for(const [name,title,service,method,targets]of [
  ['import_external_events','导入标准事件','externalEvents','import',['external_event','event_provider']],
  ['archive_external_event','归档外部事件','externalEvents','archive',['external_event']],
  ['delete_unused_external_event','删除未使用事件','externalEvents','deleteUnused',['external_event']],
  ['update_event_provider','更新数据源','externalEvents','updateProvider',['event_provider']],
  ['subscribe_event','订阅事件','subscriptions','subscribe',['external_event','event_subscription','todo']],
  ['unsubscribe_event','取消事件订阅','subscriptions','unsubscribe',['event_subscription','todo']],
  ['resume_event_following','恢复事件跟随','subscriptions','resumeFollowing',['event_subscription','todo']],
] as Array<[string,string,string,string,string[]]>)command(name,title,service,method,targets,[input],'args',false,true);
command('install_extension','安装运行时工具','extensions','install',['tool_extension'],[input]);
command('authorize_extension_install','授权运行时工具安装','extensions','authorizeInstall',['tool_extension'],[input],'args',true);
command('set_extension_enabled','启停运行时工具','extensions','setEnabled',['tool_extension'],[input]);
command('uninstall_extension','卸载运行时工具并保留数据','extensions','uninstall',['tool_extension'],[input]);
command('rollback_extension','回滚运行时工具版本','extensions','rollback',['tool_extension'],[input]);
command('refresh_event_provider','请求刷新事件来源','externalEvents','refresh',['event_provider'],[input],'args',false,true);
export const COMMAND_DEFS = defs;
/** 已核对为短数据库操作的组合白名单，文件/联网/人工审核命令不在其中。 */
export const COMPOSABLE_COMMANDS = new Set(['add_todo', 'update_todo', 'complete_todo', 'reopen_todo', 'update_plan_item']);
const paramSchema=(d:CommandDef,index:number):unknown=>{const schemas=COMMAND_INPUTS[d.apiName]??[];if(d.apiName==='submit_media_version'&&index===1)return schemas[2]??{};if(d.apiName==='delete_study_plan'&&index===1)return {type:'boolean'};if(d.form==='flat')return (schemas[0] as {properties?:Record<string,unknown>})?.properties?.[d.parameters[index].name]??{};return schemas[index]??{};};
export const commandMetadata = (d: CommandDef): Omit<ActionTypeDef,'createdAt'|'updatedAt'> => ({
  apiName:d.apiName,title:d.title,description:`${d.title}：调用既有业务服务并遵守统一写入规则。${d.human?'人工审核请到对应业务面板操作。':''}`,
  isBuiltin:true,status:'active',parameters:d.parameters.map((p,i)=>({...p,jsonSchema:paramSchema(d,i),description:p.dataType==='json'?'结构化 JSON，具体字段见 jsonSchema':p.description})),operations:[],sortOrder:200,
  targetBindings:d.targetBindings,allowedChannels:d.human?['app-human']:['app','mcp','core'],
  composable: COMPOSABLE_COMMANDS.has(d.apiName),
});

export function createCommandService(db: DbAdapter, ontology: OntologyService, services: Record<string, object>) {
  const guard = (name: string) => {
    if (ontology.getActionType(name).status === 'disabled') throw new OntologyError('ACTION_DISABLED', `动作 ${name} 已停用`);
  };
  const invoke = (d: CommandDef, args: unknown[], human = false, inside = false): unknown => {
    if (d.atomic && !inside) return inTx(db,()=>invoke(d,args,human,true));
    if(d.apiName==='review_media_version'&&args[1]==='submit')return invoke(defs.find(x=>x.apiName==='submit_media_version')!,args,false,inside);
    guard(d.apiName);
    for(let i=0;i<args.length;i++)validateCommandInput(COMMAND_INPUTS[d.apiName]?.[i],args[i],`${d.apiName} 参数 ${i+1}`);
    for(const [i,p] of d.parameters.entries())if(p.objectType){
      const value=d.form==='flat'?(args[0] as Record<string,unknown>)?.[p.name]:args[i];
      if(value===undefined||value===null)continue;
      const type=ontology.getObjectType(p.objectType);
      if(!db.prepare(`SELECT 1 FROM "${type.tableName}" WHERE "${type.primaryKey}"=?`).get(value)&&!['delete_tool','delete_news_item'].includes(d.apiName))throw new OntologyError('REFERENCE_NOT_FOUND',`${p.objectType}#${value} 不存在`);
    }

    if (d.human && !human) {
      throw new OntologyError('ACTION_CHANNEL_DENIED','请到课程或创作面板完成人工确认');
    }
    if (d.apiName === 'update_todo') {
      const state = (args[1] as {status?: string})?.status;
      if (state) guard(state === 'done' ? 'complete_todo' : 'reopen_todo');
    }
    if (d.apiName === 'update_plan_item') {
      const item = db.prepare('SELECT status,todo_id FROM plan_items WHERE id=?').get(args[0]);
      if (item?.todo_id && args[1] !== item.status) guard(args[1] === 'done' ? 'complete_todo' : 'reopen_todo');
    }
    if (d.apiName === 'delete_study_plan' && (args[1] as {delete_todos?: boolean} | undefined)?.delete_todos !== false) {
      const hit = db.prepare("SELECT t.id FROM todos t JOIN plan_items p ON p.todo_id=t.id WHERE p.plan_id=? AND t.source='plan' AND NOT EXISTS (SELECT 1 FROM plan_items q WHERE q.todo_id=t.id AND q.plan_id<>?) LIMIT 1").get(args[0],args[0]);
      if (hit) guard('delete_todo');
    }
    const service = services[d.service] as Record<string, unknown>;
    const handler = service[d.method];
    if (typeof handler !== 'function') throw new Error(`命令 ${d.apiName} 未绑定服务方法 ${d.method}`);
    const run = () => Reflect.apply(handler,service,args);
    return run();
  };
  const execute = (name: string, params: Record<string,unknown>) => {
    const d = defs.find(d=>d.apiName===name);
    if (!d) throw new Error(`命令 ${name} 不存在`);
    for (const key of Object.keys(params)) if (!d.parameters.some(p=>p.name===key)) throw new Error(`未知参数 ${key}`);
    for (const [index,p] of d.parameters.entries()) {
      const v=params[p.name];
      validateCommandInput(paramSchema(d,index),v,p.name);
      if (p.required && (v===undefined || v===null || v==='')) throw new Error(`参数 ${p.name} 必填`);
      if (v===undefined || v===null) continue;
      if ((p.dataType==='string'||p.dataType==='date') && typeof v!=='string')throw new Error(`参数 ${p.name} 须为文本`);
      if(p.dataType==='date')ensureValidDateStr(String(v).slice(0,10));
      if (p.dataType==='integer' && (!Number.isSafeInteger(v))) throw new Error(`参数 ${p.name} 须为整数`);
      if (p.dataType==='boolean' && typeof v!=='boolean') throw new Error(`参数 ${p.name} 须为布尔值`);
      if (p.dataType==='json' && typeof v!=='object') throw new Error(`参数 ${p.name} 须为结构化 JSON`);
    }
    let args: unknown[] = d.form==='flat'?[name==='add_todo'?{...params,source:params.source??'mcp'}:params]:d.parameters.map(p=>params[p.name]);
    if(name==='submit_media_version')args=[params.id,'submit',params.note];
    if (name==='delete_study_plan') args=[params.id,{delete_todos:params.delete_todos!==false}];
    return invoke(d,args);
  };
  const wrap = <T extends object>(key: string, service: T): T => {
    const wrapped = { ...service };
    for (const d of defs.filter(d=>d.service===key&&d.apiName!=='submit_media_version')) {
      if (typeof Reflect.get(service,d.method) !== 'function') throw new Error(`命令 ${d.apiName} 的服务方法不存在：${d.method}`);
      Reflect.set(wrapped,d.method,(...args: unknown[])=>invoke(d,args));
    }
    return wrapped;
  };
  const human = {
    authorizeExtensionInstall:(input:Parameters<ExtensionService['authorizeInstall']>[0])=>invoke(defs.find(d=>d.apiName==='authorize_extension_install')!,[input],true) as ReturnType<ExtensionService['authorizeInstall']>,
    confirmCourseSample: (id:number) => invoke(defs.find(d=>d.apiName==='confirm_course_sample')!,[id],true) as ReturnType<CourseService['confirmSample']>,
    reviewMediaVersion: (id:number,action:string,note?:string) => invoke(defs.find(d=>d.apiName==='review_media_version')!,[id,action,note],true) as ReturnType<MediaService['reviewVersion']>,
  };
  return {execute,wrap,guard,human};
}
export type CommandService = ReturnType<typeof createCommandService>;
