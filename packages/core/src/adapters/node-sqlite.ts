// node:sqlite 适配器（Node 22.5+ / 24 内置，供 MCP Server 与测试使用，零原生依赖）
import { DatabaseSync } from 'node:sqlite';
import type { DbAdapter, SqlStatement } from '../db';

export function openNodeSqliteDb(path: string): DbAdapter {
  const db = new DatabaseSync(path);
  // App 与 MCP 是同一 SQLite 文件的两个进程：写锁竞争时等待而非立即失败（WAL 下常规并发安全）
  db.exec('PRAGMA busy_timeout = 5000');
  const wrap = (stmt: {
    run: (...params: never[]) => { changes: number | bigint; lastInsertRowid: number | bigint };
    get: (...params: never[]) => unknown;
    all: (...params: never[]) => unknown[];
  }): SqlStatement => ({
    run: (...params: unknown[]) => {
      const r = stmt.run(...(params as never[]));
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    get: (...params: unknown[]) => stmt.get(...(params as never[])) as Record<string, unknown> | undefined,
    all: (...params: unknown[]) => stmt.all(...(params as never[])) as Record<string, unknown>[],
  });
  return {
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => wrap(db.prepare(sql) as never),
    close: () => { try { db.close(); } catch { /* 已关闭则忽略（幂等） */ } },
  };
}
