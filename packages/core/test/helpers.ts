// 测试辅助：每个测试文件用独立临时库，互不干扰
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNodeSqliteDb } from '../src/adapters/node-sqlite';
import { createCore, type TodoDeskCore } from '../src/index';

export interface TestCtx {
  core: TodoDeskCore;
  dbPath: string;
  cleanup: () => void;
}

export function mkCore(): TestCtx {
  const dir = mkdtempSync(join(tmpdir(), 'tododesk-test-'));
  const dbPath = join(dir, 'test.db');
  const db = openNodeSqliteDb(dbPath);
  // dbPath 必传：课程/工具等资产目录从 dirname(db) 推导，绝不落到真实应用数据目录
  const core = createCore(db, { dbPath });
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
