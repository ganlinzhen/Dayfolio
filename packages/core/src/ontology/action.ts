// 动作执行器：内置动作（绑定核心服务方法）+ 声明式 DSL（create/modify/delete object、
// create/delete link 五种规则，值映射=参数引用/字面量/内建函数）。
// DSL 动作在单事务内顺序执行（Unit of Work 模式，天然 read-your-writes）。
import { randomUUID } from 'node:crypto';
import { inTx, type DbAdapter } from '../db';
import { nowIso } from '../utils/date';
import type { ObjectRepo } from './repo';
import type { ActionOperation, ActionParamDef, ActionTypeDef, ValueMapping } from './types';
import type { OntologyService } from './registry';

export type BuiltinHandlers = Record<string, (params: Record<string, unknown>) => unknown>;

export interface OperationResult {
  kind: ActionOperation['kind'];
  objectType?: string;
  linkType?: string;
  /** create_object 产出的主键值 */
  objectId?: unknown;
  /** modify/delete 影响的行数 */
  changes?: number;
}

export interface ActionExecution {
  action: string;
  builtin: boolean;
  results: OperationResult[];
  /** builtin 动作的返回值 */
  result?: unknown;
  executedAt: string;
}

const coerceParam = (def: ActionParamDef, raw: unknown): unknown => {
  const v = raw === undefined ? def.defaultValue : raw;
  if (v === undefined || v === null || v === '') {
    if (def.required) throw new Error(`参数 ${def.name} 必填`);
    return null;
  }
  switch (def.dataType) {
    case 'integer': {
      const n = Number(v);
      if (!Number.isInteger(n)) throw new Error(`参数 ${def.name} 须为整数`);
      return n;
    }
    case 'float': {
      const n = Number(v);
      if (Number.isNaN(n)) throw new Error(`参数 ${def.name} 须为数字`);
      return n;
    }
    case 'boolean':
      return v === true || v === 1 || v === 'true';
    case 'json':
      return typeof v === 'string' ? v : JSON.stringify(v);
    case 'date': {
      const s = String(v);
      if (!/^\d{4}-\d{2}-\d{2}/.test(s)) throw new Error(`参数 ${def.name} 须为日期（YYYY-MM-DD 或 ISO）`);
      return s;
    }
    default:
      return String(v);
  }
};

export function createActionService(
  db: DbAdapter,
  ontology: OntologyService,
  repo: ObjectRepo,
  builtinHandlers: BuiltinHandlers,
) {
  const list = (): ActionTypeDef[] => ontology.listActionTypes();
  const get = (apiName: string): ActionTypeDef => ontology.getActionType(apiName);

  const resolveMapping = (m: ValueMapping, params: Record<string, unknown>): unknown => {
    if ('source' in m) {
      if (!(m.source.parameter in params)) throw new Error(`引用了未提供的参数 ${m.source.parameter}`);
      return params[m.source.parameter];
    }
    if ('fn' in m) return m.fn === 'now' ? nowIso() : randomUUID();
    return m.literal;
  };

  const runOperation = (op: ActionOperation, params: Record<string, unknown>): OperationResult => {
    switch (op.kind) {
      case 'create_object': {
        const values: Record<string, unknown> = {};
        for (const [prop, mapping] of Object.entries(op.propertyMappings)) {
          values[prop] = resolveMapping(mapping, params);
        }
        const row = repo.insert(op.objectType, values);
        const def = ontology.getObjectType(op.objectType);
        return { kind: op.kind, objectType: op.objectType, objectId: row[def.primaryKey] };
      }
      case 'modify_object': {
        const patch: Record<string, unknown> = {};
        for (const [prop, mapping] of Object.entries(op.propertyMappings)) patch[prop] = resolveMapping(mapping, params);
        const changes = repo.updateBy(op.objectType, op.selector.property, resolveMapping(op.selector.value, params), patch);
        return { kind: op.kind, objectType: op.objectType, changes };
      }
      case 'delete_object': {
        const changes = repo.deleteBy(op.objectType, op.selector.property, resolveMapping(op.selector.value, params));
        return { kind: op.kind, objectType: op.objectType, changes };
      }
      case 'create_link': {
        const link = ontology.listLinkTypes().find((l) => l.apiName === op.linkType)!;
        const leftId = resolveMapping(op.leftId, params);
        const rightId = resolveMapping(op.rightId, params);
        if (link.linkTable) {
          const row = repo.insert(link.linkTable, { [link.backingLeftProperty!]: leftId, [link.backingRightProperty!]: rightId });
          const def = ontology.getObjectType(link.linkTable);
          return { kind: op.kind, linkType: link.apiName, objectId: row[def.primaryKey] };
        }
        // 1:1 / 1:N：外键列挂在 right 侧行上
        const rightDef = ontology.getObjectType(link.rightType);
        repo.updateBy(link.rightType, rightDef.primaryKey, rightId, { [link.fkColumn!]: leftId });
        return { kind: op.kind, linkType: link.apiName, changes: 1 };
      }
      case 'delete_link': {
        const link = ontology.listLinkTypes().find((l) => l.apiName === op.linkType)!;
        const leftId = resolveMapping(op.leftId, params);
        const rightId = resolveMapping(op.rightId, params);
        if (link.linkTable) {
          // 中间表按左右引用同时匹配删除
          const rows = repo.list(link.linkTable, {
            where: [
              { property: link.backingLeftProperty!, op: 'eq', value: leftId },
              { property: link.backingRightProperty!, op: 'eq', value: rightId },
            ],
            limit: 100,
          });
          for (const r of rows.rows) {
            const def = ontology.getObjectType(link.linkTable);
            repo.remove(link.linkTable, r[def.primaryKey]);
          }
          return { kind: op.kind, linkType: link.apiName, changes: rows.rows.length };
        }
        const rightDef = ontology.getObjectType(link.rightType);
        const changes = repo.updateBy(link.rightType, rightDef.primaryKey, rightId, { [link.fkColumn!]: null });
        return { kind: op.kind, linkType: link.apiName, changes };
      }
    }
  };

  const execute = (apiName: string, rawParams: Record<string, unknown>): ActionExecution => {
    const def = ontology.getActionType(apiName);
    if (def.status === 'disabled') throw new Error(`动作 ${apiName} 已停用`);
    const params: Record<string, unknown> = {};
    for (const p of def.parameters) params[p.name] = coerceParam(p, rawParams[p.name]);

    if (def.isBuiltin) {
      const handler = builtinHandlers[apiName];
      if (!handler) throw new Error(`内置动作 ${apiName} 未注册处理函数`);
      const result = handler(params);
      return { action: apiName, builtin: true, results: [], result, executedAt: nowIso() };
    }
    const results = inTx(db, () => def.operations.map((op) => runOperation(op, params)));
    return { action: apiName, builtin: false, results, executedAt: nowIso() };
  };

  return { list, get, execute };
}

export type ActionService = ReturnType<typeof createActionService>;
