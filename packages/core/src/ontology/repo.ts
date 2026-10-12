// 通用对象仓储：类型驱动的 CRUD / 搜索 / 筛选 / 链接解析。
// 列名一律经 ObjectTypeDef 白名单映射（杜绝标识符注入），值全部参数化。
import { randomUUID } from 'node:crypto';
import type { DbAdapter } from '../db';
import { nowIso } from '../utils/date';
import { quoteIdent } from './ddl';
import type { OntologyService } from './registry';
import type { ObjectTypeDef, PropertyDef } from './types';

export interface WhereClause {
  property: string;
  op: 'eq' | 'ne' | 'like' | 'in' | 'gte' | 'lte';
  value: unknown;
}

export interface ListOptions {
  search?: string;
  where?: WhereClause[];
  limit?: number;
  offset?: number;
  orderBy?: string;
  order?: 'asc' | 'desc';
}

export interface LinkRef {
  linkApiName: string;
  direction: 'out' | 'in';
  /** 对端对象类型 */
  targetType: string;
  /** 对端对象（title_property 与主键） */
  targetId: unknown;
  targetTitle: string | null;
}

export type ObjectRow = Record<string, unknown>;

const propOf = (def: ObjectTypeDef, name: string): PropertyDef => {
  const p = def.properties.find((x) => x.apiName === name);
  if (!p) throw new Error(`对象类型 ${def.apiName} 上没有属性 ${name}`);
  return p;
};

/** 物理值 → 展示值（json 保持字符串、boolean 还原、其余原样） */
const readValue = (p: PropertyDef, raw: unknown): unknown => {
  if (p.dataType === 'boolean') return raw === 1 || raw === true;
  return raw;
};

/** 写入值 → 物理值（json 序列化、boolean 转 0/1、枚举校验、可空校验） */
const writeValue = (p: PropertyDef, value: unknown, apiName: string): unknown => {
  if (value === undefined) throw new Error(`${apiName}.${p.apiName} 缺值`);
  if (value === null) {
    if (!p.nullable) throw new Error(`${apiName}.${p.apiName} 不可为空`);
    return null;
  }
  if (p.dataType === 'enum') {
    const s = String(value);
    if (p.enumValues && !p.enumValues.includes(s)) throw new Error(`${apiName}.${p.apiName} 取值须为 ${p.enumValues.join('/')}`);
    return s;
  }
  if (p.dataType === 'json') return typeof value === 'string' ? value : JSON.stringify(value);
  if (p.dataType === 'boolean') return value ? 1 : 0;
  if (p.dataType === 'integer') {
    const n = Number(value);
    if (!Number.isInteger(n)) throw new Error(`${apiName}.${p.apiName} 须为整数`);
    return n;
  }
  if (p.dataType === 'float') {
    const n = Number(value);
    if (Number.isNaN(n)) throw new Error(`${apiName}.${p.apiName} 须为数字`);
    return n;
  }
  return String(value);
};

export function createObjectRepo(db: DbAdapter, ontology: OntologyService) {
  const defOf = (apiName: string): ObjectTypeDef => {
    const def = ontology.findObjectType(apiName);
    if (!def) throw new Error(`对象类型 ${apiName} 不存在`);
    if (def.isVirtual || !def.tableName) throw new Error(`虚拟类型 ${apiName} 没有实例数据`);
    return def;
  };

  const project = (def: ObjectTypeDef, row: Record<string, unknown>): ObjectRow => {
    const out: ObjectRow = {};
    for (const p of def.properties) {
      if (p.apiName in row) out[p.apiName] = readValue(p, row[p.apiName]);
    }
    return out;
  };

  const buildWhere = (def: ObjectTypeDef, where: WhereClause[] | undefined, search: string | undefined): { sql: string; params: unknown[] } => {
    const conds: string[] = [];
    const params: unknown[] = [];
    for (const w of where ?? []) {
      propOf(def, w.property); // 白名单校验
      const opSql = { eq: '=', ne: '!=', like: 'LIKE', in: 'IN', gte: '>=', lte: '<=' }[w.op];
      if (w.op === 'in') {
        const arr = Array.isArray(w.value) ? w.value : [w.value];
        if (arr.length === 0) { conds.push('1=0'); continue; }
        conds.push(`${quoteIdent(w.property)} IN (${arr.map(() => '?').join(',')})`);
        params.push(...arr);
      } else {
        conds.push(`${quoteIdent(w.property)} ${opSql} ?`);
        params.push(w.op === 'like' ? `%${String(w.value)}%` : w.value);
      }
    }
    if (search && search.trim()) {
      const textProps = def.properties.filter((p) => p.dataType === 'string' || p.dataType === 'enum' || p.dataType === 'date');
      if (textProps.length > 0) {
        conds.push(`(${textProps.map((p) => quoteIdent(p.apiName)).join(` || ' ' || `)} LIKE ?)`);
        params.push(`%${search.trim()}%`);
      }
    }
    return { sql: conds.length ? ` WHERE ${conds.join(' AND ')}` : '', params };
  };

  const list = (apiName: string, opts: ListOptions = {}): { rows: ObjectRow[]; total: number } => {
    const def = defOf(apiName);
    const { sql, params } = buildWhere(def, opts.where, opts.search);
    const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(def.tableName!)}${sql}`).get(...params) as { n: number }).n);
    const orderBy = opts.orderBy ? propOf(def, opts.orderBy).apiName : def.primaryKey;
    const dir = opts.order === 'asc' ? 'ASC' : 'DESC';
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const offset = Math.max(opts.offset ?? 0, 0);
    const rows = db
      .prepare(`SELECT * FROM ${quoteIdent(def.tableName!)}${sql} ORDER BY ${quoteIdent(orderBy)} ${dir} LIMIT ${limit} OFFSET ${offset}`)
      .all(...params);
    return { rows: rows.map((r) => project(def, r)), total };
  };

  const get = (apiName: string, id: unknown): ObjectRow | null => {
    const def = defOf(apiName);
    propOf(def, def.primaryKey);
    const pkType = def.properties.find((p) => p.apiName === def.primaryKey)!.dataType;
    const key = pkType === 'integer' ? Number(id) : String(id);
    const row = db.prepare(`SELECT * FROM ${quoteIdent(def.tableName!)} WHERE ${quoteIdent(def.primaryKey)} = ?`).get(key);
    return row ? project(def, row) : null;
  };

  const insert = (apiName: string, values: ObjectRow): ObjectRow => {
    const def = defOf(apiName);
    const pk = def.properties.find((p) => p.apiName === def.primaryKey)!;
    const cols: string[] = [];
    const params: unknown[] = [];
    const now = nowIso();
    for (const p of def.properties) {
      if (p.apiName === def.primaryKey) {
        if (pk.dataType === 'integer') continue; // 自增主键不插入
        if (values[p.apiName] === undefined) {
          cols.push(quoteIdent(p.apiName));
          params.push(randomUUID());
          continue;
        }
      }
      if (p.apiName === 'created_at' || p.apiName === 'updated_at') {
        if (values[p.apiName] === undefined) {
          cols.push(quoteIdent(p.apiName));
          params.push(now);
          continue;
        }
      }
      if (values[p.apiName] !== undefined) {
        cols.push(quoteIdent(p.apiName));
        params.push(writeValue(p, values[p.apiName], apiName));
      } else if (!p.nullable && p.apiName !== def.primaryKey) {
        throw new Error(`${apiName}.${p.apiName} 为必填`);
      }
    }
    const sql = `INSERT INTO ${quoteIdent(def.tableName!)} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    const res = db.prepare(sql).run(...params);
    const id = pk.dataType === 'integer' ? Number(res.lastInsertRowid) : params[cols.indexOf(quoteIdent(def.primaryKey))];
    return get(apiName, id)!;
  };

  const update = (apiName: string, id: unknown, patch: ObjectRow): ObjectRow => {
    const def = defOf(apiName);
    const pkType = def.properties.find((p) => p.apiName === def.primaryKey)!.dataType;
    const key = pkType === 'integer' ? Number(id) : String(id);
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [name, value] of Object.entries(patch)) {
      const p = propOf(def, name);
      if (p.apiName === def.primaryKey) throw new Error('主键不可修改');
      sets.push(`${quoteIdent(name)} = ?`);
      params.push(writeValue(p, value, apiName));
    }
    if (def.properties.some((p) => p.apiName === 'updated_at') && !patch.updated_at) {
      sets.push(`${quoteIdent('updated_at')} = ?`);
      params.push(nowIso());
    }
    if (sets.length === 0) throw new Error('没有可更新字段');
    params.push(key);
    const res = db
      .prepare(`UPDATE ${quoteIdent(def.tableName!)} SET ${sets.join(', ')} WHERE ${quoteIdent(def.primaryKey)} = ?`)
      .run(...params);
    if (res.changes === 0) throw new Error(`${apiName} 中不存在 ${String(id)}`);
    return get(apiName, id)!;
  };

  /** 按属性筛选更新（动作 modify_object 用），返回更新行数 */
  const updateBy = (apiName: string, property: string, value: unknown, patch: ObjectRow): number => {
    const def = defOf(apiName);
    propOf(def, property);
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [name, v] of Object.entries(patch)) {
      const p = propOf(def, name);
      if (p.apiName === def.primaryKey) throw new Error('主键不可修改');
      sets.push(`${quoteIdent(name)} = ?`);
      params.push(writeValue(p, v, apiName));
    }
    if (def.properties.some((p) => p.apiName === 'updated_at') && !patch.updated_at) {
      sets.push(`${quoteIdent('updated_at')} = ?`);
      params.push(nowIso());
    }
    params.push(value);
    const res = db
      .prepare(`UPDATE ${quoteIdent(def.tableName!)} SET ${sets.join(', ')} WHERE ${quoteIdent(property)} = ?`)
      .run(...params);
    return res.changes;
  };

  const remove = (apiName: string, id: unknown): void => {
    const def = defOf(apiName);
    const pkType = def.properties.find((p) => p.apiName === def.primaryKey)!.dataType;
    const key = pkType === 'integer' ? Number(id) : String(id);
    const res = db.prepare(`DELETE FROM ${quoteIdent(def.tableName!)} WHERE ${quoteIdent(def.primaryKey)} = ?`).run(key);
    if (res.changes === 0) throw new Error(`${apiName} 中不存在 ${String(id)}`);
  };

  const deleteBy = (apiName: string, property: string, value: unknown): number => {
    const def = defOf(apiName);
    propOf(def, property);
    return db.prepare(`DELETE FROM ${quoteIdent(def.tableName!)} WHERE ${quoteIdent(property)} = ?`).run(value).changes;
  };

  const count = (apiName: string): number => {
    const def = defOf(apiName);
    return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(def.tableName!)}`).get() as { n: number }).n);
  };

  // ---------- 链接解析（数据面板详情页：出链/入链） ----------

  const titleOf = (typeApi: string, row: ObjectRow | null): string | null => {
    if (!row) return null;
    const t = ontology.findObjectType(typeApi);
    if (!t) return null;
    const v = row[t.titleProperty];
    const s = v === null || v === undefined ? '' : String(v);
    return s || null;
  };

  const resolveLinks = (apiName: string, row: ObjectRow): LinkRef[] => {
    const out: LinkRef[] = [];
    for (const l of ontology.listLinkTypes()) {
      // 出链：本行是 right 侧（外键/多态引用在本行上）
      if (l.rightType === apiName && l.fkColumn && row[l.fkColumn] != null) {
        out.push({
          linkApiName: l.apiName,
          direction: 'out',
          targetType: l.leftType,
          targetId: row[l.fkColumn],
          targetTitle: titleOf(l.leftType, safeGet(l.leftType, row[l.fkColumn])),
        });
      }
      if (l.rightType === apiName && l.discriminatorColumn && row[l.discriminatorColumn] === l.discriminatorValue && l.refColumn) {
        const refId = row[l.refColumn];
        out.push({
          linkApiName: l.apiName,
          direction: 'out',
          targetType: l.leftType,
          targetId: refId,
          targetTitle: titleOf(l.leftType, safeGet(l.leftType, refId)),
        });
      }
      // 入链：本行是 left 侧，别人引用我
      if (l.leftType === apiName) {
        const myId = row[defOf(apiName).primaryKey];
        if (l.fkColumn) {
          const hits = list(l.rightType, { where: [{ property: l.fkColumn, op: 'eq', value: myId }], limit: 50 });
          for (const r of hits.rows) {
            out.push({ linkApiName: l.apiName, direction: 'in', targetType: l.rightType, targetId: r[defPk(l.rightType)], targetTitle: titleOf(l.rightType, r) });
          }
        } else if (l.discriminatorColumn && l.refColumn) {
          const hits = list(l.rightType, {
            where: [
              { property: l.discriminatorColumn, op: 'eq', value: l.discriminatorValue },
              { property: l.refColumn, op: 'eq', value: myId },
            ],
            limit: 50,
          });
          for (const r of hits.rows) {
            out.push({ linkApiName: l.apiName, direction: 'in', targetType: l.rightType, targetId: r[defPk(l.rightType)], targetTitle: titleOf(l.rightType, r) });
          }
        } else if (l.linkTable) {
          const hits = list(l.linkTable, { where: [{ property: l.backingLeftProperty!, op: 'eq', value: myId }], limit: 50 });
          for (const b of hits.rows) {
            const rightId = b[l.backingRightProperty!];
            out.push({ linkApiName: l.apiName, direction: 'in', targetType: l.rightType, targetId: rightId, targetTitle: titleOf(l.rightType, safeGet(l.rightType, rightId)) });
          }
        }
      }
    }
    return out;
  };

  const defPk = (apiName: string): string => {
    const d = ontology.findObjectType(apiName);
    return d ? d.primaryKey : 'id';
  };

  const safeGet = (apiName: string, id: unknown): ObjectRow | null => {
    try {
      return get(apiName, id);
    } catch {
      return null; // 虚拟类型（如 day）或已删对象
    }
  };

  return { list, get, insert, update, updateBy, remove, deleteBy, count, resolveLinks };
}

export type ObjectRepo = ReturnType<typeof createObjectRepo>;
