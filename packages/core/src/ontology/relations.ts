// 关系承载适配：现有外键优先，动态关系用限定索引和触发器约束。
import { inTx, type DbAdapter } from '../db';
import { quoteIdent as q } from './ddl';
import { OntologyError } from './policy';
import type { LinkTypeDef, ObjectTypeDef } from './types';
import type { OntologyService } from './registry';
import type { ObjectRepo } from './repo';

function binding(link: LinkTypeDef, objects: ObjectTypeDef[]) {
  const left=objects.find(t=>t.apiName===link.leftType)!; const right=objects.find(t=>t.apiName===link.rightType)!;
  const backing=objects.find(t=>t.apiName===link.linkTable);
  return {left,right,table:link.backingTableName ?? backing?.tableName ?? right.tableName!,leftColumn:link.backingLeftProperty ?? link.fkColumn!,rightColumn:link.backingRightProperty,backing};
}
export function dropRelationConstraints(db: DbAdapter, name: string) {
  for (const suffix of ['insert','update','left_delete','right_delete','left_key','right_key']) db.exec(`DROP TRIGGER IF EXISTS ${q(`ont_${name}_${suffix}`)}`);
  db.exec(`DROP INDEX IF EXISTS ${q(`ont_${name}_unique`)}`);
}
export function syncRelationConstraints(db: DbAdapter, objects: ObjectTypeDef[], links: LinkTypeDef[], rejectDirty?: string) {
  const diagnostics: Array<{linkType:string;issues:number}> = [];
  inTx(db,()=>{
    for (const link of links.filter(l=>!l.isSystem)) {
      const b=binding(link,objects); const many=link.cardinality==='many_to_many';
      const table=q(b.table),col=q(b.leftColumn),target=q(b.left.tableName!),pk=q(b.left.primaryKey);
      const missing=`SELECT COUNT(*) AS n FROM ${table} s WHERE ${many ? `s.${col} IS NULL OR `:''}(s.${col} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${target} t WHERE t.${pk}=s.${col}))`;
      let issues=Number(db.prepare(missing).get()?.n??0);
      if(many) issues+=Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} s WHERE s.${q(b.rightColumn!)} IS NULL OR NOT EXISTS (SELECT 1 FROM ${q(b.right.tableName!)} t WHERE t.${q(b.right.primaryKey)}=s.${q(b.rightColumn!)})`).get()?.n??0);
      if(many||link.cardinality==='one_to_one') issues+=db.prepare(`SELECT ${col} FROM ${table} WHERE ${col} IS NOT NULL GROUP BY ${col}${many?`,${q(b.rightColumn!)}`:''} HAVING COUNT(*)>1`).all().length;
      if(issues&&rejectDirty===link.apiName) throw new OntologyError('RELATION_NEEDS_REPAIR',`关系 ${link.title} 有 ${issues} 项存量冲突`);
      dropRelationConstraints(db,link.apiName);
      const trigger=(suffix:string,when:string,body:string)=>db.exec(`CREATE TRIGGER ${q(`ont_${link.apiName}_${suffix}`)} ${when} BEGIN ${body} END`);
      const config={constraintState:issues?'needs_repair':'enforced',referenceKind:'strong'};
      db.prepare('UPDATE ont_link_types SET config=? WHERE api_name=?').run(JSON.stringify(config),link.apiName);
      if(issues) {
        diagnostics.push({linkType:link.apiName,issues});
        for(const event of ['INSERT','UPDATE']) trigger(event.toLowerCase(),`BEFORE ${event} ON ${table}`,"SELECT RAISE(ABORT,'RELATION_NEEDS_REPAIR：关联存在历史冲突，暂不可写');");
        trigger('left_delete',`BEFORE DELETE ON ${target} WHEN EXISTS (SELECT 1 FROM ${table} WHERE ${col}=OLD.${pk})`,"SELECT RAISE(ABORT,'RELATION_NEEDS_REPAIR：删除涉及待修复关系');");
        if(many) trigger('right_delete',`BEFORE DELETE ON ${q(b.right.tableName!)} WHEN EXISTS (SELECT 1 FROM ${table} WHERE ${q(b.rightColumn!)}=OLD.${q(b.right.primaryKey)})`,"SELECT RAISE(ABORT,'RELATION_NEEDS_REPAIR：删除涉及待修复关系');");
        continue;
      }
      if(many||link.cardinality==='one_to_one') db.exec(`CREATE UNIQUE INDEX ${q(`ont_${link.apiName}_unique`)} ON ${table}(${col}${many?`,${q(b.rightColumn!)}`:''})`);
      const checks=`SELECT CASE WHEN ${many?`NEW.${col} IS NULL OR `:''}(NEW.${col} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${target} WHERE ${pk}=NEW.${col})) THEN RAISE(ABORT,'REFERENCE_NOT_FOUND：关联目标不存在') END;`+
        (many?`SELECT CASE WHEN NEW.${q(b.rightColumn!)} IS NULL OR NOT EXISTS (SELECT 1 FROM ${q(b.right.tableName!)} WHERE ${q(b.right.primaryKey)}=NEW.${q(b.rightColumn!)}) THEN RAISE(ABORT,'REFERENCE_NOT_FOUND：关联目标不存在') END;`:'');
      trigger('insert',`BEFORE INSERT ON ${table}`,checks);
      trigger('update',`BEFORE UPDATE OF ${col}${many?`,${q(b.rightColumn!)}`:''} ON ${table}`,checks);
      const deleteBody= many ? `DELETE FROM ${table} WHERE ${col}=OLD.${pk};` : link.onDelete==='set_null'?`UPDATE ${table} SET ${col}=NULL WHERE ${col}=OLD.${pk};`:"SELECT RAISE(ABORT,'LINK_RESTRICTED：对象仍被关联');";
      trigger('left_delete',`${many||link.onDelete==='set_null'?'AFTER':'BEFORE'} DELETE ON ${target} WHEN EXISTS (SELECT 1 FROM ${table} WHERE ${col}=OLD.${pk})`,deleteBody);
      trigger('left_key',`BEFORE UPDATE OF ${pk} ON ${target} WHEN NEW.${pk}<>OLD.${pk} AND EXISTS (SELECT 1 FROM ${table} WHERE ${col}=OLD.${pk})`,"SELECT RAISE(ABORT,'LINK_RESTRICTED：关联主键不可更改');");
      if(many) {
        trigger('right_delete',`AFTER DELETE ON ${q(b.right.tableName!)} `,`DELETE FROM ${table} WHERE ${q(b.rightColumn!)}=OLD.${q(b.right.primaryKey)};`);
        trigger('right_key',`BEFORE UPDATE OF ${q(b.right.primaryKey)} ON ${q(b.right.tableName!)} WHEN NEW.${q(b.right.primaryKey)}<>OLD.${q(b.right.primaryKey)} AND EXISTS (SELECT 1 FROM ${table} WHERE ${q(b.rightColumn!)}=OLD.${q(b.right.primaryKey)})`,"SELECT RAISE(ABORT,'LINK_RESTRICTED：关联主键不可更改');");
      }
    }
  });
  return diagnostics;
}

export function assertRelationPatch(ontology: OntologyService, apiName:string, patch:Record<string,unknown>) {
  for(const l of ontology.listLinkTypes()) {
    const cols=l.rightType===apiName&&l.fkColumn?[l.fkColumn]:l.linkTable===apiName?[l.backingLeftProperty!,l.backingRightProperty!]:[];
    if(cols.some(c=>Object.hasOwn(patch,c))) throw new OntologyError('LINK_REQUIRES_OPERATION','关联字段请通过建立或解除关系操作');
  }
}

export function createRelationService(db:DbAdapter,ontology:OntologyService,repo:ObjectRepo,managed?:{attach:(left:number,right:number)=>unknown;detach:(left:number,right:number)=>unknown}) {
  const def=(name:string)=>{const l=ontology.listLinkTypes().find(l=>l.apiName===name);if(!l)throw new Error(`关系 ${name} 不存在`);return l;};
  const exists=(type:ObjectTypeDef,id:unknown)=>{
    const p=type.properties.find(p=>p.apiName===type.primaryKey)!;
    if(p.dataType==='integer'&&!Number.isSafeInteger(id))throw new Error('整数主键类型不匹配');
    if(p.dataType==='string'&&typeof id!=='string')throw new Error('字符串主键类型不匹配');
    if(!repo.get(type.apiName,id))throw new OntologyError('REFERENCE_NOT_FOUND',`${type.apiName}#${id} 不存在`);
  };
  const change=(name:string,leftId:unknown,rightId:unknown,create:boolean,properties:Record<string,unknown>={})=>inTx(db,()=>{
    const l=def(name);const b=binding(l,ontology.listObjectTypes());
    if(l.constraintState==='needs_repair')throw new OntologyError('RELATION_NEEDS_REPAIR','请先修复关系');
    exists(b.left,leftId);exists(b.right,rightId);
    if(l.isSystem) {
      if(name!=='media_content__media_material'||!managed)throw new OntologyError('WRITE_REQUIRES_ACTION','系统关系请通过对应业务动作维护');
      const current=db.prepare('SELECT 1 FROM media_content_materials WHERE content_id=? AND material_id=?').get(leftId,rightId);
      if(create&&!current)managed.attach(Number(leftId),Number(rightId));
      if(!create&&current)managed.detach(Number(leftId),Number(rightId));
      return {created:create&&!current,deleted:!create&&!!current,changes:((create&&!current)||(!create&&!!current))?1:0};
    }
    if(l.cardinality==='many_to_many') {
      const current=db.prepare(`SELECT * FROM ${q(b.table)} WHERE ${q(b.leftColumn)}=? AND ${q(b.rightColumn!)}=?`).get(leftId,rightId);
      if(create&&!current) {const row=repo.insert(l.linkTable!,{...properties,[b.leftColumn]:leftId,[b.rightColumn!]:rightId});return {created:true,changes:1,objectId:row[b.backing!.primaryKey]};}
      if(!create&&current)db.prepare(`DELETE FROM ${q(b.table)} WHERE ${q(b.leftColumn)}=? AND ${q(b.rightColumn!)}=?`).run(leftId,rightId);
      return {created:false,deleted:!create&&!!current,changes:!create&&current?1:0,objectId:current?.[b.backing!.primaryKey]};
    }
    const row=db.prepare(`SELECT ${q(b.leftColumn)} AS target FROM ${q(b.table)} WHERE ${q(b.right.primaryKey)}=?`).get(rightId)!;
    if(row.target!=null&&row.target!==leftId)throw new OntologyError('LINK_TARGET_CHANGED','对象已关联其他目标，请先显式解除');
    if(create&&row.target===leftId)return {created:false,changes:0};
    if(!create&&row.target==null)return {deleted:false,changes:0};
    if(!create&&!b.right.properties.find(p=>p.apiName===b.leftColumn)?.nullable)throw new OntologyError('LINK_RESTRICTED','必填关联不可单独解除');
    db.prepare(`UPDATE ${q(b.table)} SET ${q(b.leftColumn)}=? WHERE ${q(b.right.primaryKey)}=?`).run(create?leftId:null,rightId);
    return {created:create,deleted:!create,changes:1};
  });
  const list=(type:string,id:unknown,name:string,side:'left'|'right',limit=50,offset=0)=>{
    const l=def(name);if((side==='left'?l.leftType:l.rightType)!==type)throw new Error('关系方向与对象类型不匹配');
    const b=binding(l,ontology.listObjectTypes());const target=side==='left'?b.right:b.left;
    if(!repo.get(type,id))throw new OntologyError('REFERENCE_NOT_FOUND','当前对象不存在');
    let sql:string;let params:unknown[]=[id];
    if(l.cardinality==='many_to_many')sql=`SELECT ${q(side==='left'?b.rightColumn!:b.leftColumn)} AS target_id FROM ${q(b.table)} WHERE ${q(side==='left'?b.leftColumn:b.rightColumn!)}=?`;
    else if(side==='left') {sql=`SELECT ${q(b.right.primaryKey)} AS target_id FROM ${q(b.right.tableName!)} WHERE ${q(l.fkColumn??l.refColumn!)}=?`;if(l.discriminatorColumn){sql+=` AND ${q(l.discriminatorColumn)}=?`;params.push(l.discriminatorValue);}}
    else {sql=`SELECT ${q(l.fkColumn??l.refColumn!)} AS target_id FROM ${q(b.right.tableName!)} WHERE ${q(b.right.primaryKey)}=? AND ${q(l.fkColumn??l.refColumn!)} IS NOT NULL`;if(l.discriminatorColumn){sql+=` AND ${q(l.discriminatorColumn)}=?`;params.push(l.discriminatorValue);}}
    const size=Math.max(1,Math.min(200,Math.trunc(limit)));const start=Math.max(0,Math.trunc(offset));
    const total=Number(db.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).get(...params)?.n??0);
    const items=db.prepare(`${sql} ORDER BY target_id LIMIT ? OFFSET ?`).all(...params,size,start).map(r=>{
      let row:Record<string,unknown>|null=null;try{row=repo.get(target.apiName,r.target_id);}catch{/* 虚拟日期没有物理表 */}
      return {linkApiName:name,direction:side==='left'?'in' as const:'out' as const,targetType:target.apiName,targetId:r.target_id,targetTitle:row?String(row[target.titleProperty]??r.target_id):null,targetExists:!!row};
    });
    return {items,total,limit:size,offset:start,hasMore:start+items.length<total};
  };
  const groups=(type:string,id:unknown)=>ontology.listLinkTypes().flatMap(l=>(['left','right'] as const).flatMap(side=>{
    if((side==='left'?l.leftType:l.rightType)!==type || l.leftType==='day')return [];
    const target=ontology.getObjectType(side==='left'?l.rightType:l.leftType);
    return [{apiName:l.apiName,title:side==='left'?(l.leftLinkName??l.title):(l.rightLinkName??l.title),side,
      targetType:target.apiName,targetKeyType:target.properties.find(p=>p.apiName===target.primaryKey)?.dataType,
      writable:l.constraintState!=='needs_repair'&&(!l.isSystem||l.apiName==='media_content__media_material'),
      constraintState:l.constraintState,...list(type,id,l.apiName,side)}];
  }));
  return {create:(name:string,left:unknown,right:unknown,properties?:Record<string,unknown>)=>change(name,left,right,true,properties),remove:(name:string,left:unknown,right:unknown)=>change(name,left,right,false),list,groups,
    health:()=>ontology.listLinkTypes().filter(l=>l.constraintState==='needs_repair').map(l=>({linkType:l.apiName,state:l.constraintState}))};
}
export type RelationService = ReturnType<typeof createRelationService>;
