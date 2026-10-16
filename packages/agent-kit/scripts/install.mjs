import { installAgentKit } from './package.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const args = process.argv.slice(2);
const value = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const target = value('--target');
if (!target) {
  console.error('用法：npm run agent:install -- --target <能力包目录> [--source <候选包>] [--dry-run] [--rollback]。保留客户端配置，安装后按宿主方式加载；回滚前请检查旧 MCP 与当前数据库兼容性。');
  process.exitCode = 2;
} else {
  try { console.log(JSON.stringify(installAgentKit(resolve(value('--source') ?? join(repoRoot, 'dist/agent-kit')), resolve(target), { dryRun: args.includes('--dry-run'), rollback: args.includes('--rollback') }), null, 2)); }
  catch (error) { console.error('[agent:install] ' + error.message); process.exitCode = 1; }
}
