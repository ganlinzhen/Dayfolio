// 元数据驱动的只读查询：所有入口共用验证、字段策略、值转换和 SQL 编译。
import { readSnapshot, type DbAdapter } from '../db';
import { ensureValidDateStr } from '../utils/date';
import { quoteIdent as q } from './ddl';
import { OntologyError } from './policy';
import type { OntologyService } from './registry';
import type { ObjectTypeDef, PropertyDef } from './types';
import { createCursorCodec, type CursorValue } from './query-cursor';
import { valueHash } from './canonical';

export const QUERY_LIMITS = Object.freeze({ pageSize: 500, defaultPageSize: 50, relationPageSize: 200,
  depth: 5, conditions: 50, inValues: 500, parameters: 900, sortFields: 3, groupFields: 2, metrics: 8 });

export type QueryRow = Record<string, unknown>;
export interface QueryPage { limit: number; offset: number; hasMore: boolean; mode?: 'cursor'; nextCursor?: string; }
export interface QueryResult { contractVersion: 1; rows: QueryRow[]; page: QueryPage; total?: number; }
export interface AggregateResult { contractVersion: 1; rows: Array<{ dimensions: QueryRow; metrics: QueryRow }>;
  objectCount: number; groupCount: number; page: QueryPage; }
export type DateSemantics = 'date' | 'local_datetime' | 'instant';
type RecordValue = Record<string, unknown>;
interface QueryContext { params: unknown[]; conditions: number; aliases: number; checks: Map<string, { def: ObjectTypeDef; p: PropertyDef }>; }
interface PreparedQuery { input: RecordValue; def: ObjectTypeDef; where: string; context: QueryContext; }
interface SortField { p: PropertyDef; expression: string; direction: 'ASC' | 'DESC'; nulls: 'FIRST' | 'LAST'; }

const fail = (message: string, code = 'QUERY_INVALID'): never => { throw new OntologyError(code, message); };
const record = (value: unknown, label: string): RecordValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail(`${label}须为普通对象`);
  return value as RecordValue;
};
const keys = (value: RecordValue, allowed: string[], label: string) => {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label}存在未知字段 ${key}`);
};
const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) return fail(`${label}须为非空文本且不超过 4096 字符`);
  return value;
};
const integer = (value: unknown, fallback: number, min: number, max: number, label: string): number => {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return fail(`${label}须为 ${min}—${max} 的整数`);
  return value;
};

/** 旧本地时间戳不假装带有时区；发布时间使用既有归一化时刻字段。 */
const dateSemantics = (def: ObjectTypeDef, p: PropertyDef): DateSemantics => {
  if (def.apiName === 'news_item' && p.apiName === 'published_at') return 'instant';
  return p.origin === 'builtin' && /_at$/.test(p.apiName) ? 'local_datetime' : 'date';
};

const dateValue = (def: ObjectTypeDef, p: PropertyDef, value: string): string => {
  try { ensureValidDateStr(value.slice(0, 10)); } catch { return fail(`${def.apiName}.${p.apiName}不是有效日期`); }
  const kind = dateSemantics(def, p);
  if (kind === 'date') {
    if (value.length !== 10) return fail(`${p.apiName}按日期查询，须为 YYYY-MM-DD`);
    return value;
  }
  const pattern = kind === 'instant'
    ? /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/
    : /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?$/;
  if (!pattern.test(value) || (kind === 'instant' && !Number.isFinite(Date.parse(value)))) return fail(`${p.apiName}须为${kind === 'instant' ? '带时区的 ISO 时刻' : '不含时区的本地时间戳'}`);
  return kind === 'instant' ? new Date(value).toISOString() : value.includes('.') ? value.padEnd(value.indexOf('.') + 4, '0') : `${value}.000`;
};

export function createQueryService(db: DbAdapter, ontology: OntologyService) {
  const cursorCodec = createCursorCodec(db);
  const type = (name: unknown): ObjectTypeDef => {
    const def = ontology.findObjectType(text(name, '对象类型'));
    if (!def) return fail('对象类型不存在', 'OBJECT_TYPE_NOT_FOUND');
    if (def.isVirtual || !def.tableName) return fail('虚拟类型没有普通实例查询，请使用对应业务读取', 'QUERY_UNSUPPORTED');
    return def;
  };
  const property = (def: ObjectTypeDef, name: unknown): PropertyDef => {
    const p = def.properties.find(p => p.apiName === text(name, '属性名'));
    if (!p) return fail(`对象类型 ${def.apiName} 没有该属性`);
    if (p.readable === false) return fail('不可读字段不能用于查询', 'FIELD_NOT_READABLE');
    return p;
  };
  const column = (def: ObjectTypeDef, p: PropertyDef, alias: string): string => {
    const raw = `${alias}.${q(p.apiName)}`;
    return p.dataType === 'date' && dateSemantics(def, p) === 'instant' ? `julianday(${raw})` : raw;
  };
  const bindValue = (def: ObjectTypeDef, p: PropertyDef, raw: unknown): unknown => {
    switch (p.dataType) {
      case 'boolean': if (typeof raw !== 'boolean') return fail(`${p.apiName}须为布尔值`); return raw ? 1 : 0;
      case 'integer': if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) return fail(`${p.apiName}须为安全整数`); return raw;
      case 'float': if (typeof raw !== 'number' || !Number.isFinite(raw)) return fail(`${p.apiName}须为有限数字`); return raw;
      case 'date': return dateValue(def, p, text(raw, p.apiName));
      case 'json': return fail('首版不支持 JSON 属性过滤、排序或聚合', 'QUERY_UNSUPPORTED');
      default: if (typeof raw !== 'string') return fail(`${p.apiName}须为文本`); return raw;
    }
  };
  const parameter = (context: QueryContext, value: unknown): string => {
    if (context.params.length >= QUERY_LIMITS.parameters) return fail('查询绑定参数超限');
    context.params.push(value);
    return '?';
  };
  const checkField = (context: QueryContext, def: ObjectTypeDef, p: PropertyDef) => {
    if (!p.isPrimaryKey && ['integer', 'float', 'boolean', 'date'].includes(p.dataType)) context.checks.set(`${def.apiName}.${p.apiName}`, { def, p });
  };
  const validateStorage = (context: QueryContext) => {
    for (const { def, p } of context.checks.values()) {
      const col = q(p.apiName);
      let invalid: string;
      if (p.dataType === 'boolean') invalid = `${col} NOT IN (0,1) OR typeof(${col}) NOT IN ('integer','real')`;
      else if (p.dataType === 'integer') invalid = `typeof(${col})!='integer' OR abs(CAST(${col} AS REAL))>9007199254740991`;
      else if (p.dataType === 'float') invalid = `typeof(${col}) NOT IN ('integer','real') OR abs(${col})>1.7976931348623157e308`;
      else {
        const kind = dateSemantics(def, p);
        const date = '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]';
        const invalidClock = `date(substr(${col},1,10),'+0 days')!=substr(${col},1,10) OR substr(${col},12,2) NOT BETWEEN '00' AND '23' OR substr(${col},15,2) NOT BETWEEN '00' AND '59' OR substr(${col},18,2) NOT BETWEEN '00' AND '59'`;
        if (kind === 'date') invalid = `typeof(${col})!='text' OR ${col} NOT GLOB '${date}' OR date(${col},'+0 days')!=${col}`;
        else if (kind === 'local_datetime') invalid = `typeof(${col})!='text' OR ${col} NOT GLOB '${date}T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]' OR julianday(${col}) IS NULL OR ${invalidClock}`;
        else invalid = `typeof(${col})!='text' OR ${col} NOT GLOB '${date}T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*' OR julianday(${col}) IS NULL OR NOT (${col} GLOB '*Z' OR ${col} GLOB '*[+-][0-9][0-9]:[0-9][0-9]') OR ${invalidClock}`;
      }
      if (db.prepare(`SELECT 1 FROM ${q(def.tableName!)} WHERE ${col} IS NOT NULL AND (${invalid}) LIMIT 1`).get()) fail(`${def.apiName}.${p.apiName}存在不符合声明语义的存量值，请先诊断该字段`, 'DATA_VALUE_INVALID');
    }
  };
  const comparison = (left: string, op: unknown, value: unknown, bind: (v: unknown) => string): string => {
    if (op === 'is_null' || op === 'not_null' || ((op === 'eq' || op === 'ne') && value === null)) {
      return `${left} IS ${op === 'not_null' || op === 'ne' ? 'NOT ' : ''}NULL`;
    }
    if (op === 'in') {
      if (!Array.isArray(value) || value.length > QUERY_LIMITS.inValues || value.some(v => v === null)) return fail('in 须为不含 null 的有界数组');
      return value.length ? `${left} IN (${value.map(bind).join(',')})` : '0=1';
    }
    const ops: Record<string, string> = { eq: '=', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };
    if (typeof op !== 'string' || !Object.hasOwn(ops, op) || value === undefined || value === null) return fail('比较操作或值无效');
    return `${left} ${ops[op]} ${bind(value)}`;
  };

  const condition = (def: ObjectTypeDef, raw: unknown, context: QueryContext, alias = 'r', depth = 1): string => {
    if (depth > QUERY_LIMITS.depth || ++context.conditions > QUERY_LIMITS.conditions) return fail('查询条件数量或深度超限');
    const input = record(raw, '条件');
    if (Object.hasOwn(input, 'related')) {
      keys(input, ['related'], '关联条件');
      if (alias !== 'r') return fail('首版关系过滤只允许单跳', 'QUERY_UNSUPPORTED');
      const relation = record(input.related, '关系条件');
      keys(relation, ['linkType', 'side', 'where', 'exists'], '关系条件');
      const link = ontology.listLinkTypes().find(l => l.apiName === text(relation.linkType, '关系名'));
      if (!link) return fail('关系不存在');
      if (relation.side !== 'left' && relation.side !== 'right') return fail('关系方向须为 left 或 right');
      if ((relation.side === 'left' ? link.leftType : link.rightType) !== def.apiName) return fail('关系方向与当前对象类型不匹配');
      if (relation.exists !== undefined && typeof relation.exists !== 'boolean') return fail('exists 须为布尔值');
      const target = type(relation.side === 'left' ? link.rightType : link.leftType);
      const targetAlias = `t${++context.aliases}`;
      const rootKey = property(def, def.primaryKey).apiName;
      const targetKey = property(target, target.primaryKey).apiName;
      const clauses: string[] = [];
      let from = `${q(target.tableName!)} ${targetAlias}`;
      if (link.cardinality === 'many_to_many') {
        const backing = link.linkTable ? type(link.linkTable) : undefined;
        const table = backing?.tableName ?? link.backingTableName;
        const left = link.backingLeftProperty;
        const right = link.backingRightProperty;
        if (!table || !left || !right) return fail('关系承载定义不完整', 'QUERY_UNSUPPORTED');
        if (backing) { property(backing, left); property(backing, right); }
        const edgeAlias = `e${context.aliases}`;
        const sourceColumn = relation.side === 'left' ? left : right;
        const targetColumn = relation.side === 'left' ? right : left;
        from += ` JOIN ${q(table)} ${edgeAlias} ON ${edgeAlias}.${q(targetColumn)}=${targetAlias}.${q(targetKey)}`;
        clauses.push(`${edgeAlias}.${q(sourceColumn)}=r.${q(rootKey)}`);
      } else {
        const fk = link.fkColumn ?? link.refColumn;
        if (!fk) return fail('关系承载定义不完整', 'QUERY_UNSUPPORTED');
        const rightDef = relation.side === 'left' ? target : def;
        property(rightDef, fk);
        const rightAlias = relation.side === 'left' ? targetAlias : 'r';
        clauses.push(relation.side === 'left' ? `${targetAlias}.${q(fk)}=r.${q(rootKey)}` : `${targetAlias}.${q(targetKey)}=r.${q(fk)}`);
        if (link.discriminatorColumn) {
          property(rightDef, link.discriminatorColumn);
          clauses.push(`${rightAlias}.${q(link.discriminatorColumn)}=${parameter(context, link.discriminatorValue)}`);
        }
      }
      if (relation.where !== undefined) clauses.push(condition(target, relation.where, context, targetAlias, depth + 1));
      return `${relation.exists === false ? 'NOT ' : ''}EXISTS (SELECT 1 FROM ${from} WHERE ${clauses.join(' AND ')})`;
    }
    for (const op of ['and', 'or', 'not'] as const) if (Object.hasOwn(input, op)) {
      keys(input, [op], '组合条件');
      if (op === 'not') return `NOT (${condition(def, input.not, context, alias, depth + 1)})`;
      const children = input[op];
      if (!Array.isArray(children) || !children.length) return fail(`${op}须为非空条件数组`);
      return `(${children.map(child => condition(def, child, context, alias, depth + 1)).join(op === 'and' ? ' AND ' : ' OR ')})`;
    }
    keys(input, ['property', 'op', 'value'], '属性条件');
    const p = property(def, input.property);
    checkField(context, def, p);
    const left = column(def, p, alias);
    if (p.dataType === 'boolean' && !['eq', 'ne', 'in', 'is_null', 'not_null'].includes(String(input.op))) return fail('布尔属性不支持范围比较');
    if (input.op === 'contains' || input.op === 'like') {
      if (!['string', 'enum'].includes(p.dataType)) return fail('文本匹配只支持文本或枚举属性');
      let value = text(input.value, '匹配值');
      if (input.op === 'contains') value = value.replace(/[\\%_]/g, '\\$&');
      return `${left} LIKE ${parameter(context, `%${value}%`)}${input.op === 'contains' ? " ESCAPE '\\'" : ''}`;
    }
    if (p.dataType === 'json' && !['is_null', 'not_null'].includes(String(input.op)) && !(['eq', 'ne'].includes(String(input.op)) && input.value === null)) return fail('JSON 属性只支持空值判断', 'QUERY_UNSUPPORTED');
    return comparison(left, input.op, input.value, value => {
      const mark = parameter(context, bindValue(def, p, value));
      return p.dataType === 'date' && dateSemantics(def, p) === 'instant' ? `julianday(${mark})` : mark;
    });
  };
  const prepare = (raw: unknown, extra: string[] = []): PreparedQuery => {
    const input = record(raw, '查询');
    keys(input, ['version', 'objectType', 'where', 'search', ...extra], '查询');
    if (input.version !== 1) return fail('查询合同版本须为 1');
    const def = type(input.objectType);
    const context: QueryContext = { params: [], conditions: 0, aliases: 0, checks: new Map() };
    const clauses: string[] = [];
    if (input.where !== undefined) clauses.push(condition(def, input.where, context));
    if (input.search !== undefined) {
      const term = text(input.search, '搜索文本').replace(/[\\%_]/g, '\\$&');
      const fields = def.properties.filter(p => p.readable !== false && ['string', 'enum'].includes(p.dataType));
      clauses.push(fields.length ? `(${fields.map(p => `r.${q(p.apiName)} LIKE ${parameter(context, `%${term}%`)} ESCAPE '\\'`).join(' OR ')})` : '0=1');
    }
    return { input, def, context, where: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '' };
  };
  const projection = (def: ObjectTypeDef, raw: unknown): PropertyDef[] => {
    if (raw === undefined) return def.properties.filter(p => p.readable !== false);
    if (!Array.isArray(raw) || !raw.length || raw.length > def.properties.length) return fail('select 须为非空属性数组');
    const names = [...new Set([def.primaryKey, ...raw])];
    return names.map(name => property(def, name));
  };
  const decode = (def: ObjectTypeDef, fields: PropertyDef[], row: QueryRow): QueryRow => {
    const result: QueryRow = {};
    for (const p of fields) {
      const value = row[p.apiName];
      if (value === null) { result[p.apiName] = null; continue; }
      try {
        if (p.dataType === 'integer' && (typeof value !== 'number' || !Number.isSafeInteger(value))) throw new Error('非法整数');
        if (p.dataType === 'float' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error('非法数字');
        if (['string', 'enum', 'date'].includes(p.dataType) && typeof value !== 'string') throw new Error('非法文本值');
        if (p.dataType === 'json') result[p.apiName] = typeof value === 'string' ? JSON.parse(value) : fail('JSON 物理值非法');
        else if (p.dataType === 'boolean') {
          if (value !== 0 && value !== 1 && typeof value !== 'boolean') throw new Error('非法布尔值');
          result[p.apiName] = value === 1 || value === true;
        } else result[p.apiName] = value;
      } catch { fail(`对象 ${def.apiName} 的 ${p.apiName} 存在非法存量值`, 'DATA_VALUE_INVALID'); }
    }
    return result;
  };
  const pageOptions = (raw: unknown): { limit: number; offset: number; mode?: 'cursor'; cursor?: string } => {
    const input = raw === undefined ? {} : record(raw, '分页');
    keys(input, ['limit', 'offset', 'mode', 'cursor'], '分页');
    if (input.mode !== undefined && input.mode !== 'offset' && input.mode !== 'cursor') return fail('分页模式无效');
    if (input.mode === 'cursor' && input.offset !== undefined) return fail('游标分页不能混用 offset');
    if (input.cursor !== undefined && (input.mode !== 'cursor' || typeof input.cursor !== 'string')) return fail('cursor 须用于游标模式');
    return { limit: integer(input.limit, 50, 1, 500, 'limit'), offset: integer(input.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset'),
      ...(input.mode === 'cursor' ? { mode: 'cursor', ...(input.cursor === undefined ? {} : { cursor: input.cursor as string }) } : {}) };
  };
  const sorting = (def: ObjectTypeDef, raw: unknown): SortField[] => {
    if (raw !== undefined && (!Array.isArray(raw) || raw.length > QUERY_LIMITS.sortFields || !raw.length)) return fail('排序须为 1—3 项数组');
    const entries: unknown[] = raw === undefined ? [] : raw as unknown[];
    const names = new Set<string>();
    const fields: SortField[] = entries.map(entry => {
      const input = record(entry, '排序');
      keys(input, ['property', 'direction', 'nulls'], '排序');
      const p = property(def, input.property);
      if (p.dataType === 'json' || names.has(p.apiName)) return fail('排序属性不支持或重复');
      names.add(p.apiName);
      if (input.direction !== undefined && input.direction !== 'asc' && input.direction !== 'desc') return fail('排序方向无效');
      if (input.nulls !== undefined && input.nulls !== 'first' && input.nulls !== 'last') return fail('空值排序无效');
      return { p, expression: column(def, p, 'r'), direction: input.direction === 'desc' ? 'DESC' : 'ASC', nulls: input.nulls === 'first' ? 'FIRST' : 'LAST' };
    });
    if (!names.has(def.primaryKey)) { const p = property(def, def.primaryKey); fields.push({ p, expression: `r.${q(p.apiName)}`, direction: 'DESC', nulls: 'LAST' }); }
    return fields;
  };

  const list = (raw: unknown): QueryResult => {
    const { input, def, context, where } = prepare(raw, ['select', 'orderBy', 'page', 'includeTotal']);
    if (input.includeTotal !== undefined && typeof input.includeTotal !== 'boolean') return fail('includeTotal 须为布尔值');
    const fields = projection(def, input.select);
    const page = pageOptions(input.page);
    const sorts = sorting(def, input.orderBy);
    sorts.forEach(sort => checkField(context, def, sort.p));
    const order = ` ORDER BY ${sorts.map(sort => `${sort.expression} ${sort.direction} NULLS ${sort.nulls}`).join(', ')}`;
    const baseParams = [...context.params];
    const { page: _page, ...queryWithoutPage } = input;
    const fingerprint = page.mode === 'cursor' ? valueHash({ scope: 'local-user', query: queryWithoutPage,
      objects: ontology.listObjectTypes().map(o => ({ apiName: o.apiName, tableName: o.tableName, primaryKey: o.primaryKey, properties: o.properties })),
      links: ontology.listLinkTypes().map(l => ({ apiName: l.apiName, leftType: l.leftType, rightType: l.rightType, cardinality: l.cardinality, fkColumn: l.fkColumn, discriminatorColumn: l.discriminatorColumn, discriminatorValue: l.discriminatorValue, refColumn: l.refColumn, linkTable: l.linkTable, backingTableName: l.backingTableName, backingLeftProperty: l.backingLeftProperty, backingRightProperty: l.backingRightProperty })),
    }) : '';
    let cursorWhere = '';
    if (page.cursor) {
      const values = cursorCodec.decode(page.cursor, fingerprint, sorts.length);
      const branches = sorts.map((sort, index) => {
        const prefix = sorts.slice(0, index).map((previous, i) => `${previous.expression} IS ${parameter(context, values[i])}`);
        const value = values[index];
        const after = value === null ? sort.nulls === 'FIRST' ? `${sort.expression} IS NOT NULL` : '0=1'
          : `(${sort.expression} ${sort.direction === 'ASC' ? '>' : '<'} ${parameter(context, value)}${sort.nulls === 'LAST' && sort.p.nullable ? ` OR ${sort.expression} IS NULL` : ''})`;
        return `(${[...prefix, after].join(' AND ')})`;
      });
      cursorWhere = `${where ? ' AND' : ' WHERE'} (${branches.join(' OR ')})`;
    }
    const selected = [...fields.map(p => `r.${q(p.apiName)}`), ...(page.mode === 'cursor' ? sorts.map((sort, i) => `${sort.expression} AS ${q(`__cursor_${i}`)}`) : [])];
    return readSnapshot(db, () => {
      validateStorage(context);
      const total = input.includeTotal ? Number(db.prepare(`SELECT COUNT(*) AS n FROM ${q(def.tableName!)} r${where}`).get(...baseParams)?.n ?? 0) : undefined;
      const rows = db.prepare(`SELECT ${selected.join(', ')} FROM ${q(def.tableName!)} r${where}${cursorWhere}${order} LIMIT ? OFFSET ?`).all(...context.params, page.limit + 1, page.offset);
      const hasMore = rows.length > page.limit;
      const last = rows[Math.min(page.limit, rows.length) - 1];
      const nextCursor = page.mode === 'cursor' && hasMore && last ? cursorCodec.encode(fingerprint, sorts.map((_, i) => last[`__cursor_${i}`] as CursorValue)) : undefined;
      return { contractVersion: 1, rows: rows.slice(0, page.limit).map(row => decode(def, fields, row)),
        page: { limit: page.limit, offset: page.offset, hasMore, ...(page.mode ? { mode: page.mode } : {}), ...(nextCursor ? { nextCursor } : {}) }, ...(total === undefined ? {} : { total }) };
    });
  };
  const get = (raw: unknown): QueryRow | null => {
    const input = record(raw, '对象读取');
    keys(input, ['version', 'objectType', 'id', 'select'], '对象读取');
    if (input.version !== 1) return fail('查询合同版本须为 1');
    const def = type(input.objectType);
    const fields = projection(def, input.select);
    const id = bindValue(def, property(def, def.primaryKey), input.id);
    const row = db.prepare(`SELECT ${fields.map(p => q(p.apiName)).join(', ')} FROM ${q(def.tableName!)} WHERE ${q(def.primaryKey)}=?`).get(id);
    return row ? decode(def, fields, row) : null;
  };
  const aggregate = (raw: unknown): AggregateResult => {
    const { input, def, context, where } = prepare(raw, ['groupBy', 'metrics', 'having', 'orderBy', 'page']);
    const whereParams = [...context.params];
    const rawGroups = input.groupBy ?? [];
    if (!Array.isArray(rawGroups) || rawGroups.length > QUERY_LIMITS.groupFields || new Set(rawGroups).size !== rawGroups.length) return fail('分组属性须为最多两个不重复属性');
    const groups = rawGroups.map(name => {
      const p = property(def, name);
      checkField(context, def, p);
      if (p.dataType === 'json' || (p.dataType === 'date' && dateSemantics(def, p) === 'instant')) return fail('该属性不支持直接分组', 'QUERY_UNSUPPORTED');
      return p;
    });
    if (!Array.isArray(input.metrics) || !input.metrics.length || input.metrics.length > QUERY_LIMITS.metrics) return fail('指标须为 1—8 项数组');
    const aliases = new Set<string>();
    const metrics = input.metrics.map((rawMetric, index) => {
      const metric = record(rawMetric, '指标');
      keys(metric, ['op', 'property', 'as'], '指标');
      if (!['count', 'sum', 'avg', 'min', 'max'].includes(String(metric.op))) return fail('不支持该聚合方式');
      const name = text(metric.as, '指标别名');
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || aliases.has(name)) return fail('指标别名非法或重复');
      aliases.add(name);
      const p = metric.property === undefined ? undefined : property(def, metric.property);
      if (p && metric.op !== 'count') checkField(context, def, p);
      if (!p && metric.op !== 'count') return fail('该指标必须指定属性');
      if (p && metric.op !== 'count') {
        if (p.dataType === 'json' || (p.dataType === 'date' && dateSemantics(def, p) === 'instant')) return fail('该属性不支持聚合', 'QUERY_UNSUPPORTED');
        if ((metric.op === 'sum' || metric.op === 'avg') && !['integer', 'float'].includes(p.dataType)) return fail('sum/avg 仅支持数值属性');
      }
      return { name, op: String(metric.op), p, sqlAlias: `m${index}`, sql: `${String(metric.op).toUpperCase()}(${p ? `r.${q(p.apiName)}` : '*'})` };
    });
    const havingCondition = (rawCondition: unknown, depth = 1): string => {
      if (depth > QUERY_LIMITS.depth || ++context.conditions > QUERY_LIMITS.conditions) return fail('having 条件超限');
      const item = record(rawCondition, 'having');
      for (const op of ['and', 'or', 'not'] as const) if (Object.hasOwn(item, op)) {
        keys(item, [op], 'having 组合条件');
        if (op === 'not') return `NOT (${havingCondition(item.not, depth + 1)})`;
        const children = item[op];
        if (!Array.isArray(children) || !children.length) return fail('having 组合须为非空数组');
        return `(${children.map(child => havingCondition(child, depth + 1)).join(op === 'and' ? ' AND ' : ' OR ')})`;
      }
      keys(item, ['property', 'op', 'value'], 'having');
      const metric = metrics.find(m => m.name === item.property);
      if (!metric) return fail('having 只能引用已声明指标别名');
      return comparison(metric.sql, item.op, item.value, value => {
        const numeric = ['count', 'sum', 'avg'].includes(metric.op);
        if (numeric && (typeof value !== 'number' || !Number.isFinite(value))) return fail('指标比较值须为有限数字');
        return parameter(context, numeric ? value : bindValue(def, metric.p!, value));
      });
    };
    const having = input.having === undefined ? '' : ` HAVING ${havingCondition(input.having)}`;
    const fields = [...groups.map((p, i) => `r.${q(p.apiName)} AS ${q(`d${i}`)}`), ...metrics.map(m => `${m.sql} AS ${q(m.sqlAlias)}`)];
    const groupSql = groups.length ? ` GROUP BY ${groups.map(p => `r.${q(p.apiName)}`).join(',')}` : '';
    const base = `SELECT ${fields.join(',')} FROM ${q(def.tableName!)} r${where}${groupSql}${having}`;
    const orders: string[] = [];
    const orderedGroups = new Set<string>();
    if (input.orderBy !== undefined) {
      if (!Array.isArray(input.orderBy) || !input.orderBy.length || input.orderBy.length > QUERY_LIMITS.sortFields) return fail('组排序项超限或为空');
      for (const entry of input.orderBy) {
        const item = record(entry, '组排序');
        keys(item, ['property', 'metric', 'direction', 'nulls'], '组排序');
        if ((item.property === undefined) === (item.metric === undefined)) return fail('组排序须指定一个维度或指标');
        if (item.direction !== undefined && item.direction !== 'asc' && item.direction !== 'desc') return fail('组排序方向无效');
        if (item.nulls !== undefined && item.nulls !== 'first' && item.nulls !== 'last') return fail('空值排序无效');
        const groupIndex = groups.findIndex(p => p.apiName === item.property);
        const metric = metrics.find(m => m.name === item.metric);
        if ((item.property !== undefined && groupIndex < 0) || (item.metric !== undefined && !metric)) return fail('只能按已声明维度或指标排序');
        const name = item.metric !== undefined ? metric!.sqlAlias : `d${groupIndex}`;
        if (item.property !== undefined) orderedGroups.add(String(item.property));
        orders.push(`${q(name)} ${item.direction === 'desc' ? 'DESC' : 'ASC'} NULLS ${item.nulls === 'first' ? 'FIRST' : 'LAST'}`);
      }
    }
    groups.forEach((p, i) => { if (!orderedGroups.has(p.apiName)) orders.push(`${q(`d${i}`)} ASC NULLS LAST`); });
    const order = orders.length ? ` ORDER BY ${orders.join(',')}` : '';
    const page = pageOptions(input.page);
    if (page.mode === 'cursor') return fail('分组统计首版只支持普通分页', 'QUERY_UNSUPPORTED');
    const readAggregate = (): AggregateResult => readSnapshot(db, () => {
      validateStorage(context);
      const objectCount = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${q(def.tableName!)} r${where}`).get(...whereParams)?.n ?? 0);
      const groupCount = Number(db.prepare(`SELECT COUNT(*) AS n FROM (${base})`).get(...context.params)?.n ?? 0);
      const rows = db.prepare(`${base}${order} LIMIT ? OFFSET ?`).all(...context.params, page.limit + 1, page.offset);
      return { contractVersion: 1, objectCount, groupCount, page: { ...page, hasMore: rows.length > page.limit }, rows: rows.slice(0, page.limit).map(row => ({
        dimensions: Object.fromEntries(groups.map((p, i) => [p.apiName, decode(def, [p], { [p.apiName]: row[`d${i}`] })[p.apiName]])),
        metrics: Object.fromEntries(metrics.map(m => {
          const value = row[m.sqlAlias];
          if (['count', 'sum', 'avg'].includes(m.op) && value !== null) {
            const integerResult = m.op === 'count' || (m.op === 'sum' && m.p?.dataType === 'integer');
            if (typeof value !== 'number' || !Number.isFinite(value) || (integerResult && !Number.isSafeInteger(value))) fail('聚合结果超出可安全表示的数值范围', 'QUERY_RESULT_OUT_OF_RANGE');
          }
          return [m.name, m.p && (m.op === 'min' || m.op === 'max') ? decode(def, [m.p], { [m.p.apiName]: value })[m.p.apiName] : value];
        })),
      })) };
    });
    try { return readAggregate(); } catch (error) {
      // 两种驱动对 SQLite 整数溢出/不安全整数转换的异常不同，统一为合同错误。
      if (error instanceof Error && (/integer overflow|cannot be represented.*(?:number|integer)|too large.*(?:number|integer)/i.test(error.message)
        || ('code' in error && error.code === 'ERR_OUT_OF_RANGE'))) fail('聚合结果超出可安全表示的数值范围', 'QUERY_RESULT_OUT_OF_RANGE');
      throw error;
    }
  };
  const related = (raw: unknown): QueryResult => {
    const input = record(raw, '关系列表');
    keys(input, ['version', 'objectType', 'id', 'linkType', 'side', 'select', 'where', 'search', 'orderBy', 'page', 'includeTotal'], '关系列表');
    const def = type(input.objectType);
    const link = ontology.listLinkTypes().find(l => l.apiName === input.linkType);
    if (!link || (input.side !== 'left' && input.side !== 'right') || (input.side === 'left' ? link.leftType : link.rightType) !== def.apiName) return fail('关系或方向无效');
    if (!get({ version: input.version, objectType: def.apiName, id: input.id, select: [def.primaryKey] })) return fail('当前对象不存在', 'REFERENCE_NOT_FOUND');
    const condition = { related: { linkType: link.apiName, side: input.side === 'left' ? 'right' : 'left', where: { property: def.primaryKey, op: 'eq', value: input.id } } };
    const page = pageOptions(input.page);
    if (page.limit > QUERY_LIMITS.relationPageSize) return fail('关系页最大为 200 条');
    return list({ version: input.version, objectType: input.side === 'left' ? link.rightType : link.leftType,
      select: input.select, where: input.where === undefined ? condition : { and: [condition, input.where] },
      search: input.search, orderBy: input.orderBy, page: input.page, includeTotal: input.includeTotal });
  };
  const describe = (name: string) => {
    const def = ontology.getObjectType(name);
    return { version: 1 as const, objectType: def.apiName, instanceQuery: !def.isVirtual && !!def.tableName, pagination: ['offset', 'cursor'],
      limits: QUERY_LIMITS, relations: ontology.listLinkTypes().filter(l => l.leftType === name || l.rightType === name).map(l => ({ apiName: l.apiName, leftType: l.leftType, rightType: l.rightType, cardinality: l.cardinality,
        filterable: !ontology.getObjectType(l.leftType).isVirtual && !ontology.getObjectType(l.rightType).isVirtual, referenceKind: l.referenceKind })),
      properties: def.properties.filter(p => p.readable !== false).map(p => ({
        apiName: p.apiName, dataType: p.dataType, nullable: p.nullable, sortable: p.dataType !== 'json',
        dateSemantics: p.dataType === 'date' ? dateSemantics(def, p) : undefined,
        groupable: p.dataType !== 'json' && !(p.dataType === 'date' && dateSemantics(def, p) === 'instant'),
        aggregations: ['count', ...(['integer', 'float'].includes(p.dataType) ? ['sum', 'avg'] : []), ...(p.dataType !== 'json' && !(p.dataType === 'date' && dateSemantics(def, p) === 'instant') ? ['min', 'max'] : [])],
        operators: p.dataType === 'json' ? ['is_null', 'not_null'] : ['eq', 'ne', 'in', 'is_null', 'not_null', ...(p.dataType === 'boolean' ? [] : ['gt', 'gte', 'lt', 'lte']), ...(['string', 'enum'].includes(p.dataType) ? ['contains'] : [])],
      })) };
  };
  return { list, get, aggregate, related, describe };
}

export type QueryService = ReturnType<typeof createQueryService>;
