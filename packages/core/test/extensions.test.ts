import {describe,it,expect} from 'vitest';
import {join,dirname} from 'node:path';
import {rmSync,writeFileSync} from 'node:fs';
import {mkCore} from './helpers';
import {writePackage} from './extension-fixtures';
import {eventFixture} from './runtime-fixtures';
import {sha256} from '../src/services/extension-package';
import {createExtensionService} from '../src/services/extensions';
import type {TodoDeskCore,ExtensionManifest} from '../src';

function prepare(core:TodoDeskCore,directory:string,approve=true){
 const preview=core.extensions.previewInstall({stagingDirectory:directory});
 const common={stagingDirectory:directory,expectedExtensionRevision:preview.currentRevision,expectedPackageDigest:preview.digest};
 const authorizationRef=preview.authorizationRef??(approve?core.commands.human.authorizeExtensionInstall(common).authorizationRef:'forged');
 return {...common,authorizationRef};
}
function seed(directory:string,manifest:ExtensionManifest,events:unknown[]){const text=JSON.stringify(events);writeFileSync(join(directory,'events.json'),text);manifest.files['events.json']=sha256(text);writeFileSync(join(directory,'manifest.json'),JSON.stringify(manifest));}

describe('正式运行时安装与生命周期',()=>{
 it('预览只读、不能经普通 core/通用动作自授权；首次安装与重装幂等',()=>{
  const {core,dbPath,cleanup}=mkCore();try{
   const incoming=join(dirname(dbPath),'incoming'),m=writePackage(incoming),before=core.runtime.getRevision(),preview=core.extensions.previewInstall({stagingDirectory:incoming});
   expect(core.runtime.getRevision()).toBe(before);expect(preview.authorizationRef).toBeNull();expect(core.extensions.list()).toEqual([]);
   const input=prepare(core,incoming,false);const {authorizationRef:ignored,...approvalInput}=input;expect(()=>core.extensions.authorizeInstall(approvalInput)).toThrow('ACTION_CHANNEL_DENIED');expect(()=>core.actions.execute('authorize_extension_install',{input:approvalInput})).toThrow('ACTION_CHANNEL_DENIED');expect(()=>core.extensions.install(input)).toThrow('PERMISSION_DENIED');
   const installed=core.extensions.install(prepare(core,incoming));expect(installed.effect).toBe('installed');expect(core.extensions.list()).toHaveLength(1);
   const record=core.extensions.get({extensionId:m.id})!;expect(record.origin).toMatch(/^dayfolio-tool:\/\/e-[a-f0-9]{32}$/);expect(core.externalEvents.list({providerId:`ext:${m.id}/main`}).items).toHaveLength(1);
   expect(core.extensions.getHelp({extensionId:m.id}).markdown).toContain('隐藏保留待办');expect(core.extensions.readAsset({extensionId:m.id,releaseDigest:record.digest,path:'tool.js'}).toString()).toBe('window.fixture=true;');
   const after=core.runtime.getRevision();expect(core.extensions.install(prepare(core,incoming)).effect).toBe('unchanged');expect(core.runtime.getRevision()).toBe(after);
  }finally{cleanup();}
 });
 it('修复缺文件不重放种子、不改变停用状态，保留可用旧版',()=>{
  const {core,dbPath,cleanup}=mkCore();try{
   const incoming=join(dirname(dbPath),'incoming'),m=writePackage(incoming);core.extensions.install(prepare(core,incoming));let record=core.extensions.get({extensionId:m.id})!;
   const event=core.externalEvents.list({providerId:`ext:${m.id}/main`}).items[0];core.externalEvents.deleteUnused({eventId:event.id});
   core.extensions.setEnabled({extensionId:m.id,expectedRevision:record.revision,enabled:false});record=core.extensions.get({extensionId:m.id})!;
   const root=join(dirname(dbPath),'extensions',new URL(record.origin).hostname,'releases',record.digest);rmSync(join(root,'tool.js'));
   const repaired=core.extensions.install(prepare(core,incoming));expect(repaired.effect).toBe('repaired');expect(core.extensions.get({extensionId:m.id})!.status).toBe('disabled');expect(core.extensions.get({extensionId:m.id})!.revision).toBe(record.revision);
   expect(core.externalEvents.list({providerId:`ext:${m.id}/main`}).items).toHaveLength(0);expect(()=>core.extensions.readAsset({extensionId:m.id,releaseDigest:record.digest,path:'tool.js'})).toThrow('SESSION_REVOKED');
   expect(core.extensions.getHelp({extensionId:m.id}).markdown).toContain('隔离工具');
  }finally{cleanup();}
 });
 it('升级种子只插新 ID，页面回滚不回滚来源、用户标题或完成记录',()=>{
  const {core,dbPath,cleanup}=mkCore();try{
   const incoming=join(dirname(dbPath),'first'),m=writePackage(incoming);core.extensions.install(prepare(core,incoming));const providerId=`ext:${m.id}/main`,old=core.externalEvents.list({providerId}).items[0];
   const sub=core.subscriptions.subscribe({eventId:old.id});core.todos.update(sub.todo!.id,{title:'用户自己的标题',notes:'个人备注'});const done=core.todos.complete(sub.todo!.id);
   core.externalEvents.import({providerId,batchId:'new-source',expectedProviderRevision:1,events:[{...eventFixture(),title:'来源最新时间',startAt:'2026-11-10T19:00:00Z'}]});
   const update=join(dirname(dbPath),'updated'),next=writePackage(update,{id:m.id,version:'1.1.0',title:'更新标题'});seed(update,next,[eventFixture(),eventFixture('new-event')]);
   const preview=core.extensions.previewInstall({stagingDirectory:update});expect(preview.authorizationRef).not.toBeNull();core.extensions.install(prepare(core,update));
   expect(core.externalEvents.get({eventId:old.id}).title).toBe('来源最新时间');expect(core.externalEvents.list({providerId}).items).toHaveLength(2);
   const current=core.extensions.get({extensionId:m.id})!;core.extensions.rollback({extensionId:m.id,expectedRevision:current.revision,version:'1.0.0'});
   expect(core.extensions.get({extensionId:m.id})!.version).toBe('1.0.0');expect(core.todos.get(done.id)).toMatchObject({title:'用户自己的标题',notes:'个人备注',status:'done',completed_at:done.completed_at});expect(core.externalEvents.list({providerId}).items).toHaveLength(2);
  }finally{cleanup();}
 });
 it('新增权限须绑定摘要授权，同版本冲突与旧安装修订拒绝',()=>{
  const {core,dbPath,cleanup}=mkCore();try{
   const original=join(dirname(dbPath),'first'),m=writePackage(original);core.extensions.install(prepare(core,original));const upgrade=join(dirname(dbPath),'upgrade');writePackage(upgrade,{version:'1.1.0',capabilities:[...m.capabilities,{name:'events.import',providerLocalId:'main'}]});
   const preview=core.extensions.previewInstall({stagingDirectory:upgrade});expect(preview.permissionDelta.map(p=>p.name)).toEqual(['events.import']);expect(preview.authorizationRef).toBeNull();expect(()=>core.extensions.install(prepare(core,upgrade,false))).toThrow('PERMISSION_DENIED');
   const approved=prepare(core,upgrade);const current=core.extensions.get({extensionId:m.id})!;core.extensions.setEnabled({extensionId:m.id,expectedRevision:current.revision,enabled:false});expect(()=>core.extensions.install(approved)).toThrow();
   core.extensions.install(prepare(core,upgrade));const conflict=join(dirname(dbPath),'conflict');writePackage(conflict,{version:'1.1.0',title:'相同版本另一内容'});expect(()=>core.extensions.previewInstall({stagingDirectory:conflict})).toThrow('VERSION_CONTENT_CONFLICT');
  }finally{cleanup();}
 });
 it('卸载保留事件、订阅、待办和分类，重新安装复用身份且不复活删除项',()=>{
  const {core,dbPath,cleanup}=mkCore();try{
   const incoming=join(dirname(dbPath),'incoming'),m=writePackage(incoming);core.extensions.install(prepare(core,incoming));const event=core.externalEvents.list({providerId:`ext:${m.id}/main`}).items[0],sub=core.subscriptions.subscribe({eventId:event.id});
   const before=core.extensions.get({extensionId:m.id})!;core.extensions.uninstall({extensionId:m.id,expectedRevision:before.revision});expect(core.todos.get(sub.todo!.id).id).toBe(sub.todo!.id);expect(core.runtime.listCollections().find(c=>c.ownerExtensionId===m.id)?.extensionStatus).toBe('uninstalled');expect(()=>core.forExtension(m.id).subscriptions.subscribe({eventId:event.id})).toThrow('PERMISSION_DENIED');
   core.extensions.install(prepare(core,incoming));const after=core.extensions.get({extensionId:m.id})!;expect(after.origin).toBe(before.origin);expect(after.status).toBe('active');expect(core.subscriptions.subscribe({eventId:event.id}).todo!.id).toBe(sub.todo!.id);expect(core.todos.list()).toHaveLength(1);
  }finally{cleanup();}
 });
 it('三个文件/事务故障点均保留旧版，未激活目录可安全重试',()=>{
  for(const phase of ['after_stage','after_publish','before_commit'] as const){const {core,dbPath,cleanup}=mkCore();try{
   const incoming=join(dirname(dbPath),'first'),m=writePackage(incoming);core.extensions.install(prepare(core,incoming));const update=join(dirname(dbPath),'upgrade');writePackage(update,{version:'1.1.0',title:'新版'});const input=prepare(core,update);
   const faulty=createExtensionService(core.db,{dbPath,events:()=>core.externalEvents,guard:name=>core.commands.guard(name),fault:at=>{if(at===phase)throw Error('模拟进程中断 '+phase);}});
   expect(()=>faulty.service.install(input)).toThrow('模拟进程中断');expect(core.extensions.get({extensionId:m.id})!.version).toBe('1.0.0');expect(core.extensions.getHelp({extensionId:m.id}).markdown).toContain('隔离工具');expect(core.extensions.install(prepare(core,update)).effect).toBe('updated');expect(core.extensions.get({extensionId:m.id})!.version).toBe('1.1.0');
  }finally{cleanup();}}
 });
 it('提交后丢响应可幂等重试，旧租约不能在恢复后激活',()=>{
  const {core,dbPath,cleanup}=mkCore();try{
   const incoming=join(dirname(dbPath),'first');writePackage(incoming);const input=prepare(core,incoming);
   const committed=createExtensionService(core.db,{dbPath,events:()=>core.externalEvents,fault:phase=>{if(phase==='after_commit')throw Error('响应丢失');}});
   expect(()=>committed.service.install(input)).toThrow('响应丢失');expect(core.extensions.install(prepare(core,incoming)).effect).toBe('unchanged');
   const upgrade=join(dirname(dbPath),'upgrade');writePackage(upgrade,{version:'1.1.0'});const module=createExtensionService(core.db,{dbPath,events:()=>core.externalEvents,fault:phase=>{if(phase==='after_stage'){core.db.exec("UPDATE extension_operations SET lease_expires_at='2000-01-01T00:00:00Z' WHERE phase='prepared'");module.recover();}}});
   expect(()=>module.service.install(prepare(core,upgrade))).toThrow('LEASE_LOST');expect(core.extensions.get({extensionId:'test.package'})!.version).toBe('1.0.0');expect(core.externalEvents.list({providerId:'ext:test.package/main'}).items).toHaveLength(1);
  }finally{cleanup();}
 });
 it('安装借用公共导入动作，停用导入导致激活和种子整批回滚',()=>{
  const {core,dbPath,cleanup}=mkCore();try{
   const incoming=join(dirname(dbPath),'first');writePackage(incoming);const input=prepare(core,incoming);core.ontology.updateActionType('import_external_events',{status:'disabled'});
   expect(()=>core.extensions.install(input)).toThrow('ACTION_DISABLED');expect(core.extensions.list()).toEqual([]);expect(core.externalEvents.listProviders()).toEqual([]);expect(core.todos.list()).toEqual([]);expect(core.runtime.listCollections()).toHaveLength(3);
   core.ontology.updateActionType('import_external_events',{status:'active'});expect(core.extensions.install(prepare(core,incoming)).effect).toBe('installed');
  }finally{cleanup();}
 });
});
