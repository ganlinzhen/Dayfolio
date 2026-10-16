// 宿主外第二领域生成器：只使用 Node 内置模块，始终标记合成验证数据。
import {cpSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const [directory,id='validation.performance-'+randomUUID().slice(0,8),title='演出日程（模拟验证）']=process.argv.slice(2);
if(!directory)throw new Error('用法：node generate-sample-tool.mjs <全新目录> [extensionId] [标题]');
const output=resolve(directory);mkdirSync(output,{recursive:false});cpSync(fileURLToPath(new URL('./template',import.meta.url)),output,{recursive:true});
const events=[{externalId:'performance-evening',title:'室内乐音乐会（模拟）',timeKind:'timed',startAt:'2026-11-06T11:30:00Z',endAt:null,startDate:null,endDateExclusive:null,status:'scheduled',sourceUrl:'https://example.org/synthetic-concert',payload:{genre:'室内乐',venue:'模拟场馆',synthetic:true}},{externalId:'performance-festival',title:'周末艺术节（模拟）',timeKind:'all_day',startAt:null,endAt:null,startDate:'2026-11-07',endDateExclusive:'2026-11-09',status:'scheduled',sourceUrl:'https://example.org/synthetic-festival',payload:{genre:'艺术节',synthetic:true}}];
const manifest={schemaVersion:1,id,version:'1.0.0',title,description:'宿主外生成的第二领域验证工具，全部内容为模拟',hostApi:{major:1,minMinor:0},entry:'index.html',help:'help.md',icon:'music',collections:[{localId:'schedule',title:'演出（模拟）',color:'violet',sortOrder:30}],providers:[{localId:'main',collectionLocalId:'schedule',kind:'import',config:{}}],capabilities:['events.read','subscriptions.write','providers.refresh','navigation.openTodo'].map(name=>({name,providerLocalId:'main'})),contributions:{calendarActions:[{localId:'open',title:'演出日程（模拟）',position:'calendar.actions',kind:'open_tool',providerLocalId:'main'},{localId:'refresh',title:'更新演出（模拟）',position:'calendar.actions',kind:'refresh_provider',providerLocalId:'main'}]},seed:{file:'events.json',providerLocalId:'main'},files:{}};
const config={pageId:id+'.page',title,scope:'2 条模拟演出，验证定时与全天事件，不是真实售票信息',providerLocalId:'main',timezone:'Asia/Shanghai',sources:[{title:'本地合成验证',url:'https://example.org/synthetic-concert',coverage:'仅用于扩展底座测试',note:'模拟数据，无真实演出、票务或主办方承诺'}],attribution:'本页所有演出均为合成测试资料。'};
for(const [name,data] of Object.entries({'manifest.json':manifest,'events.json':events,'page.json':config}))writeFileSync(join(output,name),JSON.stringify(data,null,2)+'\n');
let html=readFileSync(join(output,'index.html'),'utf8').replace('赛程与订阅','日程与订阅').replace('参赛者','演出分类');writeFileSync(join(output,'index.html'),html);
let js=readFileSync(join(output,'tool.js'),'utf8').replaceAll('订阅比赛','订阅演出').replaceAll('场','项').replaceAll('比赛','演出').replaceAll('待赛','待开始');writeFileSync(join(output,'tool.js'),js);
writeFileSync(join(output,'help.md'),'# '+title+'\n\n全部为模拟资料。订阅与隐藏分类复用公共底座；取消订阅保留待办，刷新请求等待外部助手。\n');
const result=spawnSync(process.execPath,[fileURLToPath(new URL('./pack.mjs',import.meta.url)),output],{stdio:'inherit'});process.exitCode=result.status??1;
