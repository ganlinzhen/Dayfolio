// 统一 MCP 构建入口；保留旧产物路径，并记录实际参与构建的源码摘要。
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const result = await build({ absWorkingDir: root, entryPoints: ['apps/mcp/src/index.ts'], outfile: 'apps/mcp/dist/mcp-server.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['node:*'], loader: { '.md': 'text' }, metafile: true, logLevel: 'warning' });
const paths = new Set([...Object.keys(result.metafile.inputs).filter(p => !p.includes('node_modules/')), 'apps/mcp/scripts/build.mjs', 'package-lock.json']);
const inputs = Object.fromEntries([...paths].sort().map(p => [p, createHash('sha256').update(readFileSync(join(root, p))).digest('hex')]));
mkdirSync(join(root, 'apps/mcp/dist'), { recursive: true });
writeFileSync(join(root, 'apps/mcp/dist/build-inputs.json'), JSON.stringify(inputs, null, 2) + '\n');
