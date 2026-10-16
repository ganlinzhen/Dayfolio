import { describe,it,expect } from 'vitest';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkManifest,readExtensionPackage,sha256 } from '../src/services/extension-package';
import { canonical } from '../src/services/event-model';
import { eventFixture } from './runtime-fixtures';
import type { ExtensionManifest } from '../src/extension-types';
import {writePackage} from './extension-fixtures';
describe('运行时包真实文件校验',()=>{
 it('冻结清单可校验，摘要不包含自身循环，内存快照与原目录独立',()=>{
  const dir=mkdtempSync(join(tmpdir(),'extension-package-'));try{const m=writePackage(dir);const pack=readExtensionPackage(dir);expect(pack.digest).toBe(sha256('DAYFOLIO-PACKAGE-V1\n'+canonical(m)));expect(pack.seed).toHaveLength(1);writeFileSync(join(dir,'tool.js'),'被修改');expect(pack.files.get('tool.js')!.toString()).toBe('window.fixture=true;');expect(()=>readExtensionPackage(dir)).toThrow('ASSET_INTEGRITY_FAILED');}finally{rmSync(dir,{recursive:true,force:true});}
 });
 it('漏文件、额外文件、符号链接和保留/穿越路径拒绝',()=>{
  for(const mode of ['missing','extra','link','reserved','escape']){const dir=mkdtempSync(join(tmpdir(),'extension-invalid-'));try{const m=writePackage(dir);if(mode==='missing')rmSync(join(dir,'help.md'));if(mode==='extra')writeFileSync(join(dir,'extra.js'),'extra');if(mode==='link'){rmSync(join(dir,'tool.js'));symlinkSync(join(dir,'help.md'),join(dir,'tool.js'));}if(mode==='reserved'){m.files['__dayfolio_sdk__/v1.js']=sha256('bad');writeFileSync(join(dir,'manifest.json'),JSON.stringify(m));}if(mode==='escape'){m.entry='../index.html';writeFileSync(join(dir,'manifest.json'),JSON.stringify(m));}expect(()=>readExtensionPackage(dir)).toThrow();}finally{rmSync(dir,{recursive:true,force:true});}}
 });
 it('兼容主版本、引用范围和未知配置在激活之前拒绝',()=>{
  const dir=mkdtempSync(join(tmpdir(),'extension-schema-'));try{const m=writePackage(dir);expect(()=>checkManifest({...m,hostApi:{major:2,minMinor:0}})).toThrow('HOST_API_UNSUPPORTED');expect(()=>checkManifest({...m,execute:'rm -rf'})).toThrow('PACKAGE_INVALID');expect(()=>checkManifest({...m,capabilities:[{name:'events.read',providerLocalId:'other'}]})).toThrow('PACKAGE_INVALID');expect(()=>checkManifest({...m,providers:[{...m.providers[0],config:{secret:'bad'}}]})).toThrow('PACKAGE_INVALID');}finally{rmSync(dir,{recursive:true,force:true});}
 });
 it('HTTP 映射仅接受固定字段、安全路径和无凭据 HTTPS 配置',()=>{
  const dir=mkdtempSync(join(tmpdir(),'extension-http-'));try{const m=writePackage(dir);const fields={externalId:{path:'id'},title:{path:'title'},timeKind:{literal:'timed'},startAt:{path:'start'},endAt:{literal:null},startDate:{literal:null},endDateExclusive:{literal:null},status:{literal:'scheduled'},sourceUrl:{path:'url'}};
   const provider={...m.providers[0],kind:'http-json',config:{url:'https://example.org/events',itemsPath:'data.items',fieldMappings:fields}};
   expect(()=>checkManifest({...m,providers:[provider]})).not.toThrow();
   for(const patch of [{url:'https://user:secret@example.invalid/events'},{url:'https://example.org/events?api_key=bad'},{itemsPath:'data.__proto__.items'},{fieldMappings:{...fields,sql:{literal:'DROP TABLE todos'}}},{fieldMappings:{...fields,title:{path:'constructor.name'}}}])expect(()=>checkManifest({...m,providers:[{...provider,config:{...provider.config,...patch}}]})).toThrow('PACKAGE_INVALID');
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
});
