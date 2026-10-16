// 文件落位与数据库激活分别提交；操作租约、修订与不可变摘要共同保护版本切换。
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, existsSync, lstatSync, realpathSync, rmSync, constants, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { inTx, readSnapshot, type DbAdapter } from '../db';
import type { ExtensionManifest, ExtensionPreview, ExtensionPermission, ExtensionInstallInput, ExtensionInstallResult, ExtensionLifecycleInput, ExtensionEnableInput, ExtensionRollbackInput, HttpJsonConfig } from '../extension-types';
import { runtimeError } from '../utils/schedule';
import { canonical, digest } from './event-model';
import { checkManifest, readExtensionPackage, safeExtensionPath, sha256, versionCompare, type ExtensionPackage } from './extension-package';
import type { ExternalEventService } from './external-events';

type Row = Record<string, unknown>;
const TERMINAL = "'committed','failed','aborted'";
const manifestOf = (row: Row): ExtensionManifest => checkManifest(JSON.parse(String(row.manifest_json)));
const scopeOf = (m: ExtensionManifest, p: ExtensionPermission) => `ext:${m.id}/${p.providerLocalId}`;
const networkOf = (m: ExtensionManifest) => [...new Set(m.providers.filter(p=>p.kind==='http-json').map(p=>{const u=new URL((p.config as HttpJsonConfig).url);return u.origin+u.pathname;}))].sort();

export function createExtensionService(db: DbAdapter, deps: { dbPath:string;events:()=>ExternalEventService;guard?:(command:string)=>void;fault?:(phase:'after_stage'|'after_publish'|'before_commit'|'after_commit')=>void }) {
  const root=realpathSync(dirname(deps.dbPath));
  const raw=(id:string)=>db.prepare('SELECT * FROM extensions WHERE id=?').get(id);
  const active=(id:string)=>db.prepare('SELECT x.*,r.version,r.digest,r.manifest_json,r.relative_dir FROM extensions x JOIN extension_releases r ON r.id=x.active_release_id WHERE x.id=?').get(id);
  const version=(id:string,value:string)=>db.prepare('SELECT * FROM extension_releases WHERE extension_id=? AND version=?').get(id,value);
  const currentRevision=(id:string):number|null=>{const row=active(id);return row?Number(row.revision):null;};
  const requested=(m:ExtensionManifest)=>m.capabilities.map(p=>({capability:p.name,scope:scopeOf(m,p)})).sort((a,b)=>{const x=a.capability+'/'+a.scope,y=b.capability+'/'+b.scope;return x<y?-1:x>y?1:0;});
  const grants=(id:string)=>db.prepare('SELECT capability,scope,grant_revision,authorization_digest FROM extension_grants WHERE extension_id=? ORDER BY capability,scope').all(id);
  const canReuse=(m:ExtensionManifest)=>{
    const row=active(m.id);if(!row)return false;const old=manifestOf(row),actual=grants(m.id);
    return requested(m).every(p=>actual.some(g=>g.capability===p.capability&&g.scope===p.scope))&&networkOf(m).every(url=>networkOf(old).includes(url));
  };
  const reuseRef=(pack:ExtensionPackage)=>canReuse(pack.manifest)?'existing:'+digest({packageDigest:pack.digest,revision:currentRevision(pack.manifest.id),grants:grants(pack.manifest.id),network:networkOf(pack.manifest)}):null;
  const authorizationValid=(pack:ExtensionPackage,ref:string,baseline:number|null)=>{
    if(ref&&ref===reuseRef(pack))return;
    const approved=db.prepare('SELECT * FROM extension_authorizations WHERE id=?').get(ref);
    if(!approved||approved.extension_id!==pack.manifest.id||approved.package_digest!==pack.digest||approved.base_revision!==baseline||String(approved.expires_at)<=new Date().toISOString()||approved.permissions_json!==canonical(requested(pack.manifest))||approved.network_json!==canonical(networkOf(pack.manifest)))runtimeError('PERMISSION_DENIED','安装尚未获得绑定当前摘要、修订和范围的宿主授权');
  };
  const previewPackage=(pack:ExtensionPackage):ExtensionPreview=>{
    const m=pack.manifest,row=active(m.id),actual=grants(m.id),oldNetwork=row?networkOf(manifestOf(row)):[];
    const same=version(m.id,m.version);if(same&&same.digest!==pack.digest)runtimeError('VERSION_CONTENT_CONFLICT','同一版本已存在不同内容，请提升工具版本');
    return {extensionId:m.id,title:m.title,version:m.version,digest:pack.digest,currentRevision:row?Number(row.revision):null,currentVersion:row?String(row.version):null,requestedPermissions:m.capabilities,
      permissionDelta:m.capabilities.filter(p=>!actual.some(g=>g.capability===p.name&&g.scope===scopeOf(m,p))),networkTargets:networkOf(m),networkChanges:networkOf(m).filter(url=>!oldNetwork.includes(url)),authorizationRef:reuseRef(pack),collections:m.collections,providers:m.providers};
  };
  const previewInstall=(input:{stagingDirectory:string})=>{const pack=readExtensionPackage(input.stagingDirectory);return readSnapshot(db,()=>previewPackage(pack));};
  const authorizeInstall=(input:{stagingDirectory:string;expectedPackageDigest:string;expectedExtensionRevision:number|null})=>{
    const pack=readExtensionPackage(input.stagingDirectory);
    return inTx(db,()=>{
      deps.guard?.('authorize_extension_install');previewPackage(pack);
      if(pack.digest!==input.expectedPackageDigest||currentRevision(pack.manifest.id)!==input.expectedExtensionRevision)runtimeError('REVISION_CONFLICT','包或安装基线已变化，请重新预览');
      const id='approval-'+randomUUID(),now=new Date();db.prepare('INSERT INTO extension_authorizations VALUES(?,?,?,?,?,?,?,?)').run(id,pack.manifest.id,pack.digest,input.expectedExtensionRevision,canonical(requested(pack.manifest)),canonical(networkOf(pack.manifest)),new Date(now.getTime()+1800000).toISOString(),now.toISOString());
      return {authorizationRef:id,packageDigest:pack.digest};
    });
  };
  const safeDirectory=(path:string)=>{
    const rel=relative(root,path);if(!rel||rel.startsWith('..')||rel.split(sep).some(p=>!p))runtimeError('PACKAGE_INVALID','安装路径越界');
    let at=root;for(const part of rel.split(sep)){at=join(at,part);if(existsSync(at)){if(lstatSync(at).isSymbolicLink()||!lstatSync(at).isDirectory())runtimeError('PACKAGE_INVALID','安装目录包含符号链接或非目录');}else mkdirSync(at,{mode:0o700});}
  };
  const releasePath=(row:Row)=>{
    const rel=String(row.relative_dir);if(!/^extensions\/e-[a-f0-9]{32}\/releases\/[a-f0-9]{64}$/.test(rel))return runtimeError('ASSET_INTEGRITY_FAILED','安装路径记录不合法');return join(root,rel);
  };
  const releaseHealthy=(row:Row)=>{try{return readExtensionPackage(releasePath(row)).digest===row.digest;}catch{return false;}};
  const checkReferences=(m:ExtensionManifest)=>{
    const ids=new Set(m.providers.map(p=>`ext:${m.id}/${p.localId}`)),collections=new Set(m.collections.map(c=>`ext:${m.id}/${c.localId}`));
    for(const row of db.prepare('SELECT * FROM event_providers WHERE extension_id=?').all(m.id)){
      if(!ids.has(String(row.id))&&db.prepare('SELECT 1 FROM external_events WHERE provider_id=? LIMIT 1').get(row.id))runtimeError('REFERENCE_CONFLICT','更新/回滚不能移除仍有事件引用的数据源');
      const next=m.providers.find(p=>`ext:${m.id}/${p.localId}`===row.id);if(next&&row.collection_id!==`ext:${m.id}/${next.collectionLocalId}`)runtimeError('REFERENCE_CONFLICT','已有数据源不能更换稳定分类身份');
    }
    for(const c of db.prepare('SELECT id FROM calendar_collections WHERE owner_extension_id=?').all(m.id))if(!collections.has(String(c.id))&&(db.prepare('SELECT 1 FROM todos WHERE collection_id=? LIMIT 1').get(c.id)||db.prepare('SELECT 1 FROM calendar_events WHERE collection_id=? LIMIT 1').get(c.id)||db.prepare('SELECT 1 FROM event_providers p JOIN external_events e ON e.provider_id=p.id WHERE p.collection_id=? LIMIT 1').get(c.id)))runtimeError('REFERENCE_CONFLICT','更新/回滚不能移除仍有业务引用的分类');
  };
  const ensureLease=(id:string,owner:string)=>{const op=db.prepare('SELECT * FROM extension_operations WHERE id=?').get(id);if(!op||op.lease_owner!==owner||String(op.lease_expires_at)<=new Date().toISOString()||['failed','aborted','committed'].includes(String(op.phase)))return runtimeError('LEASE_LOST','安装操作租约已失效');return op;};
  const installPackage=(pack:ExtensionPackage,input:ExtensionInstallInput,kind:'install'|'rollback'='install'):ExtensionInstallResult=>{
    const m=pack.manifest;let operation='',owner='',releaseId='',origin='',baseline=0;
    const old=readSnapshot(db,()=>{previewPackage(pack);authorizationValid(pack,input.authorizationRef,input.expectedExtensionRevision);const row=active(m.id);if(currentRevision(m.id)!==input.expectedExtensionRevision)runtimeError('REVISION_CONFLICT','工具已被其他进程修改');checkReferences(m);return row;});
    if(old&&kind==='install'&&versionCompare(m.version,String(old.version))<0)runtimeError('REVISION_CONFLICT','降低页面版本请使用显式回滚');
    if(old?.digest===pack.digest&&old.status!=='uninstalled'&&canReuse(m)&&canonical(grants(m.id).map(g=>({capability:g.capability,scope:g.scope})))===canonical(requested(m))&&releaseHealthy(old))return {extensionId:m.id,version:m.version,digest:pack.digest,effect:'unchanged',revision:Number(old.revision)};
    inTx(db,()=>{
      if(currentRevision(m.id)!==input.expectedExtensionRevision)runtimeError('REVISION_CONFLICT','工具基线已变化');
      const running=db.prepare(`SELECT id FROM extension_operations WHERE extension_id=? AND phase NOT IN (${TERMINAL}) AND lease_expires_at>?`).get(m.id,new Date().toISOString());if(running)runtimeError('SQLITE_BUSY','同一工具已有安装操作，请稍后重试');
      const row=raw(m.id),now=new Date().toISOString();origin=row?String(row.origin_key):'e-'+randomBytes(16).toString('hex');
      if(!/^e-[a-f0-9]{32}$/.test(origin))runtimeError('PACKAGE_INVALID','工具安装身份与新运行时格式不兼容');
      if(!row)db.prepare("INSERT INTO extensions(id,origin_key,status,revision,created_at,updated_at) VALUES(?,?,'uninstalled',0,?,?)").run(m.id,origin,now,now);
      baseline=Number(raw(m.id)!.revision);const existing=version(m.id,m.version);if(existing&&existing.digest!==pack.digest)runtimeError('VERSION_CONTENT_CONFLICT','同版本内容冲突');
      releaseId=existing?String(existing.id):randomUUID();
      if(!existing)db.prepare('INSERT INTO extension_releases VALUES(?,?,?,?,?,?,?,?)').run(releaseId,m.id,m.version,pack.digest,canonical(m),`extensions/${origin}/releases/${pack.digest}`,'prepared',now);
      operation=randomUUID();owner=randomUUID();db.prepare('INSERT INTO extension_operations(id,kind,extension_id,base_revision,target_digest,phase,lease_owner,lease_expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(operation,kind,m.id,baseline,pack.digest,'prepared',owner,new Date(Date.now()+60000).toISOString(),now,now);
    });
    const base=join(root,'extensions',origin),stage=join(base,'staging',operation),final=join(base,'releases',pack.digest);
    try{
      safeDirectory(stage);for(const[name,buffer]of pack.files){safeDirectory(dirname(join(stage,name)));writeFileSync(join(stage,name),buffer,{flag:'wx',mode:0o600});}writeFileSync(join(stage,'manifest.json'),canonical(m),{flag:'wx',mode:0o600});
      if(readExtensionPackage(stage).digest!==pack.digest)runtimeError('ASSET_INTEGRITY_FAILED','暂存校验失败');deps.fault?.('after_stage');
      inTx(db,()=>{ensureLease(operation,owner);});safeDirectory(dirname(final));
      const row=db.prepare('SELECT * FROM extension_releases WHERE id=?').get(releaseId)!;
      if(existsSync(final)){if(releaseHealthy(row))rmSync(stage,{recursive:true});else{if(lstatSync(final).isSymbolicLink())runtimeError('PACKAGE_INVALID','版本目录不能是符号链接');renameSync(final,join(base,'releases','corrupt-'+operation));renameSync(stage,final);}}else renameSync(stage,final);
      inTx(db,()=>{ensureLease(operation,owner);db.prepare("UPDATE extension_operations SET phase='files_ready',updated_at=? WHERE id=?").run(new Date().toISOString(),operation);});deps.fault?.('after_publish');
      const result=inTx(db,()=>{
        deps.guard?.(kind==='rollback'?'rollback_extension':'install_extension');ensureLease(operation,owner);if(Number(raw(m.id)!.revision)!==baseline||currentRevision(m.id)!==input.expectedExtensionRevision)runtimeError('REVISION_CONFLICT','安装激活基线已变化');authorizationValid(pack,input.authorizationRef,input.expectedExtensionRevision);checkReferences(m);
        const now=new Date().toISOString(),same=old?.digest===pack.digest,permissionsSame=canonical(grants(m.id).map(g=>({capability:g.capability,scope:g.scope})))===canonical(requested(m));
        const changed=!same||!permissionsSame||old?.status==='uninstalled',revision=changed?baseline+1:baseline;
        for(const c of m.collections)db.prepare('INSERT INTO calendar_collections(id,owner_extension_id,title,color,sort_order) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,color=excluded.color,sort_order=excluded.sort_order,archived=0 WHERE title<>excluded.title OR color<>excluded.color OR sort_order<>excluded.sort_order OR archived<>0').run(`ext:${m.id}/${c.localId}`,m.id,c.title,c.color,c.sortOrder);
        const providerIds=new Set(m.providers.map(p=>`ext:${m.id}/${p.localId}`));
        for(const p of m.providers){const id=`ext:${m.id}/${p.localId}`,config=canonical(p.config);db.prepare('INSERT INTO event_providers(id,extension_id,collection_id,kind,config_json,refresh_seconds,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,config_json=excluded.config_json,refresh_seconds=excluded.refresh_seconds,revision=event_providers.revision+1,updated_at=excluded.updated_at WHERE kind<>excluded.kind OR config_json<>excluded.config_json OR refresh_seconds IS NOT excluded.refresh_seconds').run(id,m.id,`ext:${m.id}/${p.collectionLocalId}`,p.kind,config,p.refreshSeconds??null,now);}
        for(const p of db.prepare('SELECT id FROM event_providers WHERE extension_id=?').all(m.id))if(!providerIds.has(String(p.id)))db.prepare('UPDATE event_providers SET enabled=0,revision=revision+1,updated_at=? WHERE id=? AND enabled=1').run(now,p.id);
        const collectionIds=new Set(m.collections.map(c=>`ext:${m.id}/${c.localId}`));for(const c of db.prepare('SELECT id FROM calendar_collections WHERE owner_extension_id=?').all(m.id))if(!collectionIds.has(String(c.id)))db.prepare('UPDATE calendar_collections SET archived=1 WHERE id=? AND archived=0').run(c.id);
        if(changed){db.prepare('DELETE FROM extension_grants WHERE extension_id=?').run(m.id);for(const permission of requested(m))db.prepare('INSERT INTO extension_grants VALUES(?,?,?,?,?)').run(m.id,permission.capability,permission.scope,revision,pack.digest);db.prepare("UPDATE extensions SET active_release_id=?,status=?,revision=?,updated_at=? WHERE id=?").run(releaseId,old?.status==='disabled'?'disabled':'active',revision,now,m.id);}
        db.prepare("UPDATE extension_releases SET state='ready' WHERE id=? AND state<>'ready'").run(releaseId);
        if(kind!=='rollback'&&!same&&old?.status!=='disabled'&&m.seed&&db.prepare('SELECT enabled FROM event_providers WHERE id=?').get(`ext:${m.id}/${m.seed.providerLocalId}`)?.enabled){const providerId=`ext:${m.id}/${m.seed.providerLocalId}`,missing=pack.seed.filter(event=>!db.prepare('SELECT 1 FROM external_events WHERE provider_id=? AND external_id=?').get(providerId,event.externalId));if(missing.length){const provider=db.prepare('SELECT revision FROM event_providers WHERE id=?').get(providerId)!;deps.events().import({providerId,batchId:'seed:'+pack.digest,expectedProviderRevision:Number(provider.revision),events:missing});}}
        deps.fault?.('before_commit');db.prepare("UPDATE extension_operations SET phase='committed',lease_expires_at=NULL,updated_at=? WHERE id=?").run(now,operation);
        return {extensionId:m.id,version:m.version,digest:pack.digest,effect:!old||old.status==='uninstalled'?'installed':same?'repaired':'updated',revision} as ExtensionInstallResult;
      });deps.fault?.('after_commit');return result;
    }catch(error){inTx(db,()=>{db.prepare("UPDATE extension_operations SET phase='failed',error=?,lease_expires_at=NULL,updated_at=? WHERE id=? AND phase<>'committed'").run(error instanceof Error?error.message:String(error),new Date().toISOString(),operation);});throw error;}
  };
  const install=(input:ExtensionInstallInput)=>{const pack=readExtensionPackage(input.stagingDirectory);if(pack.digest!==input.expectedPackageDigest)runtimeError('ASSET_INTEGRITY_FAILED','包内容与预览摘要不同');return installPackage(pack,input);};
  const get=(input:{extensionId:string})=>readSnapshot(db,()=>{const row=active(input.extensionId);if(!row)return null;const m=manifestOf(row),actualGrants=grants(m.id);return {id:m.id,title:m.title,description:m.description,icon:m.icon??'tool',version:m.version,digest:String(row.digest),status:row.status as 'active'|'disabled'|'uninstalled',revision:Number(row.revision),origin:'dayfolio-tool://'+String(row.origin_key),entry:m.entry,manifest:m,authorizationRevision:digest(actualGrants),grantedCapabilities:actualGrants.map(g=>({name:String(g.capability),providerId:String(g.scope)})),releases:db.prepare("SELECT version,digest,state FROM extension_releases WHERE extension_id=? ORDER BY created_at DESC").all(m.id).map(r=>({version:String(r.version),digest:String(r.digest),state:String(r.state)}))};});
  const list=()=>readSnapshot(db,()=>db.prepare('SELECT id FROM extensions WHERE active_release_id IS NOT NULL ORDER BY created_at,id').all().map(row=>get({extensionId:String(row.id)})!));
  const lifecycle=(input:ExtensionLifecycleInput,status:'active'|'disabled'|'uninstalled',command:string)=>inTx(db,()=>{deps.guard?.(command);const row=active(input.extensionId);if(!row)runtimeError('EVENT_NOT_FOUND','工具不存在');if(Number(row!.revision)!==input.expectedRevision)runtimeError('REVISION_CONFLICT','工具已变化');if(row!.status==='uninstalled'&&status!=='uninstalled')runtimeError('PERMISSION_DENIED','已卸载工具须重新安装');if(row!.status!==status)db.prepare('UPDATE extensions SET status=?,revision=revision+1,updated_at=? WHERE id=?').run(status,new Date().toISOString(),input.extensionId);return get(input)!;});
  const setEnabled=(input:ExtensionEnableInput)=>{if(input.enabled){const row=active(input.extensionId);if(row&&!releaseHealthy(row))runtimeError('ASSET_INTEGRITY_FAILED','版本文件不完整，请先同摘要重装修复');}if(typeof input.enabled!=='boolean')return runtimeError('CONTRACT_INVALID','启用状态须为布尔值');return lifecycle(input,input.enabled?'active':'disabled','set_extension_enabled');};
  const uninstall=(input:ExtensionLifecycleInput)=>lifecycle(input,'uninstalled','uninstall_extension');
  const rollback=(input:ExtensionRollbackInput)=>{if(active(input.extensionId)?.status==='uninstalled')return runtimeError('PERMISSION_DENIED','已卸载工具须明确重新安装');const row=version(input.extensionId,input.version);if(!row||row.state!=='ready')return runtimeError('PACKAGE_INVALID','没有可回滚的完整版本');const pack=readExtensionPackage(releasePath(row));return installPackage(pack,{stagingDirectory:releasePath(row),expectedExtensionRevision:input.expectedRevision,expectedPackageDigest:pack.digest,authorizationRef:input.authorizationRef??reuseRef(pack)??''},'rollback');};
  const readAsset=(input:{extensionId:string;releaseDigest:string;path:string;historical?:boolean})=>{
    const current=active(input.extensionId);if(!current||(!input.historical&&(current.status!=='active'||current.digest!==input.releaseDigest)))return runtimeError('SESSION_REVOKED','工具版本或状态已变化');
    const row=db.prepare("SELECT * FROM extension_releases WHERE extension_id=? AND digest=? AND state='ready'").get(input.extensionId,input.releaseDigest);if(!row)return runtimeError('ASSET_INTEGRITY_FAILED','版本资源不存在');
    const m=manifestOf(row),name=safeExtensionPath(input.path);if(!Object.hasOwn(m.files,name))return runtimeError('PERMISSION_DENIED','资源未列入包清单');const base=releasePath(row),file=join(base,name);let at=root;for(const part of relative(root,base).split(sep)){at=join(at,part);if(lstatSync(at).isSymbolicLink())return runtimeError('ASSET_INTEGRITY_FAILED','版本目录包含符号链接');}at=base;
    for(const part of name.split('/')){at=join(at,part);if(lstatSync(at).isSymbolicLink())return runtimeError('ASSET_INTEGRITY_FAILED','版本资源包含符号链接');}
    if(!realpathSync(file).startsWith(realpathSync(base)+sep))return runtimeError('ASSET_INTEGRITY_FAILED','版本资源越界');
    const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=fstatSync(fd);if(!stat.isFile()||stat.size>5*1024*1024)runtimeError('ASSET_INTEGRITY_FAILED','资源类型或大小不合法');const buffer=Buffer.alloc(stat.size+1);let n=0;while(n<buffer.length){const count=readSync(fd,buffer,n,buffer.length-n,null);if(!count)break;n+=count;}const data=buffer.subarray(0,n);if(n!==stat.size||sha256(data)!==m.files[name])runtimeError('ASSET_INTEGRITY_FAILED','资源摘要已变化');return data;}finally{closeSync(fd);}
  };
  const getHelp=(input:{extensionId:string})=>{const row=active(input.extensionId);if(!row)return runtimeError('PACKAGE_INVALID','工具不存在');const m=manifestOf(row);return {extensionId:m.id,title:m.title,version:m.version,markdown:new TextDecoder('utf-8',{fatal:true}).decode(readAsset({extensionId:m.id,releaseDigest:String(row.digest),path:m.help,historical:true}))};};
  const recover=()=>inTx(db,()=>{const rows=db.prepare(`SELECT * FROM extension_operations WHERE phase NOT IN (${TERMINAL}) AND (lease_expires_at IS NULL OR lease_expires_at<=?)`).all(new Date().toISOString());for(const op of rows)db.prepare("UPDATE extension_operations SET phase='aborted',error='进程中断或租约过期，未激活目录可在重试时复用',lease_expires_at=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(),op.id);return {recovered:rows.length};});
  return {service:{previewInstall,authorizeInstall,install,list,get,getHelp,setEnabled,uninstall,rollback,readAsset},recover};
}
export type ExtensionService=ReturnType<typeof createExtensionService>['service'];
