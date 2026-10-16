// stdio 进程入口；旧构建路径和环境变量保持兼容。
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createCore, defaultDbPath, openNodeSqliteDb, toolsRootForDb } from '../../../packages/core/src/index';
import { createMcpServer } from './server';

async function main() {
  const dbPath = defaultDbPath();
  const db = openNodeSqliteDb(dbPath);
  const core = createCore(db, { dbPath });
  const { server } = createMcpServer({ core, toolFilesRoot: toolsRootForDb(dbPath) });
  await server.connect(new StdioServerTransport());
  console.error(`[tododesk-mcp] 已启动，数据库：${dbPath}`);
}

main().catch((e) => {
  console.error('[tododesk-mcp] 启动失败：', e);
  process.exitCode = 1;
});
