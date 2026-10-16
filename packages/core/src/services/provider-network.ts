// 通用 HTTPS JSON 与声明式字段映射；不执行页面脚本或任意转换表达式。
import type { HttpJsonConfig } from '../extension-types';
import type { ExternalEventInput, Json } from '../runtime-types';
import type { ProviderNetworkOptions } from '../provider-types';
import { validateHttpConfig } from './extension-package';
import { canonical, normalizeEvent } from './event-model';
import { RuntimeError, runtimeError } from '../utils/schedule';
import { publicHttpsFetch } from './provider-https';

const MAX_BATCH=500,MAX_BYTES=5*1024*1024;
function readPath(value:unknown,path:string):unknown {
  let current=value;
  for(const part of path.split('.')){
    if(!current||typeof current!=='object'||!Object.hasOwn(current,part))return runtimeError('EVENT_MAPPING_INVALID',`来源缺少字段 ${path}`);
    current=Reflect.get(current,part);
  }
  return current;
}
export function mapProviderJson(value:unknown,config:HttpJsonConfig):ExternalEventInput[] {
  validateHttpConfig(config);
  const items=readPath(value,config.itemsPath);
  if(!Array.isArray(items)||items.length>MAX_BATCH)return runtimeError('EVENT_MAPPING_INVALID','来源条目须为不超过 500 项的数组，不能静默截断');
  const events=items.map((item,index)=>{
    if(!item||typeof item!=='object'||Array.isArray(item))return runtimeError('EVENT_MAPPING_INVALID',`第 ${index+1} 条来源不是对象`);
    const target:Record<string,unknown>={payload:{}};
    for(const[name,mapping]of Object.entries(config.fieldMappings)){
      let mapped=mapping.path!==undefined?readPath(item,mapping.path):mapping.literal;
      if(name==='status'&&config.statusMap){
        if(typeof mapped!=='string'||!Object.hasOwn(config.statusMap,mapped))return runtimeError('EVENT_MAPPING_INVALID',`来源状态未明确映射：${String(mapped)}`);
        mapped=config.statusMap[mapped];
      }
      if(name.startsWith('payload.')){
        const keys=name.split('.').slice(1);let at=target.payload as Record<string,unknown>;
        for(const part of keys.slice(0,-1)){at[part]??={};at=at[part] as Record<string,unknown>;}
        at[keys[keys.length-1]]=mapped;
      }else target[name]=mapped;
    }
    return normalizeEvent(target as ExternalEventInput);
  });
  if(new Set(events.map(event=>event.externalId)).size!==events.length)return runtimeError('EVENT_INVALID','来源批次包含重复稳定 ID');
  if(Buffer.byteLength(canonical(events))>MAX_BYTES)return runtimeError('EVENT_INVALID','映射后批次超过 5 MiB');
  return events;
}

/** 每一跳重新核对协议、凭据和已授权路径；请求不携带 Cookie 或调用者提供的头。 */
export async function readHttpsJson(rawUrl:string,options:ProviderNetworkOptions,fetcher:typeof fetch=publicHttpsFetch):Promise<unknown> {
  const approved=new URL(rawUrl),timeout=AbortSignal.timeout(options.timeoutMs),signal=AbortSignal.any([options.signal,timeout]);
  const validate=(url:URL)=>{
    validateHttpConfig({url:url.toString(),itemsPath:'items',fieldMappings:Object.fromEntries(['externalId','title','timeKind','startAt','endAt','startDate','endDateExclusive','status','sourceUrl'].map(key=>[key,{literal:null}]))});
    const prefix=approved.pathname.endsWith('/')?approved.pathname:approved.pathname+'/';
    if(url.origin!==approved.origin||(url.pathname!==approved.pathname&&!url.pathname.startsWith(prefix)))return runtimeError('PERMISSION_DENIED','重定向超出已授权来源路径');
  };
  let current=approved;
  try{
    for(let redirects=0;redirects<=3;redirects++){
      validate(current);
      const response=await fetcher(current.toString(),{method:'GET',redirect:'manual',credentials:'omit',cache:'no-store',headers:{Accept:'application/json','User-Agent':'Dayfolio-runtime/1'},signal});
      if([301,302,303,307,308].includes(response.status)){
        const location=response.headers.get('location');await response.body?.cancel();
        if(!location||redirects===3)return runtimeError('HTTP_REDIRECT_FAILED','重定向次数过多或缺少目标');
        current=new URL(location,current);validate(current);continue;
      }
      if(response.status!==200){await response.body?.cancel();return runtimeError('HTTP_SOURCE_FAILED',`来源 HTTP 状态 ${response.status}`);}
      const kind=(response.headers.get('content-type')??'').split(';')[0].trim().toLowerCase();
      if(kind&&!['application/json','text/plain'].includes(kind)&&!kind.endsWith('+json')){await response.body?.cancel();return runtimeError('HTTP_SOURCE_FAILED','来源未返回 JSON 内容');}
      const length=Number(response.headers.get('content-length')??0);
      if(length>options.maxBytes){await response.body?.cancel();return runtimeError('RESPONSE_TOO_LARGE','来源响应超过大小限制');}
      const reader=response.body?.getReader();if(!reader)return runtimeError('HTTP_SOURCE_FAILED','来源响应为空');
      const chunks:Uint8Array[]=[];let total=0;
      try{for(;;){const next=await reader.read();if(next.done)break;total+=next.value.byteLength;if(total>options.maxBytes){await reader.cancel();return runtimeError('RESPONSE_TOO_LARGE','来源响应超过大小限制');}chunks.push(next.value);}}
      finally{reader.releaseLock();}
      const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
      try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as Json;}
      catch{return runtimeError('EVENT_MAPPING_INVALID','来源不是有效 UTF-8 JSON');}
    }
  }catch(error){
    if(options.signal.aborted)return runtimeError('REFRESH_CANCELLED','刷新执行者已停止');
    if(timeout.aborted)return runtimeError('REQUEST_TIMEOUT','来源拉取超过 15 秒');
    if(error instanceof RuntimeError)throw error;
    return runtimeError('HTTP_SOURCE_FAILED','来源连接失败，请稍后重试');
  }
  return runtimeError('HTTP_REDIRECT_FAILED','来源重定向失败');
}
