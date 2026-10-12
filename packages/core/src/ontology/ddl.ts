// 本体层 DDL：自定义对象类型的动态建表/加列/删列/删表（动态 DDL 规划器的极简版）。
// 只做安全操作：建表、加 nullable 列；删列/删表由上层校验后调用（数据丢失风险由界面确认）。
import type { DbAdapter } from '../db';
import type { OntoDataType, PropertyDef } from './types';

export const CUSTOM_TABLE_PREFIX = 'ont_obj_';
/** 自定义类型表名 */
export const customTableName = (apiName: string) => `${CUSTOM_TABLE_PREFIX}${apiName}`;

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function sqlTypeFor(dataType: OntoDataType): string {
  switch (dataType) {
    case 'integer':
    case 'boolean':
      return 'INTEGER';
    case 'float':
      return 'REAL';
    default:
      // string / date / enum / json 都落 TEXT（日期为 ISO 字符串，json 为 JSON 字符串）
      return 'TEXT';
  }
}

/**
 * 建自定义对象表：id TEXT 主键（uuid 由仓储生成）+ 用户属性列 + created_at/updated_at。
 * 属性列一律 nullable（默认值由写入方处理），保持 ALTER 兼容性。
 */
export function createCustomObjectTable(db: DbAdapter, tableName: string, props: PropertyDef[]): void {
  const cols = [
    'id TEXT PRIMARY KEY',
    ...props.map(
      (p) => `${quoteIdent(p.apiName)} ${sqlTypeFor(p.dataType)}`,
    ),
    'created_at TEXT NOT NULL',
    'updated_at TEXT NOT NULL',
  ];
  db.exec(`CREATE TABLE ${quoteIdent(tableName)} (${cols.join(', ')});`);
  for (const p of props) {
    if (p.indexed) addObjectIndex(db, tableName, p.apiName);
  }
}

export function addObjectIndex(db: DbAdapter, tableName: string, columnName: string): void {
  db.exec(
    `CREATE INDEX IF NOT EXISTS ${quoteIdent(`idx_${tableName}_${columnName}`)} ON ${quoteIdent(tableName)}(${quoteIdent(columnName)});`,
  );
}

/** 加列：仅允许 nullable 且无 NOT NULL 约束的属性（SQLite ALTER ADD COLUMN 的安全子集） */
export function addObjectColumn(db: DbAdapter, tableName: string, prop: PropertyDef): void {
  db.exec(
    `ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN ${quoteIdent(prop.apiName)} ${sqlTypeFor(prop.dataType)};`,
  );
  if (prop.indexed) addObjectIndex(db, tableName, prop.apiName);
}

/** 删列（SQLite ≥ 3.35）。主键/受保护列的拦截在上层 registry 完成 */
export function dropObjectColumn(db: DbAdapter, tableName: string, columnName: string): void {
  db.exec(`ALTER TABLE ${quoteIdent(tableName)} DROP COLUMN ${quoteIdent(columnName)};`);
}

export function dropObjectTable(db: DbAdapter, tableName: string): void {
  db.exec(`DROP TABLE IF EXISTS ${quoteIdent(tableName)};`);
}
