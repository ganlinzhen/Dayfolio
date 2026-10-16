// 隔离刷新夹具：固定标准合同，来源结构差异只放在 manifest 映射里。
import {dirname,join} from 'node:path';
import type {TodoDeskCore,HttpJsonConfig,ExternalEventInput} from '../src';
import {writePackage} from './extension-fixtures';

export const httpConfig:HttpJsonConfig={url:'https://feed.example.org/schedule',itemsPath:'records',fieldMappings:{externalId:{path:'key'},title:{path:'label'},timeKind:{literal:'timed'},startAt:{path:'when.start'},endAt:{literal:null},startDate:{literal:null},endDateExclusive:{literal:null},status:{path:'state'},sourceUrl:{path:'reference'},'payload.venue':{path:'venue'}},statusMap:{planned:'scheduled',cancelled:'cancelled',postponed:'postponed',finished:'finished'}};
export const providerJson=(event:ExternalEventInput)=>({records:[{key:event.externalId,label:event.title,when:{start:event.startAt},state:event.status==='scheduled'?'planned':event.status,reference:event.sourceUrl,venue:'隔离测试场地'}]});
export function installProvider(core:TodoDeskCore,dbPath:string,id='test.http-provider',kind:'http-json'|'import'='http-json',config=httpConfig){
  const directory=join(dirname(dbPath),id),capabilities=['events.read','providers.refresh','subscriptions.write'] as const;
  writePackage(directory,{id,providers:[{localId:'main',collectionLocalId:'schedule',kind,config:kind==='http-json'?config:{},...(kind==='http-json'?{refreshSeconds:300}:{})}],capabilities:capabilities.map(name=>({name,providerLocalId:'main'}))});
  const preview=core.extensions.previewInstall({stagingDirectory:directory}),input={stagingDirectory:directory,expectedExtensionRevision:preview.currentRevision,expectedPackageDigest:preview.digest};
  core.extensions.install({...input,authorizationRef:core.commands.human.authorizeExtensionInstall(input).authorizationRef});
  return {extensionId:id,providerId:`ext:${id}/main`};
}
