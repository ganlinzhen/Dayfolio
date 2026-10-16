// 动作执行器：内置动作（绑定核心服务方法）+ 声明式 DSL（create/modify/delete object、
// create/delete link 五种规则，值映射=参数引用/字面量/内建函数）。
// DSL 动作在单事务内顺序执行（Unit of Work 模式，天然 read-your-writes）。
import { randomUUID } from 'node:crypto';
import { inTx, readSnapshot, type DbAdapter } from '../db';
import { nowIso, ensureValidDateStr } from '../utils/date';
import type { ObjectRepo } from './repo';
import type { ActionOperation, ActionParamDef, ActionTypeDef, ValueMapping } from './types';
import type { RelationService } from './relations';
import type { CommandService } from './commands';
import { COMPOSABLE_COMMANDS } from './commands';
import type { OntologyService } from './registry';
import { validateCommandInput } from './input-validation';
import { assertObjectWrite, OntologyError } from './policy';
import { assertRelationPatch } from './relations';
import { valueHash } from './canonical';
import type { ActionRunStore } from '../services/action-run';

export type BuiltinHandlers = Record<string, (params: Record<string, unknown>) => unknown>;

export interface OperationResult {
  kind: ActionOperation['kind'];
  objectType?: string;
  linkType?: string;
  /** create_object 产出的主键值 */
  objectId?: unknown;
  /** modify/delete 影响的行数 */
  changes?: number;
  /** 受限业务命令的返回值，供后续步骤引用。 */
  value?: unknown;
}

export interface ActionExecution {
  action: string;
  builtin: boolean;
  results: OperationResult[];
  /** 内置动作或基础模板的业务返回值，兼容旧入口。 */
  result?: unknown;
  executedAt: string;
  executionId?: string;
  replayed?: boolean;
  auditStatus?: 'unavailable';
}

export interface ObjectRevision { objectType: string; id: string | number; revision: string; }
export interface ActionExecutionOptions { idempotencyKey?: string; expectedDefinitionRevision?: string; expectedObjects?: ObjectRevision[]; }

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
      if (!Number.isFinite(n)) throw new Error(`参数 ${def.name} 须为数字`);
      return n;
    }
    case 'boolean':
      if (![true,false,0,1,'true','false'].includes(v as boolean)) throw new Error(`参数 ${def.name} 须为布尔值`);
      return v === true || v === 1 || v === 'true';
    case 'json':
      return typeof v === 'string' ? JSON.parse(v) : v;
    case 'date': {
      const s = String(v);
      if (!/^\d{4}-\d{2}-\d{2}/.test(s)) throw new Error(`参数 ${def.name} 须为日期（YYYY-MM-DD 或 ISO）`);
      ensureValidDateStr(s.slice(0,10));
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
  commands: CommandService,
  relations: RelationService,
  runs: ActionRunStore,
) {
  const list = (): ActionTypeDef[] => ontology.listActionTypes();
  const get = (apiName: string): ActionTypeDef => ontology.getActionType(apiName);

  const resolveMapping = (m: ValueMapping, params: Record<string, unknown>, results: OperationResult[]): unknown => {
    if ('source' in m) {
      if (!(m.source.parameter in params)) throw new Error(`引用了未提供的参数 ${m.source.parameter}`);
      return params[m.source.parameter];
    }
    if ('fn' in m) return m.fn === 'now' ? nowIso() : randomUUID();
    if ('result' in m) {
      let value: unknown = results[m.result.step];
      for (const key of m.result.path) {
        if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new OntologyError('ACTION_RESULT_NOT_FOUND', '前步结果没有请求的字段');
        value = Reflect.get(value, key);
      }
      return value;
    }
    return m.literal;
  };

  const runOperation = (op: ActionOperation, params: Record<string, unknown>, results: OperationResult[]): OperationResult => {
    const resolve = (mapping: ValueMapping) => resolveMapping(mapping, params, results);
    switch (op.kind) {
      case 'create_object': {
        const values: Record<string, unknown> = {};
        for (const [prop, mapping] of Object.entries(op.propertyMappings)) {
          values[prop] = resolve(mapping);
        }
        const row = repo.insert(op.objectType, values);
        const def = ontology.getObjectType(op.objectType);
        return { kind: op.kind, objectType: op.objectType, objectId: row[def.primaryKey] };
      }
      case 'modify_object': {
        const patch: Record<string, unknown> = {};
        for (const [prop, mapping] of Object.entries(op.propertyMappings)) patch[prop] = resolve(mapping);
        const changes = repo.updateBy(op.objectType, op.selector.property, resolve(op.selector.value), patch);
        return { kind: op.kind, objectType: op.objectType, changes };
      }
      case 'delete_object': {
        const changes = repo.deleteBy(op.objectType, op.selector.property, resolve(op.selector.value));
        return { kind: op.kind, objectType: op.objectType, changes };
      }
      case 'create_link': {
        const result=relations.create(op.linkType,resolve(op.leftId),resolve(op.rightId));
        return {kind:op.kind,linkType:op.linkType,changes:result.changes,objectId:'objectId' in result ? result.objectId : undefined};
      }
      case 'delete_link': {
        const result=relations.remove(op.linkType,resolve(op.leftId),resolve(op.rightId));
        return {kind:op.kind,linkType:op.linkType,changes:result.changes};
      }
      case 'invoke_command': {
        if (!COMPOSABLE_COMMANDS.has(op.command)) throw new OntologyError('ACTION_NOT_COMPOSABLE', '该命令不允许组合');
        const args = Object.fromEntries(Object.entries(op.params).map(([name, mapping]) => [name, resolve(mapping)]));
        return { kind: op.kind, value: commands.execute(op.command, args) };
      }
    }
  };

  const executeBody = (apiName: string, rawParams: Record<string, unknown>): ActionExecution => {
    const def = ontology.getActionType(apiName);
    if (def.status === 'disabled') throw new OntologyError('ACTION_DISABLED', `动作 ${apiName} 已停用`);
    if (def.template) return inTx(db, () => {
      const current = ontology.getActionType(apiName);
      if (current.status === 'disabled') throw new OntologyError('ACTION_DISABLED', `动作 ${apiName} 已停用`);
      for (const key of Object.keys(rawParams)) if (!current.parameters.some(p => p.name === key)) throw new Error(`未知参数 ${key}`);
      const template = current.template!;
      const object = template.targetKind === 'object' ? ontology.getObjectType(template.targetName) : undefined;
      const values = rawParams.values as Record<string, unknown> | undefined;
      if (object) {
        if (template.operation !== 'delete' && (!values || typeof values !== 'object' || Array.isArray(values))) throw new Error('values 须为属性对象');
        assertObjectWrite(object, template.operation === 'create' ? 'create' : template.operation === 'delete' ? 'delete' : 'update', values);
        if (template.operation === 'update' || template.operation === 'extensions') {
          assertRelationPatch(ontology, object.apiName, values!);
          if (!Object.keys(values!).length) throw new Error('没有可更新字段');
        }
      }
      for (const p of current.parameters) {
        const value = rawParams[p.name];
        if (p.required && (value === undefined || value === null)) throw new Error(`参数 ${p.name} 必填`);
        if (value === undefined) continue;
        validateCommandInput(p.jsonSchema, value, p.name);
        if (p.dataType === 'integer' && !Number.isSafeInteger(value)) throw new Error(`参数 ${p.name} 须为安全整数`);
        if (p.dataType === 'string' && typeof value !== 'string') throw new Error(`参数 ${p.name} 须为文本`);
        if (p.dataType === 'json' && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error(`参数 ${p.name} 须为结构化对象`);
      }
      if (object && values) for (const [name, value] of Object.entries(values)) {
        const p = object.properties.find(p => p.apiName === name);
        if (p?.dataType === 'integer' && value !== null && !Number.isSafeInteger(value)) throw new Error(`${name}须为安全整数`);
      }
      let result: unknown;
      let operation: OperationResult;
      if (object) {
        if (template.operation === 'create') {
          const row = repo.insert(object.apiName, values!);
          result = row;
          operation = { kind: 'create_object', objectType: object.apiName, objectId: row[object.primaryKey] };
        } else if (template.operation === 'delete') {
          repo.remove(object.apiName, rawParams.id);
          result = true;
          operation = { kind: 'delete_object', objectType: object.apiName, changes: 1 };
        } else {
          result = repo.update(object.apiName, rawParams.id, values!);
          operation = { kind: 'modify_object', objectType: object.apiName, changes: 1 };
        }
      } else {
        const linked = template.operation === 'create'
          ? relations.create(template.targetName, rawParams.left_id, rawParams.right_id, rawParams.properties as Record<string, unknown> | undefined)
          : relations.remove(template.targetName, rawParams.left_id, rawParams.right_id);
        result = linked;
        operation = { kind: template.operation === 'create' ? 'create_link' : 'delete_link', linkType: template.targetName, changes: linked.changes,
          ...('objectId' in linked ? { objectId: linked.objectId } : {}) };
      }
      return { action: apiName, builtin: false, results: [operation], result, executedAt: nowIso() };
    });
    if (def.isBuiltin) return {action:apiName,builtin:true,results:[],result:commands.execute(apiName,rawParams),executedAt:nowIso()};
    try { ontology.assertActionWritable(def); } catch (error) { throw new Error(`ACTION_NEEDS_REVIEW：${(error as Error).message}`); }
    for(const key of Object.keys(rawParams))if(!def.parameters.some(p=>p.name===key))throw new Error(`未知参数 ${key}`);
    const params: Record<string, unknown> = {};
    for (const p of def.parameters) {
      validateCommandInput(p.jsonSchema, rawParams[p.name], p.name);
      params[p.name] = coerceParam(p, rawParams[p.name]);
      if (p.objectType && params[p.name] !== null && !repo.get(p.objectType, params[p.name])) throw new OntologyError('REFERENCE_NOT_FOUND', `对象参数 ${p.name} 引用目标不存在`);
    }

    const results = inTx(db, () => {
      if (ontology.getActionType(apiName).status === 'disabled') throw new OntologyError('ACTION_DISABLED', '动作已停用');
      const results: OperationResult[] = [];
      for (const op of def.operations) results.push(runOperation(op, params, results));
      return results;
    });
    return { action: apiName, builtin: false, results, executedAt: nowIso() };
  };

  const definitionRevision = (def: ActionTypeDef) => valueHash({ apiName: def.apiName, isBuiltin: def.isBuiltin, status: def.status,
    parameters: def.parameters, operations: def.operations, template: def.template, allowedChannels: def.allowedChannels,
    commands: def.operations.flatMap(op => op.kind === 'invoke_command' ? [ontology.getActionType(op.command)].map(command => ({ apiName: command.apiName, status: command.status, parameters: command.parameters })) : []) });
  const target = (objectType: string, id: unknown): ObjectRevision => {
    const def = ontology.getObjectType(objectType);
    const pk = def.properties.find(p => p.apiName === def.primaryKey)!;
    if ((pk.dataType === 'integer' && !Number.isSafeInteger(id)) || (pk.dataType === 'string' && typeof id !== 'string')) throw new OntologyError('ACTION_INPUT_INVALID', '对象修订主键类型不匹配');
    const row = repo.get(objectType, id);
    if (!row) throw new OntologyError('REFERENCE_NOT_FOUND', '对象修订目标不存在');
    return { objectType, id: id as string | number, revision: valueHash({ objectType, properties: def.properties.filter(p => p.readable !== false), row }) };
  };
  const preview = (apiName: string, params: Record<string, unknown>) => readSnapshot(db, () => {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new OntologyError('ACTION_INPUT_INVALID', '动作参数须为对象');
    const def = ontology.getActionType(apiName);
    const targets: ObjectRevision[] = [];
    let targetsComplete = true;
    if (def.template?.targetKind === 'object' && def.template.operation !== 'create') targets.push(target(def.template.targetName, params.id));
    else if (def.template?.targetKind === 'link') {
      const link = ontology.listLinkTypes().find(l => l.apiName === def.template!.targetName)!;
      targets.push(target(link.leftType, params.left_id), target(link.rightType, params.right_id));
    } else if (def.isBuiltin) {
      for (const binding of def.targetBindings ?? []) {
        if (binding.parameter && params[binding.parameter] !== undefined) targets.push(target(binding.objectType, params[binding.parameter]));
        else targetsComplete = false;
      }
    } else for (const op of def.operations) {
      if (op.kind === 'modify_object' || op.kind === 'delete_object') {
        const mapping = op.selector.value;
        const value = 'literal' in mapping ? mapping.literal : 'source' in mapping ? params[mapping.source.parameter] : undefined;
        if (value === undefined) { targetsComplete = false; continue; }
        const matches = repo.list(op.objectType, { where: [{ property: op.selector.property, op: 'eq', value }], limit: 50 });
        if (matches.total > 50) throw new OntologyError('ACTION_PREVIEW_TOO_LARGE', '待变更对象超过预览上限，请缩小动作范围');
        const objectDef = ontology.getObjectType(op.objectType);
        targets.push(...matches.rows.map(row => target(op.objectType, row[objectDef.primaryKey])));
      } else if (op.kind !== 'create_object') targetsComplete = false;
    }
    const unique = [...new Map(targets.map(ref => [`${ref.objectType}:${typeof ref.id}:${ref.id}`, ref])).values()];
    return { action: apiName, definitionRevision: definitionRevision(def), targets: unique, targetsComplete,
      note: '预览只读取当前可识别目标的修订，不执行动作；新增对象、结果引用和业务联动的完整影响由执行时校验。' };
  });
  const execute = (apiName: string, rawParams: Record<string, unknown>, rawOptions: unknown = {}, channel: 'app' | 'mcp' | 'core' = 'core'): ActionExecution => {
    if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams) || !rawOptions || typeof rawOptions !== 'object' || Array.isArray(rawOptions)) throw new OntologyError('ACTION_INPUT_INVALID', '动作参数和执行选项须为对象');
    const options = rawOptions as ActionExecutionOptions;
    for (const key of Object.keys(options)) if (!['idempotencyKey', 'expectedDefinitionRevision', 'expectedObjects'].includes(key)) throw new OntologyError('ACTION_INPUT_INVALID', `未知执行选项 ${key}`);
    if (options.expectedDefinitionRevision !== undefined && (typeof options.expectedDefinitionRevision !== 'string' || !/^[a-f0-9]{64}$/.test(options.expectedDefinitionRevision))) throw new OntologyError('ACTION_INPUT_INVALID', '动作修订须为有效摘要');
    if (options.expectedObjects !== undefined) {
      if (!Array.isArray(options.expectedObjects) || options.expectedObjects.length > 50) throw new OntologyError('ACTION_INPUT_INVALID', '对象修订前置条件须为最多 50 项数组');
      for (const ref of options.expectedObjects) if (!ref || typeof ref !== 'object' || Object.keys(ref).some(key => !['objectType', 'id', 'revision'].includes(key)) || typeof ref.objectType !== 'string' || typeof ref.revision !== 'string' || !/^[a-f0-9]{64}$/.test(ref.revision)) throw new OntologyError('ACTION_INPUT_INVALID', '对象修订前置条件无效');
    }
    const def = ontology.getActionType(apiName);
    const revision = definitionRevision(def);
    const atomic = !def.isBuiltin || COMPOSABLE_COMMANDS.has(apiName);
    return runs.track(apiName, rawParams, revision, atomic, options, channel, () => {
      if (options.expectedDefinitionRevision && definitionRevision(ontology.getActionType(apiName)) !== options.expectedDefinitionRevision) throw new OntologyError('REVISION_CONFLICT', '动作定义已变化，请重新查看');
      for (const expected of options.expectedObjects ?? []) {
        let current: ObjectRevision;
        try { current = target(expected.objectType, expected.id); } catch (error) {
          if (error instanceof OntologyError && error.code === 'REFERENCE_NOT_FOUND') throw new OntologyError('REVISION_CONFLICT', '对象已被删除，请重新读取');
          throw error;
        }
        if (current.revision !== expected.revision) throw new OntologyError('REVISION_CONFLICT', '对象已经被其他入口修改，请重新读取后再执行');
      }
      return executeBody(apiName, rawParams);
    });
  };
  const writeObject = (objectType: string, operation: 'create' | 'update' | 'delete', id?: unknown, values: Record<string, unknown> = {}, options: unknown = {}, channel: 'app' | 'mcp' | 'core' = 'core') => {
    const def = ontology.getObjectType(objectType);
    assertObjectWrite(def, operation, values);
    const action = ontology.getTemplateAction('object', objectType, operation === 'update' && def.isSystem ? 'extensions' : operation);
    return execute(action.apiName, operation === 'create' ? { values } : operation === 'delete' ? { id } : { id, values }, options, channel).result;
  };
  const writeRelation = (name: string, operation: 'create' | 'delete', leftId: unknown, rightId: unknown, properties?: Record<string, unknown>, options: unknown = {}, channel: 'app' | 'mcp' | 'core' = 'core') => {
    const action = ontology.getTemplateAction('link', name, operation);
    return execute(action.apiName, { left_id: leftId, right_id: rightId, ...(operation === 'create' && properties !== undefined ? { properties } : {}) }, options, channel).result;
  };
  return { list, get, execute, preview, writeObject, writeRelation };
}

export type ActionService = ReturnType<typeof createActionService>;
