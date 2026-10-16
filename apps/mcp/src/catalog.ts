// 构建期读取真实注册目录；只使用内存数据库，不读取运行时用户数据。
import { createCore, openNodeSqliteDb } from '../../../packages/core/src/index';
import { createMcpServer } from './server';

export function collectToolCatalog() {
  const db = openNodeSqliteDb(':memory:');
  try {
    return createMcpServer({ core: createCore(db, { dbPath: ':memory:' }), toolFilesRoot: '' }).catalog;
  } finally {
    db.close();
  }
}
