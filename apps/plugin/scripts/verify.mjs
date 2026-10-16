import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyAgentKit, verifySourceFreshness } from './package.mjs';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export function probeAgentKit(root) {
  verifyAgentKit(root);
  const work = mkdtempSync(join(tmpdir(), 'dayfolio-agent-probe-'));
  const home = join(work, 'home'); mkdirSync(home);
  const env = { PATH: process.env.PATH, HOME: home, TODODESK_DB: join(work, 'probe.db'), TODODESK_USER_DATA: join(work, 'user-data') };
  const run = args => {
    const result = spawnSync(process.execPath, [join(root, 'runtime/call.mjs'), ...args], { cwd: work, env, encoding: 'utf8', timeout: 65_000 });
    if (result.status !== 0) throw new Error('隔离 MCP 调用失败：' + (result.stderr || result.error?.message));
    return result.stdout;
  };
  try {
    const names = run(['list']).trim().split('\n').map(line => line.split('\t')[0]).sort();
    const catalog = JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8'));
    if (JSON.stringify(names) !== JSON.stringify(catalog.tools.map(t => t.name).sort())) throw new Error('分发目录与实际 MCP 工具列表不一致');
    const title = '能力包隔离验收';
    const added = JSON.parse(run(['call', 'add_todo', JSON.stringify({ title })]));
    const queried = JSON.parse(run(['call', 'list_todos', JSON.stringify({ search: title })]));
    if (!added.ok || !queried.ok || queried.data.todos.length !== 1 || queried.data.todos[0].id !== added.data.id) throw new Error('隔离写入与回读不一致');
    return { tools: names.length, isolatedReadWrite: true };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

export function main(args = process.argv.slice(2)) {
  try {
    const parent = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const root = resolve(args.find(a => !a.startsWith('--')) ?? (existsSync(join(parent, 'release.json')) ? parent : join(repoRoot, 'dist/agent-kit')));
    const release = verifyAgentKit(root);
    if ([join(repoRoot, 'dist/agent-kit'), join(repoRoot, 'apps/plugin')].includes(root) && existsSync(join(repoRoot, 'packages/agent-kit/manifest.json'))) verifySourceFreshness(root, repoRoot);
    const probe = args.includes('--skip-probe') ? null : probeAgentKit(root);
    console.log(JSON.stringify({ ok: true, version: release.version, probe }, null, 2));
  } catch (error) { console.error('[agent:verify] ' + error.message); process.exitCode = 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
