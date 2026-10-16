import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sha256} from '../src/services/extension-package';
import {eventFixture} from './runtime-fixtures';
import type {ExtensionManifest} from '../src/extension-types';
export function writePackage(directory:string,patch:Partial<ExtensionManifest>={}) {
 mkdirSync(directory,{recursive:true});
 const files:Record<string,string>={'index.html':'<!doctype html><meta charset="utf-8"><script src="/__dayfolio_sdk__/v1.js"></script><script src="tool.js"></script><h1>隔离工具</h1>','tool.js':'window.fixture=true;','help.md':'# 隔离工具\n隐藏保留待办；取消订阅默认保留。','events.json':JSON.stringify([eventFixture()])};
 const manifest:ExtensionManifest={schemaVersion:1,id:'test.package',version:'1.0.0',title:'隔离工具',description:'合成测试工具，不是真实赛程',hostApi:{major:1,minMinor:0},entry:'index.html',help:'help.md',collections:[{localId:'schedule',title:'隔离分类',color:'violet',sortOrder:0}],providers:[{localId:'main',collectionLocalId:'schedule',kind:'import',config:{}}],capabilities:[{name:'events.read',providerLocalId:'main'},{name:'subscriptions.write',providerLocalId:'main'}],seed:{file:'events.json',providerLocalId:'main'},files:Object.fromEntries(Object.entries(files).map(([name,content])=>[name,sha256(content)])),...patch};
 for(const[name,text]of Object.entries(files))writeFileSync(join(directory,name),text);
 writeFileSync(join(directory,'manifest.json'),JSON.stringify(manifest));return manifest;
}
