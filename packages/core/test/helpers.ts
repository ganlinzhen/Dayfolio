// 测试辅助：每个测试文件用独立临时库，互不干扰
import { mkdtempSync, rmSync } from 'node:fs';
import { initDb, inTx } from '../src/db';
import { MIGRATIONS } from '../src/migrations';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNodeSqliteDb } from '../src/adapters/node-sqlite';
import { createCore, type TodoDeskCore, type ProviderNetwork } from '../src/index';

export interface TestCtx {
  core: TodoDeskCore;
  dbPath: string;
  cleanup: () => void;
}

export function mkCore(options:{providerNetwork?:ProviderNetwork}={}): TestCtx {
  const dir = mkdtempSync(join(tmpdir(), 'tododesk-test-'));
  const dbPath = join(dir, 'test.db');
  const db = openNodeSqliteDb(dbPath);
  // dbPath 必传：课程/工具等资产目录从 dirname(db) 推导，绝不落到真实应用数据目录
  const core = createCore(db, { dbPath,...options });
  return {
    core,
    dbPath,
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* 测试内已手动关闭时忽略 */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 从空库执行到真实旧版本，避免只改 user_version 却保留未来列的伪旧库。 */
export function mkLegacyDb(version: number) {
  const dir = mkdtempSync(join(tmpdir(), 'tododesk-legacy-test-'));
  const dbPath = join(dir, 'legacy.db'), db = openNodeSqliteDb(dbPath);
  initDb(db);
  for (const migration of MIGRATIONS.filter(item => item.version <= version)) {
    inTx(db, () => { migration.up(db); db.exec(`PRAGMA user_version = ${migration.version}`); });
  }
  return { db, dbPath, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
