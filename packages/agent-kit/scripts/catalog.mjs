// 从 MCP 实际注册生成 App 和分发包共用目录；临时构建只使用内存数据库。
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const work = mkdtempSync(join(tmpdir(), 'dayfolio-catalog-'));
try {
  const outfile = join(work, 'catalog.cjs');
  await build({ entryPoints: [join(root, 'apps/mcp/src/catalog.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['node:*'], loader: { '.md': 'text' }, logLevel: 'warning' });
  const tools = createRequire(import.meta.url)(outfile).collectToolCatalog();
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(root, 'packages/agent-kit/manifest.json'), 'utf8'));
  const names = new Set(tools.map(t => t.name));
  if (names.size !== tools.length) throw new Error('MCP 工具名称重复');
  for (const skill of manifest.skills) {
    for (const name of skill.requires.tools) if (!names.has(name)) throw new Error(`${skill.id} 依赖的工具不存在：${name}`);
  }
  const sections = [];
  for (const tool of tools) {
    let section = sections.find(s => s.title === tool.group.section);
    if (!section) sections.push(section = { title: tool.group.section, hint: tool.group.section === '业务模块' ? '与 App 共用业务规则' : '对象、关系、查询和动作', groups: [] });
    let group = section.groups.find(g => g.id === tool.group.id);
    if (!group) section.groups.push(group = { ...tool.group, tools: [] });
    group.tools.push({ name: tool.name, desc: tool.desc });
  }
  const catalog = { schemaVersion: 1, name: manifest.name, version, serverId: manifest.serverId, tools, skills: manifest.skills };
  const dist = join(root, 'apps/mcp/dist'); mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'agent-catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
  const generated = join(root, 'apps/desktop/src/renderer/src/generated/agentCatalog.ts');
  writeFileSync(generated, '// 自动生成：运行 npm run agent:catalog，禁止手改。\nexport const MCP_SECTIONS = ' + JSON.stringify(sections, null, 2) + ';\nexport const AGENT_SKILLS = ' + JSON.stringify(manifest.skills, null, 2) + ';\n');
  console.log(`[agent:catalog] ${tools.length} 个工具、${manifest.skills.length} 个技能，目录已同步`);
} finally { rmSync(work, { recursive: true, force: true }); }
