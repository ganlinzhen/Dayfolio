import { afterEach, describe, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import { mkCore, type TestCtx } from './helpers';
import { openNodeSqliteDb } from '../src/adapters/node-sqlite';
import { createCore } from '../src/index';
let ctx: TestCtx;
afterEach(()=>ctx?.cleanup());
function setup(cardinality:'one_to_one'|'one_to_many'='one_to_many',onDelete:'restrict'|'set_null'='restrict') {
  ctx=mkCore();const c=ctx.core;
  c.ontology.createObjectType({apiName:'folder',title:'文件夹',properties:[{apiName:'title',dataType:'string'}]});
  c.ontology.createObjectType({apiName:'note',title:'笔记',properties:[{apiName:'title',dataType:'string'},{apiName:'folder_id',dataType:'string'}]});
  c.ontology.createLinkType({apiName:'folder__note',title:'文件夹笔记',leftType:'folder',rightType:'note',cardinality,fkColumn:'folder_id',onDelete});
  return {c,folder:c.objects.insert('folder',{title:'目录'}),note:c.objects.insert('note',{title:'第一条'})};
}
describe('关系真实约束',()=>{
  it('不存在目标拒绝、精确解除、禁止直接换绑、删除策略生效',()=>{
    const {c,folder,note}=setup();
    expect(()=>c.objects.insert('note',{title:'错误',folder_id:'missing'})).toThrow(/REFERENCE_NOT_FOUND/);
    expect(c.relations.create('folder__note',folder.id,note.id).created).toBe(true);
    expect(c.relations.create('folder__note',folder.id,note.id).created).toBe(false);
    expect(()=>c.objects.update('note',note.id,{folder_id:null})).toThrow(/LINK_REQUIRES_OPERATION/);
    const other=c.objects.insert('folder',{title:'其他'});
    expect(()=>c.relations.remove('folder__note',other.id,note.id)).toThrow(/LINK_TARGET_CHANGED/);
    expect(()=>c.objects.remove('folder',folder.id)).toThrow(/LINK_RESTRICTED/);
    expect(c.relations.remove('folder__note',folder.id,note.id).deleted).toBe(true);
    expect(c.relations.remove('folder__note',folder.id,note.id).deleted).toBe(false);
    c.objects.remove('folder',folder.id);
  });
  it('set_null 与双连接数据库触发器约束重启后仍有效',()=>{
    const {c,folder,note}=setup('one_to_many','set_null');c.relations.create('folder__note',folder.id,note.id);
    const db=openNodeSqliteDb(ctx.dbPath);
    try {
      expect(()=>db.prepare('UPDATE ont_obj_note SET folder_id=? WHERE id=?').run('missing',note.id)).toThrow(/REFERENCE_NOT_FOUND/);
      const other=createCore(db,{dbPath:ctx.dbPath});other.objects.remove('folder',folder.id);
      expect(c.objects.get('note',note.id)?.folder_id).toBeNull();
    }finally{db.close();}
  });
  it('一对一并发竞争由数据库唯一性兜底',async()=>{
    const {folder}=setup('one_to_one');
    const worker=()=>new Promise<string>((resolve,reject)=>{
      const w=new Worker(`const {parentPort,workerData}=require('node:worker_threads');const {DatabaseSync}=require('node:sqlite');const {randomUUID}=require('node:crypto');const d=new DatabaseSync(workerData.path);d.exec('PRAGMA busy_timeout=5000');try{d.exec('BEGIN IMMEDIATE');d.prepare('INSERT INTO ont_obj_note(id,title,folder_id,created_at,updated_at) VALUES(?,?,?,?,?)').run(randomUUID(),'并发',workerData.target,'2026-10-13','2026-10-13');d.exec('COMMIT');parentPort.postMessage('ok');}catch(e){try{d.exec('ROLLBACK')}catch{}parentPort.postMessage(e.message);}finally{d.close();}`,{eval:true,workerData:{path:ctx.dbPath,target:folder.id}});
      w.on('message',resolve);w.on('error',reject);
    });
    const results=await Promise.all([worker(),worker()]);
    expect(results.filter(r=>r==='ok')).toHaveLength(1);
    expect(results.some(r=>/UNIQUE/.test(r))).toBe(true);
  });
  it('N:N 两端分页完整且删除仅清关联',()=>{
    ctx=mkCore();const c=ctx.core;
    for(const name of ['reader','book'])c.ontology.createObjectType({apiName:name,title:name,properties:[{apiName:'title',dataType:'string'}]});
    c.ontology.createObjectType({apiName:'reading',title:'阅读关联',properties:[{apiName:'reader_id',dataType:'string'},{apiName:'book_id',dataType:'string'}]});
    c.ontology.createLinkType({apiName:'reader__book',title:'阅读书籍',leftType:'reader',rightType:'book',cardinality:'many_to_many',linkTable:'reading',backingLeftProperty:'reader_id',backingRightProperty:'book_id'});
    const reader=c.objects.insert('reader',{title:'读者'});let last:unknown;
    for(let i=0;i<55;i++){const book=c.objects.insert('book',{title:`第${i}本`});last=book.id;c.relations.create('reader__book',reader.id,book.id);}
    const first=c.relations.list('reader',reader.id,'reader__book','left');expect(first.total).toBe(55);expect(first.hasMore).toBe(true);
    expect(c.relations.list('reader',reader.id,'reader__book','left',50,50).items).toHaveLength(5);
    expect(c.relations.list('book',last,'reader__book','right').items[0].targetTitle).toBe('读者');
    c.objects.remove('reader',reader.id);expect(c.objects.count('reading')).toBe(0);expect(c.objects.count('book')).toBe(55);
  });
  it('系统复合主键关系使用业务服务，两端可遍历',()=>{
    ctx=mkCore();const c=ctx.core;const content=c.media.addContent({title:'母稿'});const material=c.media.addMaterial({title:'资料'});
    c.relations.create('media_content__media_material',content.id,material.id);
    expect(c.relations.list('media_material',material.id,'media_content__media_material','right').items[0].targetId).toBe(content.id);
    expect(c.relations.create('media_content__media_material',content.id,material.id).created).toBe(false);
    c.relations.remove('media_content__media_material',content.id,material.id);
    expect(c.media.getContent(content.id).materials).toHaveLength(0);
  });
  it('旧脏关系升级保留数据并暂停相关写入',()=>{
    const {c,note}=setup();c.ontology.deleteLinkType('folder__note');
    c.db.prepare('UPDATE ont_obj_note SET folder_id=? WHERE id=?').run('不存在',note.id);
    c.db.prepare("INSERT INTO ont_link_types(api_name,title,left_type,right_type,cardinality,fk_column,is_system,created_at) VALUES('old_link','旧关系','folder','note','one_to_many','folder_id',0,'2026-10-13')").run();
    const otherDb=openNodeSqliteDb(ctx.dbPath);
    try {const other=createCore(otherDb,{dbPath:ctx.dbPath});expect(other.relations.health()).toHaveLength(1);expect(other.objects.get('note',note.id)?.folder_id).toBe('不存在');expect(()=>other.objects.update('note',note.id,{title:'禁止'})).toThrow(/RELATION_NEEDS_REPAIR/);}finally{otherDb.close();}
  });
});
