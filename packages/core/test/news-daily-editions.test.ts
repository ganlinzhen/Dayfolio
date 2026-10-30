import { describe, expect, it, vi } from 'vitest';
import { createCore, type TodoDeskCore } from '../src';
import { mkCore, mkLegacyDb } from './helpers';

function configure(core: TodoDeskCore) {
  const config=core.newsFeed.getConfig();config.modules=config.modules.filter(module=>module.id==='domestic');
  config.learning.exploration_enabled=false;core.newsFeed.updateConfig({config,expected_revision:config.revision});
}
function collect(core: TodoDeskCore, base: number, count: number) {
  let batch=core.newsFeed.startUpdate(), added=0, continued=false;const ids:number[]=[];
  while(batch.status==='active') {
    const claim=core.news.claimTask(batch.next_task_id!),ctx=core.newsFeed.getTaskContext(claim.task.id)!;
    const size=Math.min(count-added,ctx.remaining);
    if(size>0) {
      const news=core.news.submitItems(claim.task.id,claim.claim_token,Array.from({length:size},(_,index)=>({title:`独立新闻${base+added+index}`,summary:`机构公布可核实的结果${base+added+index}，说明变化与影响。`,source_url:`https://example.com/daily/${base+added+index}`,published_at:new Date(Date.parse(ctx.window_end)-60000-index).toISOString()}))).items;
      ids.push(...news.map(item=>item.id));added+=news.length;
    }
    core.news.completeTask(claim.task.id,claim.claim_token,'已保存实际核实结果');batch=core.newsFeed.advance(batch.id)!;
    if(batch.status==='completed' && added<count && !continued) {continued=true;batch=core.newsFeed.continueUpdate({batch_id:batch.id});}
  }
  return {batch,ids};
}

describe('每日模块记录',()=>{
  it('同日多批合并为一条，累计超过十条，重复复用不重复计数且读取不标已读',()=>{
    const {core,cleanup}=mkCore();try {
      configure(core);const first=collect(core,100,6),second=collect(core,200,6);
      const editions=core.newsFeed.listDailyEditions();expect(editions).toHaveLength(1);
      expect(editions[0]).toMatchObject({module_id:'domestic',module_name:'国内',news_count:12,matching_count:12,unread_count:12,summary:null,summary_status:'pending'});
      expect(core.newsFeed.getDailyEdition({id:editions[0].id,limit:5})).toMatchObject({total:12,has_more:true});
      expect(core.newsFeed.getDailyEdition({id:editions[0].id,limit:10,offset:10}).items).toHaveLength(2);
      collect(core,300,0);expect(core.newsFeed.listDailyEditions()[0].news_count).toBe(12);
      expect(core.db.prepare('SELECT COUNT(*) AS n FROM news_feed_members WHERE batch_id=?').get(second.batch.id)?.n).toBe(10);
      expect(core.news.list({since:'1900-01-01',limit:100}).every(item=>!item.is_read)).toBe(true);
      expect(core.db.prepare('SELECT COUNT(*) AS n FROM news_feed_feedback').get()?.n).toBe(0);
      expect(new Set([...first.ids,...second.ids]).size).toBe(12);
    }finally{cleanup();}
  });
  it('批次跨北京时间午夜仍属原日期，下一轮另建当天记录',()=>{
    const {core,cleanup}=mkCore();try {
      configure(core);vi.useFakeTimers();vi.setSystemTime('2026-10-27T15:59:00Z');
      const batch=core.newsFeed.startUpdate(),claim=core.news.claimTask(batch.next_task_id!);
      vi.setSystemTime('2026-10-27T16:01:00Z');
      core.news.submitItems(claim.task.id,claim.claim_token,[{title:'午夜后才提交的前一轮消息',summary:'消息按批次日期归档，真实发布时间保持原值。',source_url:'https://example.com/cross-midnight',published_at:'2026-10-27T15:58:00Z'}]);
      core.newsFeed.stopUpdate(batch.id);const resumed=core.newsFeed.continueUpdate({batch_id:batch.id});
      expect(core.newsFeed.getTaskContext(resumed.next_task_id!)?.daily_edition?.edition.date).toBe('2026-10-27');
      core.newsFeed.stopUpdate(batch.id);collect(core,400,1);
      expect(core.newsFeed.listDailyEditions().map(edition=>edition.date)).toEqual(['2026-10-28','2026-10-27']);
      expect(core.newsFeed.getDailyEdition({id:'2026-10-27:domestic'}).items[0].published_at).toBe('2026-10-27T15:58:00.000Z');
    }finally{vi.useRealTimers();cleanup();}
  });
  it('真实v31升级回填各日并集，不清新闻或伪造AI总结',()=>{
    const legacy=mkLegacyDb(31);try {
      legacy.db.prepare("INSERT INTO news(source,title,url,summary,published_date,published_at,fetched_at,dedup_key,module_id) VALUES('agent','既有事实','https://example.com/upgrade-daily','既有新闻摘要','2026-10-26','2026-10-26T12:00:00Z','2026-10-27','daily-legacy','domestic')").run();
      for(const [id,created] of [['first','2026-10-27T00:00:00Z'],['second','2026-10-27T09:00:00Z']]) {
        const batch={id,created_at:created,finished_at:created,modules:[{module_id:'domestic',name:'国内'}]};
        legacy.db.prepare('INSERT INTO news_feed_batches(id,data_json) VALUES(?,?)').run(id,JSON.stringify(batch));
        legacy.db.prepare("INSERT INTO news_feed_members(batch_id,module_id,news_id) VALUES(?,'domestic',1)").run(id);
      }
      const core=createCore(legacy.db,{dbPath:legacy.dbPath}),editions=core.newsFeed.listDailyEditions();
      expect(editions).toHaveLength(1);expect(editions[0]).toMatchObject({date:'2026-10-27',news_count:1,summary:null,summary_status:'pending'});
      expect(core.newsFeed.getDailyEdition({id:editions[0].id}).items[0].summary).toBe('既有新闻摘要');
      expect(core.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    }finally{legacy.cleanup();}
  });
  it('重点总结校验依据和修订；新进展保留旧总结并明确过期',()=>{
    const {core,cleanup}=mkCore();try {
      configure(core);const first=collect(core,500,2),edition=core.newsFeed.listDailyEditions()[0];
      const input={edition_id:edition.id,summary:'两项重点进展分别反映制度调整与实际执行结果，需要把已公布事实和后续影响区分理解。',news_ids:first.ids,expected_revision:edition.revision};
      expect(()=>core.newsFeed.saveDailyEditionSummary({...input,summary:'  '})).toThrow('非空');
      expect(()=>core.newsFeed.saveDailyEditionSummary({...input,news_ids:[999999]})).toThrow('不属于');
      const saved=core.newsFeed.saveDailyEditionSummary(input);expect(saved.summary_status).toBe('ready');expect(saved.summary_news_ids).toEqual(first.ids);
      expect(()=>core.newsFeed.saveDailyEditionSummary(input)).toThrow('已更新');
      collect(core,600,1);const stale=core.newsFeed.listDailyEditions()[0];
      expect(stale.summary_status).toBe('stale');expect(stale.summary).toBe(input.summary);expect(stale.news_count).toBe(3);
      const batch=core.newsFeed.startUpdate(),ctx=core.newsFeed.getTaskContext(batch.next_task_id!)!;
      expect(ctx.instructions).toContain('submit_news_daily_summary');expect(ctx.instructions).toContain('最重要2~3条新闻');expect(ctx.instructions).toContain('最多100字');expect(ctx.daily_edition?.edition.id).toBe(edition.id);
      expect(ctx.daily_edition?.news.map(item=>item.id)).toEqual(expect.arrayContaining(first.ids));
    }finally{cleanup();}
  });
  it('摘要依据跨日或跨模块不可引用，隐藏、删除与实质更正不泄露失效总结',()=>{
    const {core,cleanup}=mkCore();try {
      configure(core);const first=collect(core,700,2);let edition=core.newsFeed.listDailyEditions()[0];
      core.newsFeed.saveDailyEditionSummary({edition_id:edition.id,summary:'基于两条已核实报道的重点综合。',news_ids:[first.ids[0]],expected_revision:edition.revision});
      core.newsFeed.recordFeedback({news_id:first.ids[0],kind:'hide',source:'explicit',idempotency_key:'daily-hide'});
      expect(core.newsFeed.listDailyEditions()[0]).toMatchObject({summary:null,summary_status:'stale',news_count:2,matching_count:1,hidden_count:1});
      expect(()=>core.newsFeed.saveDailyEditionSummary({edition_id:edition.id,summary:'不能用隐藏的新闻生成总结',news_ids:[first.ids[0]],expected_revision:core.newsFeed.listDailyEditions()[0].revision})).toThrow('隐藏');
      core.newsFeed.recordFeedback({news_id:first.ids[0],kind:'undo_hide',source:'explicit',idempotency_key:'daily-show'});
      core.newsFeed.submitCorrection({news_id:first.ids[0],summary:'来源已更正关键数据',evidence_url:'https://example.com/daily-correction'});
      expect(core.newsFeed.listDailyEditions()[0]).toMatchObject({summary:null,summary_status:'stale'});
      edition=core.newsFeed.listDailyEditions()[0];
      core.newsFeed.saveDailyEditionSummary({edition_id:edition.id,summary:'已依据来源更正重新整理重点。',news_ids:[first.ids[0]],expected_revision:edition.revision});
      expect(core.newsFeed.listDailyEditions()[0].summary_status).toBe('ready');
      core.news.deleteItem(first.ids[0]);expect(core.newsFeed.listDailyEditions()[0]).toMatchObject({summary:null,summary_status:'stale',news_count:1});
      vi.useFakeTimers();vi.setSystemTime(Date.now()+86400_000);const next=collect(core,800,1),another=core.newsFeed.listDailyEditions()[0];
      expect(()=>core.newsFeed.saveDailyEditionSummary({edition_id:edition.id,summary:'不能跨期引用',news_ids:next.ids,expected_revision:core.newsFeed.getDailyEdition({id:edition.id}).edition.revision})).toThrow('不属于');
      expect(another.id).not.toBe(edition.id);
    }finally{vi.useRealTimers();cleanup();}
  });
  it('首页按内部新闻状态和搜索匹配，每日记录与单条状态分开',()=>{
    const {core,cleanup}=mkCore();try {
      configure(core);const {ids}=collect(core,900,3),edition=core.newsFeed.listDailyEditions()[0];
      core.news.markRead(ids[0],true);core.news.markStarred(ids[1],true);
      core.newsFeed.recordFeedback({news_id:ids[2],kind:'hide',source:'explicit',idempotency_key:'filter-hidden'});
      expect(core.newsFeed.listDailyEditions({filter:'unread'})[0]).toMatchObject({matching_count:1,unread_count:1});
      expect(core.newsFeed.listDailyEditions({filter:'starred'})[0].matching_count).toBe(1);
      expect(core.newsFeed.listDailyEditions({filter:'hidden'})[0].matching_count).toBe(1);
      expect(core.newsFeed.getDailyEdition({id:edition.id,filter:'starred'}).items.map(item=>item.id)).toEqual([ids[1]]);
      expect(core.newsFeed.getDailyEdition({id:edition.id,filter:'hidden'}).items[0].hidden).toBe(true);
      expect(core.newsFeed.listDailyEditions({search:'独立新闻901'})[0].matching_count).toBe(1);
      expect(core.newsFeed.listDailyEditions({search:'完全不存在'})).toEqual([]);
      expect(core.news.list({limit:100}).filter(item=>item.is_read).map(item=>item.id)).toEqual([ids[0]]);
    }finally{cleanup();}
  });
  it('有较长旧总结依据时仍向任务公开当前新收录，分页按总结依据再按真实时间排序',()=>{
    const {core,cleanup}=mkCore();try {
      configure(core);const ids=[...collect(core,1000,10).ids,...collect(core,1100,10).ids,...collect(core,1200,10).ids];
      const edition=core.newsFeed.listDailyEditions()[0];core.newsFeed.saveDailyEditionSummary({edition_id:edition.id,summary:'当天多轮消息的重点综合。',news_ids:ids,expected_revision:edition.revision});
      const first=core.newsFeed.getDailyEdition({id:edition.id,limit:5}),second=core.newsFeed.getDailyEdition({id:edition.id,offset:5,limit:5});
      expect(first.items.map(item=>item.id)).toEqual(ids.slice(0,5));expect(second.items.map(item=>item.id)).toEqual(ids.slice(5,10));
      const batch=core.newsFeed.startUpdate(),claim=core.news.claimTask(batch.next_task_id!),ctx=core.newsFeed.getTaskContext(claim.task.id)!;
      const added=core.news.submitItems(claim.task.id,claim.claim_token,[{title:'当天最新实质进展',summary:'刚核实的最新事实不能被旧总结依据挤出。',source_url:'https://example.com/latest-daily',published_at:new Date(Date.parse(ctx.window_end)-1000).toISOString()}]).items[0];
      const refreshed=core.newsFeed.getTaskContext(claim.task.id)!.daily_edition!;
      expect(refreshed.news.length).toBeLessThanOrEqual(30);expect(refreshed.news.some(item=>item.id===added.id)).toBe(true);
      expect(refreshed.edition.news_count).toBe(31);
    }finally{cleanup();}
  });
  it('首页分页只读取当前页正文，搜索百分号和下划线按字面匹配',()=>{
    const {core,cleanup}=mkCore();const prepare=core.db.prepare.bind(core.db);try {
      configure(core);const {ids}=collect(core,1400,1);
      for(let day=1;day<=50;day++) {
        const date=new Date(Date.UTC(2026,0,day)).toISOString().slice(0,10),id=`${date}:domestic`,stamp=`${date}T00:00:00Z`;
        core.db.prepare("INSERT INTO news_daily_editions(id,date,module_id,module_name,created_at,updated_at) VALUES(?,?,'domestic','国内',?,?)").run(id,date,stamp,stamp);
        core.db.prepare('INSERT INTO news_daily_edition_members(edition_id,news_id,added_at) VALUES(?,?,?)').run(id,ids[0],stamp);
      }
      let fullArticleRows=0;
      core.db.prepare=sql=>{const statement=prepare(sql);return {run:(...args)=>statement.run(...args),get:(...args)=>statement.get(...args),all:(...args)=>{const rows=statement.all(...args);fullArticleRows+=rows.filter(row=>'dedup_key' in row&&'summary' in row&&'url' in row).length;return rows;}};};
      expect(core.newsFeed.listDailyEditions({limit:2})).toHaveLength(2);expect(fullArticleRows).toBe(2);
      fullArticleRows=0;expect(core.newsFeed.listDailyEditions({limit:2,offset:50,search:'独立新闻'})).toHaveLength(1);expect(fullArticleRows).toBe(1);
      expect(core.newsFeed.listDailyEditions({search:'%'})).toEqual([]);expect(core.newsFeed.listDailyEditions({search:'_'})).toEqual([]);
      core.db.prepare("UPDATE news SET title='ŠKODA独立事实' WHERE id=?").run(ids[0]);
      expect(core.newsFeed.listDailyEditions({search:'ŠKODA',limit:1})).toHaveLength(1);
    }finally{core.db.prepare=prepare;cleanup();}
  });
});
