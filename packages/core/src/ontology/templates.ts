// 基础动作是持久化的类型配置；更新合同不覆盖用户名称与停用状态。
import { createHash } from 'node:crypto';
import type { DbAdapter } from '../db';
import { nowIso } from '../utils/date';
import type { ActionParamDef, ActionTemplateDef, LinkTypeDef, ObjectTypeDef, PropertyDef } from './types';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function propertySchema(p: PropertyDef): Record<string, unknown> {
  const schema: Record<string, unknown> = p.dataType === 'json' ? {} : { type: p.dataType === 'integer' ? 'number' : p.dataType === 'float' ? 'number' : p.dataType === 'boolean' ? 'boolean' : 'string' };
  if (p.enumValues) schema.enum = p.enumValues;
  return p.nullable ? { anyOf: [{ type: 'null' }, schema] } : schema;
}

function valuesSchema(properties: PropertyDef[], create: boolean): Record<string, unknown> {
  return { type: 'object', additionalProperties: false,
    properties: Object.fromEntries(properties.map(p => [p.apiName, propertySchema(p)])),
    required: create ? properties.filter(p => !p.nullable && !p.isPrimaryKey && !['id', 'created_at', 'updated_at'].includes(p.apiName)).map(p => p.apiName) : [],
  };
}

export function syncActionTemplates(db: DbAdapter, objects: ObjectTypeDef[], links: LinkTypeDef[]): void {
  const wanted = new Set<string>();
  const ensure = (targetKind: ActionTemplateDef['targetKind'], targetName: string, operation: ActionTemplateDef['operation'], title: string, parameters: ActionParamDef[]) => {
    wanted.add(`${targetKind}:${targetName}:${operation}`);
    const schemaDigest = digest({ targetKind, targetName, operation, parameters });
    const existing = db.prepare('SELECT action_name,schema_digest FROM ont_action_templates WHERE target_kind=? AND target_name=? AND operation=?').get(targetKind, targetName, operation);
    if (existing) {
      if (existing.schema_digest !== schemaDigest) {
        db.prepare('UPDATE ont_action_types SET parameters=?,updated_at=? WHERE api_name=?').run(JSON.stringify(parameters), nowIso(), existing.action_name);
        db.prepare('UPDATE ont_action_templates SET schema_digest=?,template_version=1 WHERE action_name=?').run(schemaDigest, existing.action_name);
      }
      return;
    }
    const stem = `${targetKind}_${targetName}_${operation}`;
    let actionName = stem.length <= 41 ? stem : `${targetKind}_${digest(stem).slice(0, 16)}_${operation}`;
    let suffix = 0;
    while (db.prepare('SELECT 1 FROM ont_action_types WHERE api_name=?').get(actionName)) actionName = `${targetKind}_${digest(stem).slice(0, 16)}_${operation}_${++suffix}`;
    const now = nowIso();
    db.prepare(`INSERT INTO ont_action_types(api_name,title,description,is_builtin,status,parameters,operations,sort_order,created_at,updated_at)
      VALUES(?,?,?,0,'active',?,'[]',150,?,?)`).run(actionName, title, '基础动作：遵守对象字段、关系与业务写入规则。可停用，旧通用入口也受同一动作控制。', JSON.stringify(parameters), now, now);
    db.prepare('INSERT INTO ont_action_templates(action_name,target_kind,target_name,operation,template_version,schema_digest) VALUES(?,?,?,?,1,?)').run(actionName, targetKind, targetName, operation, schemaDigest);
  };
  const idParameter = (def: ObjectTypeDef, name = 'id'): ActionParamDef => ({ name, dataType: def.properties.find(p => p.apiName === def.primaryKey)?.dataType === 'integer' ? 'integer' : 'string', required: true, objectType: def.apiName });
  for (const def of objects) {
    if (def.isVirtual || !def.tableName || def.writeMode === 'read_only') continue;
    if (db.prepare('SELECT enabled FROM ont_template_preferences WHERE object_type=?').get(def.apiName)?.enabled === 0) continue;
    if (!def.isSystem) {
      ensure('object', def.apiName, 'create', `新增${def.title}`, [{ name: 'values', dataType: 'json', required: true, jsonSchema: valuesSchema(def.properties, true) }]);
      ensure('object', def.apiName, 'update', `编辑${def.title}`, [idParameter(def), { name: 'values', dataType: 'json', required: true, jsonSchema: valuesSchema(def.properties.filter(p => !p.isPrimaryKey), false) }]);
      ensure('object', def.apiName, 'delete', `删除${def.title}`, [idParameter(def)]);
    } else if (def.extensionWritable) {
      const properties = def.properties.filter(p => p.origin === 'user');
      if (properties.length) ensure('object', def.apiName, 'extensions', `编辑${def.title}扩展字段`, [idParameter(def), { name: 'values', dataType: 'json', required: true, jsonSchema: valuesSchema(properties, false) }]);
    }
  }
  for (const link of links) {
    if (link.isSystem && link.apiName !== 'media_content__media_material') continue;
    const left = objects.find(o => o.apiName === link.leftType)!;
    const right = objects.find(o => o.apiName === link.rightType)!;
    if (left.isVirtual || right.isVirtual) continue;
    const ids = [idParameter(left, 'left_id'), idParameter(right, 'right_id')];
    const backing = objects.find(o => o.apiName === link.linkTable);
    const extra = backing?.properties.filter(p => ![link.backingLeftProperty, link.backingRightProperty].includes(p.apiName)) ?? [];
    ensure('link', link.apiName, 'create', `建立${link.title}`, [...ids, { name: 'properties', dataType: 'json', required: false, jsonSchema: valuesSchema(extra, true) }]);
    ensure('link', link.apiName, 'delete', `解除${link.title}`, ids);
  }
  for (const row of db.prepare('SELECT * FROM ont_action_templates').all()) {
    if (!wanted.has(`${row.target_kind}:${row.target_name}:${row.operation}`)) db.prepare('DELETE FROM ont_action_types WHERE api_name=?').run(row.action_name);
  }
}
