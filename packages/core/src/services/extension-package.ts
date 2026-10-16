// 包校验只接受固定 JSON Schema 和静态资源；不执行工具脚本、表达式或迁移代码。
import Ajv from 'ajv';
import { constants, lstatSync, openSync, fstatSync, readSync, closeSync, realpathSync, readdirSync } from 'node:fs';
import { join, sep, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import manifestSchema from '../contracts/manifest.schema.json';
import appPackage from '../../../../package.json';
import type { ExtensionManifest, HttpJsonConfig } from '../extension-types';
import type { ExternalEventInput } from '../runtime-types';
import { canonical, normalizeEvent } from './event-model';
import { runtimeError } from '../utils/schedule';
import { ensureValidDateStr } from '../utils/date';
import { assertPublicHost } from './provider-https';

export const EXTENSION_API = { major:1,minor:0 } as const;
export const sha256 = (bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const ajv = new Ajv({allErrors:true,strict:false});
ajv.addFormat('date',value=>{try{return ensureValidDateStr(value)===value;}catch{return false;}});
ajv.addFormat('date-time',value=>/(?:Z|[+-]\d\d:\d\d)$/.test(value)&&Number.isFinite(Date.parse(value)));
const validateManifest = ajv.compile<ExtensionManifest>(manifestSchema);
const FORBIDDEN = new Set(['__proto__','prototype','constructor']);
export function safeExtensionPath(name:string):string {
  if(typeof name!=='string'||name.length>240||!/[A-Za-z0-9]/.test(name[0]??'')||!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)||name.split('/').some(p=>!p||p==='.'||p==='..')||name.startsWith('__dayfolio_sdk__/')||name==='__dayfolio_sdk__'||name==='manifest.json')return runtimeError('PACKAGE_INVALID','包内路径非法或使用保留名称');
  return name;
}
export function versionCompare(a:string,b:string):number {
  const x=a.split('.').map(Number),y=b.split('.').map(Number);
  for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]<y[i]?-1:1;
  return 0;
}
/** v1 日期参数只接受明确日期；不把 URL 当作可变、无界的代理入口。 */
function validateSourceDateQuery(url: URL): void {
  const parse = (value: string): number => {
    const date = /^\d{8}$/.test(value) ? `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}` : value;
    try { ensureValidDateStr(date); } catch { return runtimeError('PACKAGE_INVALID', '来源日期参数须为有效 YYYY-MM-DD 或 YYYYMMDD'); }
    return Date.parse(date + 'T00:00:00Z');
  };
  const once = (key: string) => { const values = url.searchParams.getAll(key); if (values.length > 1) runtimeError('PACKAGE_INVALID', '来源日期参数不能重复'); return values[0]; };
  for (const [start, end] of [['fromDate','toDateExclusive'],['from','to'],['startDate','endDate'],['date_from','date_to'],['start_date','end_date']]) {
    const a = once(start), b = once(end);
    if (a === undefined && b === undefined) continue;
    if (a === undefined || b === undefined) runtimeError('PACKAGE_INVALID', '来源日期区间必须同时提供起止日期');
    const days = (parse(b) - parse(a)) / 86400000;
    if (days < 0 || days > 100) runtimeError('PACKAGE_INVALID', '来源日期区间不得倒序或超过 100 天');
  }
  const single = once('date'); if (single !== undefined) parse(single);
  const dates = once('dates');
  if (dates !== undefined) {
    const match = /^(\d{8})(?:-(\d{8}))?$/.exec(dates);
    if (!match) return runtimeError('PACKAGE_INVALID', 'dates 参数只支持 YYYYMMDD 或有界 YYYYMMDD-YYYYMMDD');
    const days = (parse(match[2] ?? match[1]) - parse(match[1])) / 86400000;
    if (days < 0 || days >= 100) runtimeError('PACKAGE_INVALID', '来源日期区间不得倒序或超过 100 天');
  }
}
export function validateHttpConfig(config:HttpJsonConfig):void {
  const targets=new Set(['externalId','title','timeKind','startAt','endAt','startDate','endDateExclusive','sourceTimezone','status','sourceUrl','payload']);
  const checkPath=(path:string)=>{if(typeof path!=='string'||!/^[_A-Za-z][_A-Za-z0-9]*(?:\.[_A-Za-z][_A-Za-z0-9]*)*$/.test(path)||path.split('.').some(p=>FORBIDDEN.has(p)))runtimeError('PACKAGE_INVALID','字段映射只允许安全的点分属性路径');};
  checkPath(config.itemsPath);
  let url:URL;try{url=new URL(config.url);}catch{return runtimeError('PACKAGE_INVALID','数据源 URL 无效');}
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.port&&url.port!=='443')return runtimeError('PACKAGE_INVALID','数据源仅支持不带凭据的标准 HTTPS URL');
  assertPublicHost(url.hostname);
  validateSourceDateQuery(url);
  if([...url.searchParams.keys()].some(key=>/token|secret|password|authorization|api.?key/i.test(key)))runtimeError('PACKAGE_INVALID','公共数据源 URL 不得携带访问凭据');
  for(const [target,value]of Object.entries(config.fieldMappings)){
    const payload=target.startsWith('payload.');
    if(!targets.has(target)&&!payload)runtimeError('PACKAGE_INVALID','映射包含未知目标字段');
    if(payload)checkPath(target);
    if(value.path!==undefined)checkPath(value.path);
  }
  const names=Object.keys(config.fieldMappings).sort();
  for(let i=0;i<names.length;i++)if(names.slice(i+1).some(name=>name.startsWith(names[i]+'.')))runtimeError('PACKAGE_INVALID','字段映射目标不能同时覆盖父属性和子属性');
  for(const field of ['externalId','title','timeKind','startAt','endAt','startDate','endDateExclusive','status','sourceUrl'])if(!Object.hasOwn(config.fieldMappings,field))runtimeError('PACKAGE_INVALID',`映射缺少 ${field}，未知时间须显式映射为 null`);
}
export function checkManifest(input:unknown):ExtensionManifest {
  if(!validateManifest(input))return runtimeError('PACKAGE_INVALID','Manifest 不符合 v1 合同：'+ajv.errorsText(validateManifest.errors,{separator:'；'}));
  const m=input;
  if(m.hostApi.major!==EXTENSION_API.major||m.hostApi.minMinor>EXTENSION_API.minor)runtimeError('HOST_API_UNSUPPORTED','工具要求的宿主 API 不兼容');
  if(m.minAppVersion&&versionCompare(m.minAppVersion,appPackage.version)>0)runtimeError('HOST_API_UNSUPPORTED','工具要求更高版本的 App');
  const collections=new Set(m.collections.map(c=>c.localId)),providers=new Set(m.providers.map(p=>p.localId));
  if(collections.size!==m.collections.length||providers.size!==m.providers.length)runtimeError('PACKAGE_INVALID','分类或数据源本地标识重复');
  for(const p of m.providers){if(!collections.has(p.collectionLocalId))runtimeError('PACKAGE_INVALID','数据源引用未知分类');if(p.kind==='http-json')validateHttpConfig(p.config as HttpJsonConfig);}
  const permissions=new Set<string>();
  for(const c of m.capabilities){const key=c.name+'/'+c.providerLocalId;if(!providers.has(c.providerLocalId)||permissions.has(key))runtimeError('PACKAGE_INVALID','权限范围不存在或重复');permissions.add(key);}
  const actions=new Set<string>();
  for(const a of m.contributions?.calendarActions??[]){if(!providers.has(a.providerLocalId)||actions.has(a.localId))runtimeError('PACKAGE_INVALID','日历操作引用错误或重复');actions.add(a.localId);if(a.kind==='refresh_provider'&&!permissions.has('providers.refresh/'+a.providerLocalId))runtimeError('PACKAGE_INVALID','刷新操作缺少对应权限声明');}
  for(const name of [m.entry,m.help,...Object.keys(m.files)])safeExtensionPath(name);
  if(!Object.hasOwn(m.files,m.entry)||!Object.hasOwn(m.files,m.help)||!m.entry.endsWith('.html')||!m.help.endsWith('.md'))runtimeError('PACKAGE_INVALID','入口须为清单内 HTML，帮助须为清单内 Markdown');
  if(m.icon&&!['tool','calendar','music','trophy'].includes(m.icon)){safeExtensionPath(m.icon);if(!Object.hasOwn(m.files,m.icon))runtimeError('PACKAGE_INVALID','图标未列入资源清单');}
  if(m.seed){safeExtensionPath(m.seed.file);if(!providers.has(m.seed.providerLocalId)||!Object.hasOwn(m.files,m.seed.file))runtimeError('PACKAGE_INVALID','种子引用错误');}
  return m;
}
export interface ExtensionPackage {manifest:ExtensionManifest;digest:string;files:Map<string,Buffer>;seed:ExternalEventInput[];bytes:number}

/** 一次读成有界快照，之后只从内存落位，不对不受信目录执行 cp。 */
export function readExtensionPackage(directory:string):ExtensionPackage {
  if(typeof directory!=='string'||!isAbsolute(directory))return runtimeError('PACKAGE_INVALID','工具包须为绝对目录');
  const rootInfo=lstatSync(directory);if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory())runtimeError('PACKAGE_INVALID','工具包须为非符号链接目录');
  const root=realpathSync(directory),files=new Map<string,Buffer>();let bytes=0,entries=0;
  const read=(path:string,max=5*1024*1024):Buffer=>{
    const before=lstatSync(path);if(!before.isFile()||before.isSymbolicLink()||before.size>max)runtimeError('PACKAGE_INVALID','资源类型或大小不合法');
    const actual=realpathSync(path);if(!actual.startsWith(root+sep))runtimeError('PACKAGE_INVALID','资源越过包根目录');
    const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{const stat=fstatSync(fd);if(stat.ino!==before.ino||stat.dev!==before.dev||stat.size>max)runtimeError('PACKAGE_INVALID','读取期间资源发生变化');const buffer=Buffer.alloc(before.size+1);let count=0;while(count<buffer.length){const n=readSync(fd,buffer,count,buffer.length-count,null);if(!n)break;count+=n;}if(count!==before.size||fstatSync(fd).size!==before.size)runtimeError('PACKAGE_INVALID','读取期间资源大小变化');return buffer.subarray(0,count);}finally{closeSync(fd);}
  };
  const manifestBytes=read(join(root,'manifest.json'));
  let raw:unknown;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(manifestBytes));}catch{return runtimeError('PACKAGE_INVALID','Manifest 须为 UTF-8 JSON');}
  const manifest=checkManifest(raw);bytes=manifestBytes.length;
  const visit=(path:string,prefix='')=>{
    for(const entry of readdirSync(path,{withFileTypes:true})){
      if(++entries>1024)runtimeError('PACKAGE_INVALID','包内目录或资源过多');
      const name=prefix+entry.name;if(name==='manifest.json')continue;safeExtensionPath(name);
      if(entry.isSymbolicLink())runtimeError('PACKAGE_INVALID','工具包不允许符号链接');
      if(entry.isDirectory()){if(!Object.keys(manifest.files).some(file=>file.startsWith(name+'/')))runtimeError('PACKAGE_INVALID','存在清单之外的目录');visit(join(path,entry.name),name+'/');}
      else if(entry.isFile()){
        if(!Object.hasOwn(manifest.files,name))runtimeError('PACKAGE_INVALID','存在文件清单之外的资源');
        const buffer=read(join(path,entry.name));bytes+=buffer.length;
        if(bytes>20*1024*1024||files.size>=256)runtimeError('PACKAGE_INVALID','包超过 20 MiB 或 256 个资源');
        if(sha256(buffer)!==manifest.files[name])runtimeError('ASSET_INTEGRITY_FAILED',`资源摘要不匹配：${name}`);files.set(name,buffer);
      }else runtimeError('PACKAGE_INVALID','资源不允许使用设备或管道类型');
    }
  };
  visit(root);
  if(files.size!==Object.keys(manifest.files).length)runtimeError('ASSET_INTEGRITY_FAILED','资源清单存在缺失文件');
  let seed:ExternalEventInput[]=[];
  if(manifest.seed){let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(files.get(manifest.seed.file)!));}catch{return runtimeError('PACKAGE_INVALID','种子须为 UTF-8 JSON');}
    if(!Array.isArray(value)||value.length>500||Buffer.byteLength(canonical(value))>5*1024*1024)return runtimeError('PACKAGE_INVALID','种子批次超过限制');
    seed=value.map(normalizeEvent);if(new Set(seed.map(e=>e.externalId)).size!==seed.length)runtimeError('PACKAGE_INVALID','种子含重复事件身份');
  }
  return {manifest,digest:sha256('DAYFOLIO-PACKAGE-V1\n'+canonical(manifest)),files,seed,bytes};
}
