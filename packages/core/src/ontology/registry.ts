// 本体注册表：三类元数据（对象/链接/动作类型）的加载、bootstrap 同步、
// 与物理 schema 的双向校验、以及管理界面的 CRUD。
// 对应常见本体服务的 ObjectTypeService/LinkTypeService + 运行时元数据校验。
import { inTx, type DbAdapter } from '../db';
import { nowIso } from '../utils/date';
import { BOOT_ACTION_TYPES, BOOT_LINK_TYPES, BOOT_OBJECT_TYPES } from './bootstrap';
import { BUSINESS_OBJECTS, BUSINESS_LINKS } from './catalog';
import { RUNTIME_OBJECTS,RUNTIME_LINKS } from './runtime-catalog';
import { COMMAND_DEFS, COMPOSABLE_COMMANDS, commandMetadata } from './commands';
import { syncRelationConstraints, dropRelationConstraints } from './relations';
import { objectPolicy, assertObjectWrite, OntologyError } from './policy';
import { syncActionTemplates } from './templates';
import { validateActionSchema } from './input-validation';
import { addObjectColumn, createCustomObjectTable, customTableName, dropObjectColumn, dropObjectTable } from './ddl';
import type {
  ActionOperation,
  ActionTemplateDef,
  ActionTypeDef,
  CreateActionTypeInput,
  CreateLinkTypeInput,
  CreateObjectTypeInput,
  LinkTypeDef,
  NewPropertyInput,
  ObjectTypeDef,
  PropertyDef,
  UpdateActionTypeInput,
  UpdateObjectTypeInput,
  ValueMapping,
} from './types';

const API_NAME_RE = /^[a-z][a-z0-9_]{0,40}$/;
const PROP_NAME_RE = /^[a-z][a-z0-9_]{0,40}$/;

export const ONTOLOGY_META_DDL = `
CREATE TABLE IF NOT EXISTS ont_object_types (
  api_name TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  table_name TEXT UNIQUE,
  is_virtual INTEGER NOT NULL DEFAULT 0,
  is_system INTEGER NOT NULL DEFAULT 0,
  primary_key TEXT NOT NULL DEFAULT 'id',
  title_property TEXT NOT NULL,
  properties TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ont_link_types (
  api_name TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  left_type TEXT NOT NULL,
  right_type TEXT NOT NULL,
  cardinality TEXT NOT NULL,
  left_link_name TEXT,
  right_link_name TEXT,
  fk_column TEXT,
  on_delete TEXT,
  discriminator_column TEXT,
  discriminator_value TEXT,
  ref_column TEXT,
  link_table TEXT,
  backing_left_property TEXT,
  backing_right_property TEXT,
  is_system INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ont_action_types (
  api_name TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_builtin INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  parameters TEXT NOT NULL,
  operations TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

function parseJson<T>(raw: unknown, fallback: T): T {
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return fallback;
  }
}

function rowToObject(row: Record<string, unknown>): ObjectTypeDef {
  return {
    ...objectPolicy(String(row.api_name), Number(row.is_system) === 1, Number(row.is_virtual) === 1),
    apiName: String(row.api_name),
    title: String(row.title),
    description: String(row.description ?? ''),
    tableName: (row.table_name as string | null) ?? null,
    isVirtual: Number(row.is_virtual) === 1,
    isSystem: Number(row.is_system) === 1,
    primaryKey: String(row.primary_key),
    titleProperty: String(row.title_property),
    properties: parseJson<PropertyDef[]>(row.properties, []),
    status: Number(row.status) === 0 || row.status === 'disabled' ? 'disabled' : 'active',
    sortOrder: Number(row.sort_order ?? 0),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
  };
}

function rowToLink(row: Record<string, unknown>): LinkTypeDef {
  return {
    apiName: String(row.api_name),
    title: String(row.title),
    leftType: String(row.left_type),
    rightType: String(row.right_type),
    cardinality: row.cardinality as LinkTypeDef['cardinality'],
    leftLinkName: (row.left_link_name as string | null) ?? null,
    rightLinkName: (row.right_link_name as string | null) ?? null,
    referenceKind: Number(row.is_system) === 1 ? (['study_plan__study_session','study_session__study_assessment'].includes(String(row.api_name)) ? 'historical' : String(row.api_name) === 'day__checkin' ? 'derived' : 'strong') : 'strong',
    ...parseJson<Record<string, unknown>>(row.config, {}),
    fkColumn: (row.fk_column as string | null) ?? undefined,
    onDelete: row.cardinality==='many_to_many' ? 'cascade' : ['study_plan__study_session','study_session__study_assessment','day__checkin'].includes(String(row.api_name)) || parseJson<{referenceKind?:string}>(row.config,{}).referenceKind==='historical' ? 'none' : (row.on_delete as LinkTypeDef['onDelete'] | null) ?? undefined,
    discriminatorColumn: (row.discriminator_column as string | null) ?? undefined,
    discriminatorValue: (row.discriminator_value as string | null) ?? undefined,
    refColumn: (row.ref_column as string | null) ?? undefined,
    linkTable: (row.link_table as string | null) ?? undefined,
    backingLeftProperty: (row.backing_left_property as string | null) ?? undefined,
    backingRightProperty: (row.backing_right_property as string | null) ?? undefined,
    isSystem: Number(row.is_system) === 1,
    sortOrder: Number(row.sort_order ?? 0),
    createdAt: String(row.created_at ?? ''),
  };
}

function rowToAction(row: Record<string, unknown>): ActionTypeDef {
  return {
    apiName: String(row.api_name),
    title: String(row.title),
    description: String(row.description ?? ''),
    isBuiltin: Number(row.is_builtin) === 1,
    composable: COMPOSABLE_COMMANDS.has(String(row.api_name)),
    targetBindings: COMMAND_DEFS.find(d=>d.apiName===row.api_name)?.targetBindings,
    allowedChannels: COMMAND_DEFS.find(d=>d.apiName===row.api_name)?.human ? ['app-human'] : ['app','mcp','core'],
    status: row.status === 'disabled' ? 'disabled' : 'active',
    parameters: parseJson<ActionTypeDef['parameters']>(row.parameters, []),
    operations: parseJson<ActionTypeDef['operations']>(row.operations, []),
    sortOrder: Number(row.sort_order ?? 0),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
  };
}

/** 校验属性定义（新建/追加共用） */
function checkPropertyInput(p: NewPropertyInput, known: string[]): PropertyDef {
  const apiName = String(p.apiName ?? '').trim();
  if (!PROP_NAME_RE.test(apiName)) throw new Error(`属性名 ${JSON.stringify(apiName)} 不合法（小写字母开头，仅小写字母/数字/下划线）`);
  if (known.includes(apiName)) throw new Error(`属性 ${apiName} 已存在`);
  const dataTypes = ['string', 'integer', 'float', 'boolean', 'date', 'json', 'enum'];
  if (!dataTypes.includes(p.dataType)) throw new Error(`属性 ${apiName} 的类型不合法`);
  const enumValues = (p.enumValues ?? []).map((v) => String(v).trim()).filter(Boolean);
  if (p.dataType === 'enum' && enumValues.length === 0) throw new Error(`枚举属性 ${apiName} 必须给出取值清单`);
  return {
    apiName,
    dataType: p.dataType,
    nullable: p.nullable ?? true,
    enumValues: p.dataType === 'enum' ? enumValues : undefined,
    indexed: p.indexed ?? false,
    origin: 'user',
    description: p.description?.trim() || undefined,
  };
}

function assertApiName(name: string, label: string): string {
  const n = String(name ?? '').trim();
  if (!API_NAME_RE.test(n)) throw new Error(`${label} ${JSON.stringify(n)} 不合法（小写字母开头，仅小写字母/数字/下划线）`);
  return n;
}

export function createOntologyService(db: DbAdapter) {
  // ---------- 初始化 ----------

  /** 建元数据表并把代码里的 bootstrap 定义幂等同步进去（系统行以代码为准，不动自定义行） */
  const init = (): void => {
    db.exec(ONTOLOGY_META_DDL);
    inTx(db,()=>{ syncBootstrap(); validateAll(); syncRelationConstraints(db,listObjectTypes(),listLinkTypes()); syncTemplates(); });
  };
  const syncTemplates = () => syncActionTemplates(db, listObjectTypes(), listLinkTypes());

  const syncBootstrap = (): void => {
    const now = nowIso();
    inTx(db, () => {
      const upsertObject = db.prepare(`
        INSERT INTO ont_object_types (api_name,title,description,table_name,is_virtual,is_system,primary_key,title_property,properties,status,sort_order,created_at,updated_at)
        VALUES (@api_name,@title,@description,@table_name,@is_virtual,@is_system,@primary_key,@title_property,@properties,@status,@sort_order,@created_at,@updated_at)
        ON CONFLICT(api_name) DO UPDATE SET title=excluded.title, description=excluded.description, table_name=excluded.table_name,
          is_virtual=excluded.is_virtual, is_system=1, primary_key=excluded.primary_key, title_property=excluded.title_property,
          properties=excluded.properties, status=excluded.status, sort_order=excluded.sort_order, updated_at=excluded.updated_at
      `);
      for (const t of [...BOOT_OBJECT_TYPES, ...BUSINESS_OBJECTS,...RUNTIME_OBJECTS]) {
        // 保留用户在系统类型上追加过的属性（origin=user 行不随代码覆盖）
        const conflict = db.prepare('SELECT is_system FROM ont_object_types WHERE api_name = ?').get(t.apiName);
        if (conflict && !Number(conflict.is_system)) throw new Error(`对象类型名称冲突：${t.apiName} 已被用户使用，升级未覆盖其定义`);
        const existing = db.prepare('SELECT properties FROM ont_object_types WHERE api_name = ?').get(t.apiName);
        const userProps = existing ? parseJson<PropertyDef[]>(existing.properties, []).filter((p) => p.origin === 'user') : [];
        for(const p of userProps)if(t.properties.some(b=>b.apiName===p.apiName))throw new Error(`系统字段升级冲突：${t.apiName}.${p.apiName} 已被用户属性占用`);
        const props = [...t.properties, ...userProps];
        upsertObject.run({
          api_name: t.apiName,
          title: t.title,
          description: t.description ?? '',
          table_name: t.tableName,
          is_virtual: t.isVirtual ? 1 : 0,
          is_system: 1,
          primary_key: t.primaryKey,
          title_property: t.titleProperty,
          properties: JSON.stringify(props),
          status: t.status,
          sort_order: t.sortOrder,
          created_at: now,
          updated_at: now,
        });
      }
      const upsertLink = db.prepare(`
        INSERT INTO ont_link_types (api_name,title,left_type,right_type,cardinality,left_link_name,right_link_name,fk_column,on_delete,discriminator_column,discriminator_value,ref_column,link_table,backing_left_property,backing_right_property,is_system,sort_order,created_at)
        VALUES (@api_name,@title,@left_type,@right_type,@cardinality,@left_link_name,@right_link_name,@fk_column,@on_delete,@discriminator_column,@discriminator_value,@ref_column,@link_table,@backing_left_property,@backing_right_property,1,@sort_order,@created_at)
        ON CONFLICT(api_name) DO UPDATE SET title=excluded.title, left_type=excluded.left_type, right_type=excluded.right_type,
          cardinality=excluded.cardinality, left_link_name=excluded.left_link_name, right_link_name=excluded.right_link_name,
          fk_column=excluded.fk_column, on_delete=excluded.on_delete, discriminator_column=excluded.discriminator_column,
          discriminator_value=excluded.discriminator_value, ref_column=excluded.ref_column, link_table=excluded.link_table,
          backing_left_property=excluded.backing_left_property, backing_right_property=excluded.backing_right_property,
          is_system=1, sort_order=excluded.sort_order
      `);
      for (const l of [...BOOT_LINK_TYPES, ...BUSINESS_LINKS,...RUNTIME_LINKS]) {
        upsertLink.run({
          api_name: l.apiName,
          title: l.title,
          left_type: l.leftType,
          right_type: l.rightType,
          cardinality: l.cardinality,
          left_link_name: l.leftLinkName,
          right_link_name: l.rightLinkName,
          fk_column: l.fkColumn ?? null,
          on_delete: l.onDelete ?? null,
          discriminator_column: l.discriminatorColumn ?? null,
          discriminator_value: l.discriminatorValue ?? null,
          ref_column: l.refColumn ?? null,
          link_table: l.linkTable ?? null,
          backing_left_property: l.backingLeftProperty ?? null,
          backing_right_property: l.backingRightProperty ?? null,
          sort_order: l.sortOrder,
          created_at: now,
        });
      }
      for (const l of BUSINESS_LINKS) db.prepare('UPDATE ont_link_types SET config=? WHERE api_name=?').run(JSON.stringify({referenceKind:l.referenceKind,backingTableName:l.backingTableName}),l.apiName);
      const upsertAction = db.prepare(`
        INSERT INTO ont_action_types (api_name,title,description,is_builtin,status,parameters,operations,sort_order,created_at,updated_at)
        VALUES (@api_name,@title,@description,1,@status,@parameters,@operations,@sort_order,@created_at,@updated_at)
        ON CONFLICT(api_name) DO UPDATE SET title=excluded.title, description=excluded.description, is_builtin=1,
          parameters=excluded.parameters, operations=excluded.operations, sort_order=excluded.sort_order, updated_at=excluded.updated_at
      `);
      for (const a of COMMAND_DEFS.map(commandMetadata)) {
        const conflict = db.prepare('SELECT is_builtin FROM ont_action_types WHERE api_name=?').get(a.apiName);
        if (conflict && !Number(conflict.is_builtin)) throw new Error(`动作名称冲突：${a.apiName}`);
        // builtin 动作的启停（status）是用户态设置：插入时用默认值，冲突更新时不动 status
        upsertAction.run({
          api_name: a.apiName,
          title: a.title,
          description: a.description ?? '',
          status: a.status,
          parameters: JSON.stringify(a.parameters),
          operations: JSON.stringify(a.operations),
          sort_order: a.sortOrder,
          created_at: now,
          updated_at: now,
        });
      }
    });
  };

  // ---------- 加载 ----------

  const listObjectTypes = (): ObjectTypeDef[] =>
    db.prepare('SELECT * FROM ont_object_types ORDER BY is_virtual, sort_order, api_name').all().map(rowToObject);

  const getObjectType = (apiName: string): ObjectTypeDef => {
    const row = db.prepare('SELECT * FROM ont_object_types WHERE api_name = ?').get(apiName);
    if (!row) throw new Error(`对象类型 ${apiName} 不存在`);
    return rowToObject(row);
  };

  const findObjectType = (apiName: string): ObjectTypeDef | null => {
    const row = db.prepare('SELECT * FROM ont_object_types WHERE api_name = ?').get(apiName);
    return row ? rowToObject(row) : null;
  };

  const listLinkTypes = (): LinkTypeDef[] =>
    db.prepare('SELECT * FROM ont_link_types ORDER BY sort_order, api_name').all().map(rowToLink);

  const listActionTypes = (): ActionTypeDef[] =>
    db.prepare('SELECT * FROM ont_action_types ORDER BY sort_order, api_name').all().map(row=>decorateAction(rowToAction(row)));

  const getActionType = (apiName: string): ActionTypeDef => {
    const row = db.prepare('SELECT * FROM ont_action_types WHERE api_name = ?').get(apiName);
    if (!row) throw new Error(`动作类型 ${apiName} 不存在`);
    return decorateAction(rowToAction(row));
  };
  const getTemplateAction = (kind: ActionTemplateDef['targetKind'], name: string, operation: ActionTemplateDef['operation']): ActionTypeDef => {
    const row = db.prepare('SELECT action_name FROM ont_action_templates WHERE target_kind=? AND target_name=? AND operation=?').get(kind, name, operation);
    if (!row) throw new OntologyError('WRITE_REQUIRES_ACTION', '未启用对应基础动作，请使用已定义的业务或自定义动作');
    return getActionType(String(row.action_name));
  };

  // ---------- 校验（运行时元数据校验） ----------

  /** bootstrap/元数据定义 ↔ 物理表结构 双向校验，漂移直接抛错（开发期发现问题） */
  const validateAgainstSchema = (): void => {
    for (const t of listObjectTypes()) {
      if (t.isVirtual || !t.tableName) continue;
      const cols = db.prepare(`PRAGMA table_info(${JSON.stringify(t.tableName)})`).all().map((c) => String(c.name));
      if (cols.length === 0) throw new Error(`对象类型 ${t.apiName} 的物理表 ${t.tableName} 不存在`);
      const defined = t.properties.map((p) => p.apiName);
      for (const p of t.properties) {
        if (!cols.includes(p.apiName)) throw new Error(`对象类型 ${t.apiName} 的属性 ${p.apiName} 在表 ${t.tableName} 中没有对应列`);
      }
      const missing = cols.filter((c) => !defined.includes(c));
      if (missing.length > 0) throw new Error(`表 ${t.tableName} 存在未纳入定义的列：${missing.join(', ')}（请在 bootstrap 中补齐）`);
    }
    validateLinks(listObjectTypes(), listLinkTypes());
    validateActions(listObjectTypes(), listLinkTypes(), listActionTypes().filter(a=>!a.needsReview));
  };

  const validateAll = (): void => validateAgainstSchema();

  const validateLinks = (objects: ObjectTypeDef[], links: LinkTypeDef[]): void => {
    const byName = new Map(objects.map((o) => [o.apiName, o]));
    for (const l of links) {
      const left = byName.get(l.leftType);
      const right = byName.get(l.rightType);
      if (!left || !right) throw new Error(`链接 ${l.apiName} 引用了不存在的对象类型`);
      if (l.fkColumn) {
        const fkProp = right.properties.find((p) => p.apiName === l.fkColumn);
        if (!fkProp) throw new Error(`链接 ${l.apiName} 的外键属性 ${l.fkColumn} 不在 ${l.rightType} 上`);
        const leftPk = left.properties.find((p) => p.apiName === left.primaryKey);
        if (!leftPk) throw new Error(`链接 ${l.apiName} 的左类型 ${l.leftType} 缺少主键属性`);
        if (fkProp.dataType !== leftPk.dataType) {
          throw new Error(`链接 ${l.apiName} 的外键类型不匹配：${l.fkColumn}(${fkProp.dataType}) vs ${l.leftType}.${left.primaryKey}(${leftPk.dataType})`);
        }
      }
      if (l.discriminatorColumn) {
        const d = right.properties.find((p) => p.apiName === l.discriminatorColumn);
        if (!d) throw new Error(`链接 ${l.apiName} 的判别属性 ${l.discriminatorColumn} 不在 ${l.rightType} 上`);
        const refProp = right.properties.find((p) => p.apiName === l.refColumn);
        if (!refProp) throw new Error(`链接 ${l.apiName} 缺少引用属性 ${l.refColumn}`);
      }
      if (l.cardinality === 'many_to_many' && !l.backingTableName) {
        const backing = byName.get(l.linkTable ?? '');
        if (!backing || !backing.tableName) throw new Error(`链接 ${l.apiName} 的中间表类型 ${l.linkTable} 不存在`);
        const lp = backing.properties.find((p) => p.apiName === l.backingLeftProperty);
        const rp = backing.properties.find((p) => p.apiName === l.backingRightProperty);
        if (!lp || !rp) throw new Error(`链接 ${l.apiName} 的中间表引用属性不完整`);
        if (l.backingLeftProperty === l.backingRightProperty) throw new Error(`链接 ${l.apiName} 的左右引用属性不能相同`);
      }
    }
  };

  const validateActions = (objects: ObjectTypeDef[], links: LinkTypeDef[], actions: ActionTypeDef[]): void => {
    const byName = new Map(objects.map((o) => [o.apiName, o]));
    const linkByName = new Map(links.map((l) => [l.apiName, l]));
    const actionNames = new Set(actions.map((a) => a.apiName));
    void actionNames;
    for (const a of actions) {
      const paramNames = a.parameters.map((p) => p.name);
      for (const p of a.parameters) {
        if (!PROP_NAME_RE.test(p.name)) throw new Error(`动作 ${a.apiName} 的参数名 ${p.name} 不合法`);
      }
      if (new Set(paramNames).size !== paramNames.length) throw new Error(`动作 ${a.apiName} 的参数名重复`);
      if (a.operations.length > 50) throw new Error('动作最多 50 个步骤');
      for (const [index, op] of a.operations.entries()) {
        validateOperation(a.apiName, op, paramNames, byName, linkByName, index);
      }
    }
  };

  const validateOperation = (
    actionApiName: string,
    op: ActionOperation,
    paramNames: string[],
    byName: Map<string, ObjectTypeDef>,
    linkByName: Map<string, LinkTypeDef>,
    step: number,
  ): void => {
    if (!['create_object', 'modify_object', 'delete_object', 'create_link', 'delete_link', 'invoke_command'].includes(op.kind)) throw new Error('不支持的动作操作');
    const validateMapping = (mapping: ValueMapping): void => {
      if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) || Object.keys(mapping).length !== 1) throw new Error('值映射须且只能声明一种来源');
      if ('source' in mapping) {
        if (!mapping.source || Object.keys(mapping.source).some(key => key !== 'parameter') || !paramNames.includes(mapping.source.parameter)) throw new Error('值映射引用了未声明的参数');
      } else if ('fn' in mapping) {
        if (!['now', 'uuid'].includes(mapping.fn)) throw new Error('不支持的内建函数');
      } else if ('result' in mapping) {
        const ref = mapping.result;
        if (!ref || Object.keys(ref).some(key => !['step', 'path'].includes(key)) || !Number.isSafeInteger(ref.step) || ref.step < 0 || ref.step >= step || !Array.isArray(ref.path) || !ref.path.length || ref.path.length > 8 || ref.path.some(key => typeof key !== 'string' || !/^[a-zA-Z0-9_]+$/.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error('步骤结果只能引用之前步骤的有界安全路径');
      } else if (!('literal' in mapping)) throw new Error('值映射来源无效');
    };
    if (op.kind === 'invoke_command') {
      const command = COMMAND_DEFS.find(d => d.apiName === op.command);
      if (!command || !COMPOSABLE_COMMANDS.has(op.command) || command.human) throw new Error('ACTION_NOT_COMPOSABLE：该命令不允许进入数据库组合动作');
      if (!op.params || typeof op.params !== 'object' || Array.isArray(op.params)) throw new Error('命令参数须为映射对象');
      for (const [name, mapping] of Object.entries(op.params)) {
        if (!command.parameters.some(p => p.name === name)) throw new Error(`命令未知参数 ${name}`);
        validateMapping(mapping);
      }
      for (const p of command.parameters) if (p.required && !Object.hasOwn(op.params, p.name)) throw new Error(`命令缺少必填参数 ${p.name}`);
    } else if (op.kind === 'create_object' || op.kind === 'modify_object') {
      if (!op.propertyMappings || typeof op.propertyMappings !== 'object') throw new Error('属性映射须为对象');
      Object.values(op.propertyMappings).forEach(validateMapping);
      if (op.kind === 'modify_object') validateMapping(op.selector.value);
    } else if (op.kind === 'delete_object') validateMapping(op.selector.value);
    else { validateMapping(op.leftId); validateMapping(op.rightId); }
    if (op.kind === 'create_object' || op.kind === 'modify_object') {
      const t = byName.get(op.objectType);
      if (!t || !t.tableName) throw new Error(`动作 ${actionApiName} 引用了不存在的对象类型 ${op.objectType}`);
      for (const key of Object.keys(op.propertyMappings)) {
        if (!t.properties.some((p) => p.apiName === key)) throw new Error(`动作 ${actionApiName} 映射了不存在的属性 ${op.objectType}.${key}`);
      }
      if (op.kind === 'modify_object') {
        if (!t.properties.some((p) => p.apiName === op.selector.property)) {
          throw new Error(`动作 ${actionApiName} 的筛选属性 ${op.objectType}.${op.selector.property} 不存在`);
        }
      }
    } else if (op.kind === 'delete_object') {
      const t = byName.get(op.objectType);
      if (!t || !t.tableName) throw new Error(`动作 ${actionApiName} 引用了不存在的对象类型 ${op.objectType}`);
      if (!t.properties.some((p) => p.apiName === op.selector.property)) {
        throw new Error(`动作 ${actionApiName} 的筛选属性 ${op.objectType}.${op.selector.property} 不存在`);
      }
    } else if (op.kind !== 'invoke_command') {
      const l = linkByName.get(op.linkType);
      if (!l) throw new Error(`动作 ${actionApiName} 引用了不存在的链接类型 ${op.linkType}`);
      if (!l.fkColumn && !l.linkTable) throw new Error(`动作 ${actionApiName} 的链接 ${op.linkType} 是多态链接，请改用 create_object`);
    }
  };

  // ---------- 对象类型管理 ----------

  const createObjectType = (input: CreateObjectTypeInput): ObjectTypeDef => {
    const apiName = assertApiName(input.apiName, '对象类型 apiName');
    if (findObjectType(apiName)) throw new Error(`对象类型 ${apiName} 已存在`);
    if (db.prepare('SELECT 1 FROM sqlite_master WHERE type=\'table\' AND name = ?').get(customTableName(apiName))) {
      throw new Error(`物理表 ${customTableName(apiName)} 已存在`);
    }
    const title = String(input.title ?? '').trim();
    if (!title) throw new Error('显示名不能为空');

    const builtinProps: PropertyDef[] = [
      { apiName: 'id', dataType: 'string', nullable: false, isPrimaryKey: true, origin: 'builtin' },
      { apiName: 'created_at', dataType: 'date', nullable: false, origin: 'builtin' },
      { apiName: 'updated_at', dataType: 'date', nullable: false, origin: 'builtin' },
    ];
    const userProps = (input.properties ?? []).map((p) => checkPropertyInput(p, [...builtinProps.map((b) => b.apiName)]));
    // 逐个查重（checkPropertyInput 只对比已知的）
    const seen = new Set(builtinProps.map((b) => b.apiName));
    for (const p of userProps) {
      if (seen.has(p.apiName)) throw new Error(`属性 ${p.apiName} 已存在`);
      seen.add(p.apiName);
    }
    const props = [...builtinProps, ...userProps];
    const titleProperty = input.titleProperty ?? userProps[0]?.apiName;
    if (!titleProperty || !props.some((p) => p.apiName === titleProperty)) {
      throw new Error('标题属性必须取自类型属性');
    }

    const tableName = customTableName(apiName);
    const now = nowIso();
    inTx(db, () => {
      createCustomObjectTable(db, tableName, userProps);
      db.prepare(`
        INSERT INTO ont_object_types (api_name,title,description,table_name,is_virtual,is_system,primary_key,title_property,properties,status,sort_order,created_at,updated_at)
        VALUES (?,?,?,?,0,0,'id',?,?,'active',100,?,?)
      `).run(apiName, title, input.description?.trim() ?? '', tableName, titleProperty, JSON.stringify(props), now, now);
      if (input.generateActions !== undefined && typeof input.generateActions !== 'boolean') throw new Error('generateActions 须为布尔值');
      db.prepare('INSERT INTO ont_template_preferences(object_type,enabled) VALUES(?,?)').run(apiName, input.generateActions === false ? 0 : 1);
      syncTemplates();
    });
    return getObjectType(apiName);
  };

  const updateObjectType = (apiName: string, patch: UpdateObjectTypeInput): ObjectTypeDef => {
    return inTx(db, () => updateObjectTypeInTx(apiName, patch));
  };
  const updateObjectTypeInTx = (apiName: string, patch: UpdateObjectTypeInput): ObjectTypeDef => {
    const def = getObjectType(apiName);
    if (objectPolicy(apiName,def.isSystem,def.isVirtual).writeMode === 'read_only' && patch.addProperties?.length) throw new Error('只读对象不允许追加扩展字段');
    const next = { ...def };
    if (patch.title !== undefined) {
      const t = patch.title.trim();
      if (!t) throw new Error('显示名不能为空');
      next.title = t;
    }
    if (patch.description !== undefined) next.description = patch.description.trim();
    // 先做全部校验，再动 DDL/元数据，保证失败时不留半套变更
    let added: PropertyDef[] = [];
    if (patch.addProperties?.length) {
      added = patch.addProperties.map((p) => checkPropertyInput(p, next.properties.map((x) => x.apiName)));
      for (const p of added) {
        // 系统类型加列必须 nullable（ALTER ADD COLUMN 的安全子集）
        if (def.isSystem && p.nullable === false) throw new Error(`系统类型只能追加可空属性：${p.apiName}`);
      }
    }
    if (patch.dropProperty) {
      const target = next.properties.find((p) => p.apiName === patch.dropProperty);
      if (!target) throw new Error(`属性 ${patch.dropProperty} 不存在`);
      if (target.origin === 'builtin') throw new Error(`内置属性 ${patch.dropProperty} 受保护，不可删除`);
      assertPropertyDroppable(apiName, patch.dropProperty);
      next.properties = next.properties.filter((p) => p.apiName !== target.apiName);
      if (next.titleProperty === target.apiName) {
        const fallback = next.properties.find((p) => p.origin === 'user') ?? next.properties.find((p) => p.apiName === 'id');
        next.titleProperty = fallback!.apiName;
      }
    }
    if (patch.titleProperty !== undefined) {
      if (!next.properties.some((p) => p.apiName === patch.titleProperty)) throw new Error('标题属性必须取自类型属性');
      next.titleProperty = patch.titleProperty;
    }
    next.properties.push(...added);
    // 提交：先 DDL 再元数据（元数据以一次 UPDATE 落盘）
    for (const p of added) addObjectColumn(db, def.tableName!, p);
    if (patch.dropProperty) dropObjectColumn(db, def.tableName!, patch.dropProperty);
    db.prepare('UPDATE ont_object_types SET title=?, description=?, title_property=?, properties=?, updated_at=? WHERE api_name=?').run(
      next.title,
      next.description,
      next.titleProperty,
      JSON.stringify(next.properties),
      nowIso(),
      apiName,
    );
    validateAgainstSchema();
    syncTemplates();
    return getObjectType(apiName);
  };

  const assertPropertyDroppable = (apiName: string, propName: string): void => {
    for (const l of listLinkTypes()) {
      if (l.fkColumn === propName && l.rightType === apiName) throw new Error(`属性 ${propName} 被链接 ${l.apiName} 用作外键，先删链接`);
      if (l.backingLeftProperty === propName && l.linkTable === apiName) throw new Error(`属性 ${propName} 被链接 ${l.apiName} 用作中间表引用，先删链接`);
      if (l.backingRightProperty === propName && l.linkTable === apiName) throw new Error(`属性 ${propName} 被链接 ${l.apiName} 用作中间表引用，先删链接`);
    }
    for (const a of listActionTypes()) {
      for (const op of a.operations) {
        if ('objectType' in op && op.objectType === apiName && (('propertyMappings' in op && Object.keys(op.propertyMappings ?? {}).includes(propName)) || ('selector' in op && op.selector.property === propName))) {
          throw new Error(`属性 ${propName} 被动作 ${a.apiName} 引用，先删动作`);
        }
      }
    }
  };

  const deleteObjectType = (apiName: string): void => {
    const def = getObjectType(apiName);
    if (def.isSystem) throw new Error(`系统类型 ${apiName} 不可删除`);
    const refLinks = listLinkTypes().filter((l) => l.leftType === apiName || l.rightType === apiName || l.linkTable === apiName);
    if (refLinks.length > 0) throw new Error(`仍有链接引用该类型：${refLinks.map((l) => l.apiName).join('、')}，请先删除`);
    const refActions = listActionTypes().filter((a) =>
      a.operations.some((op) => ('objectType' in op && op.objectType === apiName) || ('linkType' in op && op.linkType && refLinks.some((l) => l.apiName === op.linkType))),
    );
    if (refActions.length > 0) throw new Error(`仍有动作引用该类型：${refActions.map((a) => a.apiName).join('、')}，请先删除`);
    inTx(db, () => {
      db.prepare("DELETE FROM ont_action_types WHERE api_name IN (SELECT action_name FROM ont_action_templates WHERE target_kind='object' AND target_name=?)").run(apiName);
      dropObjectTable(db, def.tableName!);
      db.prepare('DELETE FROM ont_object_types WHERE api_name = ?').run(apiName);
    });
  };

  // ---------- 链接类型管理 ----------

  const createLinkType = (input: CreateLinkTypeInput): LinkTypeDef => inTx(db,()=>createLinkTypeInTx(input));
  const createLinkTypeInTx = (input: CreateLinkTypeInput): LinkTypeDef => {
    const apiName = assertApiName(input.apiName, '链接 apiName');
    if (db.prepare('SELECT 1 FROM ont_link_types WHERE api_name = ?').get(apiName)) throw new Error(`链接 ${apiName} 已存在`);
    const left = getObjectType(input.leftType);
    const right = getObjectType(input.rightType);
    if (left.isVirtual || right.isVirtual) throw new Error('虚拟类型不能建用户链接');
    if (left.apiName === right.apiName && input.cardinality !== 'many_to_many') {
      throw new Error('自反链接 v1 仅支持多对多（经中间表）');
    }
    const leftPk = left.properties.find((p) => p.apiName === left.primaryKey)!;

    let fkColumn: string | undefined;
    let linkTable: string | undefined;
    let backingLeftProperty: string | undefined;
    let backingRightProperty: string | undefined;
    if (input.cardinality === 'many_to_many') {
      const backing = getObjectType(input.linkTable ?? '');
      if (!backing.tableName) throw new Error('中间表必须是实体对象类型');
      backingLeftProperty = input.backingLeftProperty;
      backingRightProperty = input.backingRightProperty;
      const lp = backing.properties.find((p) => p.apiName === backingLeftProperty);
      const rp = backing.properties.find((p) => p.apiName === backingRightProperty);
      if (!lp || !rp) throw new Error('中间表的左右引用属性必须已存在');
      if (backingLeftProperty === backingRightProperty) throw new Error('左右引用属性不能相同');
      if (lp.dataType !== leftPk.dataType || rp.dataType !== right.properties.find((p) => p.apiName === right.primaryKey)!.dataType) {
        throw new Error('中间表引用属性的类型须与左右主键一致');
      }
      linkTable = backing.apiName;
    } else {
      fkColumn = input.fkColumn;
      if (!fkColumn) throw new Error('一对一/一对多链接必须指定外键属性');
      const fkProp = right.properties.find((p) => p.apiName === fkColumn);
      if (!fkProp) throw new Error(`外键属性 ${fkColumn} 不在 ${right.apiName} 上，请先在对象类型上添加该属性`);
      if (fkProp.dataType !== leftPk.dataType) throw new Error('外键属性类型须与左侧主键一致');
    }

    if (input.cardinality === 'many_to_many') {
      const backing=getObjectType(linkTable!);
      if (backing.isSystem) throw new Error('中间表必须为自定义对象类型');
    } else {
      const prop=right.properties.find(p=>p.apiName===fkColumn)!;
      if(right.isSystem && prop.origin!=='user') throw new Error('系统内置关联字段须通过业务动作维护');
      if(input.onDelete==='set_null' && !prop.nullable) throw new Error('置空策略要求可空字段');
    }
    if(input.onDelete==='cascade')throw new Error('自定义关系不支持级联删除实体');
    if(listLinkTypes().some(l=> (l.rightType===right.apiName&&l.fkColumn===fkColumn&&!!fkColumn)||(!!linkTable&&l.linkTable===linkTable)))throw new Error('承载字段或中间表已被其他关系使用');
    db.prepare(`
      INSERT INTO ont_link_types (api_name,title,left_type,right_type,cardinality,left_link_name,right_link_name,fk_column,on_delete,discriminator_column,discriminator_value,link_table,backing_left_property,backing_right_property,is_system,sort_order,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,?,0,100,?)
    `).run(
      apiName,
      String(input.title ?? '').trim() || apiName,
      left.apiName,
      right.apiName,
      input.cardinality,
      input.leftLinkName?.trim() || null,
      input.rightLinkName?.trim() || null,
      fkColumn ?? null,
      input.cardinality==='many_to_many'?'cascade':input.onDelete ?? 'restrict',
      linkTable ?? null,
      backingLeftProperty ?? null,
      backingRightProperty ?? null,
      nowIso(),
    );
    validateAgainstSchema();
    syncRelationConstraints(db,listObjectTypes(),listLinkTypes(),apiName);
    syncTemplates();
    const all = listLinkTypes();
    return all.find((l) => l.apiName === apiName)!;
  };

  const deleteLinkType = (apiName: string): void => inTx(db,()=>deleteLinkTypeInTx(apiName));
  const deleteLinkTypeInTx = (apiName: string): void => {
    const row = db.prepare('SELECT * FROM ont_link_types WHERE api_name = ?').get(apiName);
    if (!row) throw new Error(`链接 ${apiName} 不存在`);
    if (Number(row.is_system) === 1) throw new Error(`系统链接 ${apiName} 不可删除`);
    const refActions = listActionTypes().filter((a) => a.operations.some((op) => 'linkType' in op && op.linkType === apiName));
    if (refActions.length > 0) throw new Error(`仍有动作引用该链接：${refActions.map((a) => a.apiName).join('、')}，请先删除`);
    dropRelationConstraints(db,apiName);
    db.prepare("DELETE FROM ont_action_types WHERE api_name IN (SELECT action_name FROM ont_action_templates WHERE target_kind='link' AND target_name=?)").run(apiName);
    db.prepare('DELETE FROM ont_link_types WHERE api_name = ?').run(apiName);
  };

  // ---------- 动作类型管理 ----------

  const createActionType = (input: CreateActionTypeInput): ActionTypeDef => {
    const apiName = assertApiName(input.apiName, '动作 apiName');
    if (db.prepare('SELECT 1 FROM ont_action_types WHERE api_name = ?').get(apiName)) throw new Error(`动作 ${apiName} 已存在`);
    const title = String(input.title ?? '').trim();
    if (!title) throw new Error('显示名不能为空');
    const parameters = (input.parameters ?? []).map((p, i) => {
      const name = String(p.name ?? '').trim();
      if (!PROP_NAME_RE.test(name)) throw new Error(`第 ${i + 1} 个参数名不合法`);
      const dataTypes = ['string', 'integer', 'float', 'boolean', 'date', 'json'];
      if (!dataTypes.includes(p.dataType ?? '')) throw new Error(`参数 ${name} 的类型不合法`);
      if (p.jsonSchema !== undefined) validateActionSchema(p.jsonSchema);
      if (p.objectType && getObjectType(p.objectType).isVirtual) throw new Error('对象参数不能引用虚拟类型');
      return { name, dataType: p.dataType as never, required: p.required ?? false, defaultValue: p.defaultValue, description: p.description, jsonSchema: p.jsonSchema, objectType: p.objectType };
    });
    const operations = input.operations ?? [];
    const now = nowIso();
    const def: ActionTypeDef = {
      apiName,
      title,
      description: input.description?.trim() ?? '',
      isBuiltin: false,
      status: 'active',
      parameters,
      operations,
      sortOrder: 100,
      createdAt: now,
      updatedAt: now,
    };
    // 先整体校验再落库，失败不留半条记录
    validateActions(listObjectTypes(), listLinkTypes(), [def]);
    assertActionWritable(def);
    db.prepare(`
      INSERT INTO ont_action_types (api_name,title,description,is_builtin,status,parameters,operations,sort_order,created_at,updated_at)
      VALUES (?,?,?,0,'active',?,?,100,?,?)
    `).run(apiName, title, def.description, JSON.stringify(parameters), JSON.stringify(operations), now, now);
    return getActionType(apiName);
  };

  const updateActionType = (apiName: string, patch: UpdateActionTypeInput): ActionTypeDef => {
    const def = getActionType(apiName);
    if (patch.title !== undefined) {
      const t = patch.title.trim();
      if (!t) throw new Error('显示名不能为空');
      db.prepare('UPDATE ont_action_types SET title=? WHERE api_name=?').run(t, apiName);
    }
    if (patch.description !== undefined) {
      db.prepare('UPDATE ont_action_types SET description=? WHERE api_name=?').run(patch.description.trim(), apiName);
    }
    if (patch.status !== undefined) {
      if (!['active', 'disabled'].includes(patch.status)) throw new Error('状态取值不合法');
      db.prepare('UPDATE ont_action_types SET status=? WHERE api_name=?').run(patch.status, apiName);
    }
    db.prepare('UPDATE ont_action_types SET updated_at=? WHERE api_name=?').run(nowIso(), apiName);
    void def;
    return getActionType(apiName);
  };

  const decorateAction = (def:ActionTypeDef): ActionTypeDef => {
    const template = db.prepare('SELECT * FROM ont_action_templates WHERE action_name=?').get(def.apiName);
    if (template) {
      def.template = { targetKind: template.target_kind as ActionTemplateDef['targetKind'], targetName: String(template.target_name), operation: template.operation as ActionTemplateDef['operation'], version: Number(template.template_version), schemaDigest: String(template.schema_digest) };
      def.targetBindings = def.template.targetKind === 'object' ? [{ objectType: def.template.targetName, ...(def.template.operation === 'create' ? {} : { parameter: 'id' }) }]
        : def.parameters.filter(p => p.objectType).map(p => ({ objectType: p.objectType!, parameter: p.name }));
    } else if (!def.isBuiltin) {
      // 纯业务命令组合也应出现在目标对象的动作列表中。
      def.targetBindings = def.operations.flatMap(op => op.kind === 'invoke_command'
        ? COMMAND_DEFS.find(command => command.apiName === op.command)?.targetBindings.map(binding => {
          const mapping = binding.parameter ? op.params[binding.parameter] : undefined;
          return { objectType: binding.objectType, ...((mapping && 'source' in mapping) ? { parameter: mapping.source.parameter } : {}) };
        }) ?? [] : []);
    }
    if(!def.isBuiltin)try {validateActions(listObjectTypes(),listLinkTypes(),[def]);assertActionWritable(def);}catch{def.needsReview=true;}
    return def;
  };

  const assertActionWritable = (def: ActionTypeDef): void => {
    for (const op of def.operations) {
      if ('objectType' in op) {
        const t=getObjectType(op.objectType);
        if(op.kind==='modify_object')for(const l of listLinkTypes()){const cols=l.rightType===t.apiName&&l.fkColumn?[l.fkColumn]:l.linkTable===t.apiName?[l.backingLeftProperty!,l.backingRightProperty!]:[];if(cols.some(col=>Object.hasOwn(op.propertyMappings,col)))throw new OntologyError('LINK_REQUIRES_OPERATION','关联字段请使用关系操作');}
        assertObjectWrite(t,op.kind === 'create_object' ? 'create' : op.kind === 'delete_object' ? 'delete' : 'update','propertyMappings' in op ? op.propertyMappings : {});
      }
    }
  };

  const deleteActionType = (apiName: string): void => {
    const def = getActionType(apiName);
    if (def.isBuiltin || def.template) throw new Error(`内置或基础动作 ${apiName} 不可删除，可停用；删除其类型时自动清理基础动作`);
    db.prepare('DELETE FROM ont_action_types WHERE api_name = ?').run(apiName);
  };

  return {
    init,
    syncBootstrap,
    listObjectTypes,
    getObjectType,
    findObjectType,
    listLinkTypes,
    listActionTypes,
    getActionType,
    getTemplateAction,
    assertActionWritable,
    validateAgainstSchema,
    createObjectType,
    updateObjectType,
    deleteObjectType,
    createLinkType,
    deleteLinkType,
    createActionType,
    updateActionType,
    deleteActionType,
  };
}

export type OntologyService = ReturnType<typeof createOntologyService>;
