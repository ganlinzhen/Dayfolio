// 桌面端数据库接入：better-sqlite3（Electron ABI），与 MCP 共享同一份 SQLite 库
import Database from 'better-sqlite3';
import { defaultDbPath, type DbAdapter } from '../../../../packages/core/src/index';

export function openDb(): DbAdapter {
  const db = new Database(defaultDbPath());
  return {
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => {
      const stmt = db.prepare(sql);
      return {
        run: (...params: unknown[]) => {
          const r = stmt.run(...(params as never[]));
          return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
        },
        get: (...params: unknown[]) => stmt.get(...(params as never[])) as Record<string, unknown> | undefined,
        all: (...params: unknown[]) => stmt.all(...(params as never[])) as Record<string, unknown>[],
      };
    },
    close: () => db.close(),
  };
}
