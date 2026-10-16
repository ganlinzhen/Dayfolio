// stdio 进程入口；旧构建路径和环境变量保持兼容。
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createCore, defaultDbPath, openNodeSqliteDb, toolsRootForDb } from '../../../packages/core/src/index';
import { createMcpServer } from './server';

async function main() {
  const dbPath = defaultDbPath();
  const db = openNodeSqliteDb(dbPath);
  const core = createCore(db, { dbPath });
  const { server } = createMcpServer({ core, toolFilesRoot: toolsRootForDb(dbPath) });
  let stopping: Promise<void> | undefined;
  const shutdown = () => {
    stopping ??= (async () => {
      try { await core.providerWorker.stop(); await server.close(); }
      finally { db.close(); }
    })();
    return stopping;
  };
  const stop = () => { void shutdown().catch(error => { console.error('[tododesk-mcp] 停止失败：', error); process.exitCode = 1; }); };
  server.server.onclose = stop;
  process.stdin.once('end', stop);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await server.connect(new StdioServerTransport());
  core.providerWorker.start();
  console.error(`[tododesk-mcp] 已启动，数据库：${dbPath}`);
}

main().catch((e) => {
  console.error('[tododesk-mcp] 启动失败：', e);
  process.exitCode = 1;
});
