import {describe,it,expect} from 'vitest';
import {isPublicAddress,assertPublicHost,publicLookup} from '../src/services/provider-https';
import {mapProviderJson,readHttpsJson} from '../src/services/provider-network';
import {validateHttpConfig} from '../src/services/extension-package';
import {eventFixture} from './runtime-fixtures';
import {httpConfig,providerJson} from './provider-fixtures';
import type {HttpJsonConfig} from '../src';
const options=()=>({signal:new AbortController().signal,timeoutMs:1000,maxBytes:1024});

describe('通用 HTTPS JSON 适配器',()=>{
 it('阻止本地、内网、IPv4 映射和特殊地址；DNS 全集检查后固定公共地址',async()=>{
  for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','100.64.0.1','172.16.0.1','192.168.1.1','192.0.2.1','198.19.0.1','224.0.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2002:7f00:1::1','2001:db8::1','3fff::1'])expect(isPublicAddress(address),address).toBe(false);
  for(const address of ['1.1.1.1','8.8.8.8','2606:4700:4700::1111','2001:4860:4860::8888'])expect(isPublicAddress(address),address).toBe(true);
  for(const host of ['localhost','metadata.internal','router.local','[::1]','2130706433'])expect(()=>assertPublicHost(host)).toThrow('PERMISSION_DENIED');
  expect(()=>validateHttpConfig({...httpConfig,url:'https://127.1/schedule'})).toThrow('PERMISSION_DENIED');
  let resolutions=0;
  const mixed=publicLookup(async()=>[{address:'1.1.1.1',family:4},{address:'127.0.0.1',family:4}]);
  await expect(new Promise((resolve,reject)=>mixed('feed.example.org',{all:true},(error,address)=>error?reject(error):resolve(address)))).rejects.toThrow('PERMISSION_DENIED');
  const pinned=publicLookup(async()=>{resolutions++;return [{address:'1.1.1.1',family:4},{address:'2606:4700:4700::1111',family:6}];});
  expect(await new Promise((resolve,reject)=>pinned('feed.example.org',{all:true},(error,address)=>error?reject(error):resolve(address)))).toEqual([{address:'1.1.1.1',family:4}]);expect(resolutions).toBe(1);
 });
 it('日期查询受限：拒绝无界、超长、倒序、重复和无效日期',()=>{
  for(const query of ['fromDate=2026-10-01&toDateExclusive=2026-10-31','dates=20261020','dates=20261020-20261021','season=2026&round=3'])expect(()=>validateHttpConfig({...httpConfig,url:httpConfig.url+'?'+query})).not.toThrow();
  for(const query of ['from=2026-10-01','from=2026-10-02&to=2026-10-01','from=2026-01-01&to=2026-12-01','dates=20260230','dates=20261020&dates=20261021','dates=20260101-20261231'])expect(()=>validateHttpConfig({...httpConfig,url:httpConfig.url+'?'+query})).toThrow('PACKAGE_INVALID');
 });
 it('两种不同结构与时间类型只靠声明映射，未知结束保持 null',()=>{
  const first=mapProviderJson(providerJson(eventFixture()),httpConfig)[0];expect(first).toMatchObject({externalId:'match-1',timeKind:'timed',endAt:null,payload:{venue:'隔离测试场地'}});
  const second:HttpJsonConfig={url:'https://example.org/events',itemsPath:'data.performances',fieldMappings:{externalId:{path:'eventKey'},title:{path:'name'},timeKind:{literal:'all_day'},startAt:{literal:null},endAt:{literal:null},startDate:{path:'firstDay'},endDateExclusive:{path:'afterLastDay'},status:{literal:'scheduled'},sourceUrl:{path:'reference'},'payload.ticket':{path:'booking'},'payload.genre':{literal:'演出'}}};
  expect(mapProviderJson({data:{performances:[{eventKey:'performance-1',name:'合成演出',firstDay:'2026-11-01',afterLastDay:'2026-11-03',reference:'https://example.org/show',booking:'https://example.org/tickets'}]}},second)[0]).toMatchObject({externalId:'performance-1',timeKind:'all_day',endDateExclusive:'2026-11-03',payload:{genre:'演出',ticket:'https://example.org/tickets'}});
 });
 it('拒绝原型路径、目标覆盖、缺失字段、未知状态和超量，绝不静默截断',()=>{
  expect(()=>validateHttpConfig({...httpConfig,itemsPath:'records.constructor'})).toThrow('PACKAGE_INVALID');
  expect(()=>validateHttpConfig({...httpConfig,fieldMappings:{...httpConfig.fieldMappings,payload:{path:'detail'}}})).toThrow('PACKAGE_INVALID');
  expect(()=>mapProviderJson({records:[{key:'missing'}]},httpConfig)).toThrow('EVENT_MAPPING_INVALID');
  const raw=providerJson(eventFixture());raw.records[0].state='unknown';expect(()=>mapProviderJson(raw,httpConfig)).toThrow('EVENT_MAPPING_INVALID');
  expect(()=>mapProviderJson({records:Array.from({length:501},()=>providerJson(eventFixture()).records[0])},httpConfig)).toThrow('EVENT_MAPPING_INVALID');
 });
 it('每一跳检查来源范围，绝不向未授权重定向发送第二次请求',async()=>{
  const calls:string[]=[];const transport:typeof fetch=async(url,init)=>{calls.push(String(url));expect(init?.credentials).toBe('omit');expect(init?.redirect).toBe('manual');return new Response(null,{status:302,headers:{location:'https://elsewhere.example/data'}});};
  await expect(readHttpsJson(httpConfig.url,options(),transport)).rejects.toThrow('PERMISSION_DENIED');expect(calls).toHaveLength(1);
  const allowed:typeof fetch=async(url)=>String(url).endsWith('/page')?new Response('{"items":[]}',{headers:{'content-type':'application/json'}}):new Response(null,{status:307,headers:{location:'/schedule/page'}});
  expect(await readHttpsJson(httpConfig.url,options(),allowed)).toEqual({items:[]});
 });
 it('流式限额、无效 UTF-8、HTML 错误页和凭据 URL 都拒绝',async()=>{
  const large:typeof fetch=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(600));controller.enqueue(new Uint8Array(600));controller.close();}}));
  await expect(readHttpsJson(httpConfig.url,options(),large)).rejects.toThrow('RESPONSE_TOO_LARGE');
  await expect(readHttpsJson(httpConfig.url,options(),async()=>new Response(new Uint8Array([255])))).rejects.toThrow('EVENT_MAPPING_INVALID');
  await expect(readHttpsJson(httpConfig.url,options(),async()=>new Response('<html>拒绝</html>',{headers:{'content-type':'text/html'}}))).rejects.toThrow('HTTP_SOURCE_FAILED');
  await expect(readHttpsJson('https://user:secret@example.org/data',options(),async()=>new Response('{}'))).rejects.toThrow('PACKAGE_INVALID');
 });
 it('超时与执行者停止使用不同错误，响应不进入任何数据库事务',async()=>{
  const waitForAbort:typeof fetch=async(_url,init)=>new Promise((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new DOMException('终止','AbortError')),{once:true}));
  await expect(readHttpsJson(httpConfig.url,{...options(),timeoutMs:5},waitForAbort)).rejects.toThrow('REQUEST_TIMEOUT');
  const controller=new AbortController(),pending=readHttpsJson(httpConfig.url,{...options(),signal:controller.signal},waitForAbort);controller.abort();await expect(pending).rejects.toThrow('REFRESH_CANCELLED');
 });
});
