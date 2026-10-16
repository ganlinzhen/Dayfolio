// 能力包构建、校验与可恢复安装的共用实现；不改客户端注册配置。
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
export const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const inside = (parent, child) => { const rel = relative(resolve(parent), resolve(child)); return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel); };
function validateManifest(manifest) {
  if (manifest.schemaVersion !== 1 || manifest.name !== 'dayfolio' || manifest.serverId !== 'tododesk' || !Array.isArray(manifest.skills) || !manifest.skills.length) throw new Error('技能清单不合法');
  if (new Set(manifest.skills.map(s => s.id)).size !== manifest.skills.length) throw new Error('技能清单包含重复技能');
  for (const skill of manifest.skills) {
    if (!/^[a-z0-9-]+$/.test(skill.id) || !Array.isArray(skill.requires?.tools) || skill.requires.tools.some(name => typeof name !== 'string')) throw new Error('非法技能标识或工具依赖');
    if (skill.licenseFile && (isAbsolute(skill.licenseFile) || skill.licenseFile.split(/[\\/]/).includes('..'))) throw new Error('许可文件路径不合法');
  }
}

export function filesIn(root, rel = '') {
  const files = [];
  for (const name of readdirSync(join(root, rel)).sort()) {
    const path = join(rel, name), stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink()) throw new Error(`能力包不允许符号链接：${path}`);
    if (stat.isDirectory()) files.push(...filesIn(root, path));
    else if (stat.isFile()) files.push(path.split('\\').join('/'));
    else throw new Error(`能力包包含非普通文件：${path}`);
  }
  return files;
}

/** 校验实际完整文件集；未知文件、残留模板和被改写的文件都不视为已发布版本。 */
export function verifyAgentKit(root) {
  const release = json(join(root, 'release.json'));
  if (release.schemaVersion !== 1 || release.name !== 'dayfolio' || !/^\d+\.\d+\.\d+$/.test(release.version)) throw new Error('能力包发布清单不合法');
  const expected = Object.keys(release.files).sort();
  const actual = filesIn(root).filter(f => f !== 'release.json').sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('能力包文件缺失或混入未登记文件');
  for (const file of actual) if (digest(join(root, file)) !== release.files[file]) throw new Error(`能力包文件摘要不一致：${file}`);
  const catalog = json(join(root, 'catalog.json'));
  const manifest = json(join(root, 'manifest.json'));
  validateManifest(manifest);
  if (catalog.version !== release.version || catalog.serverId !== 'tododesk') throw new Error('MCP 目录版本或服务标识不一致');
  const names = new Set(catalog.tools.map(t => t.name));
  if (names.size !== catalog.tools.length) throw new Error('MCP 工具名称重复');
  for (const skill of manifest.skills) {
    if (!/^[a-z0-9-]+$/.test(skill.id)) throw new Error('非法技能标识');
    const dir = join(root, 'skills', skill.id);
    const md = readFileSync(join(dir, 'SKILL.md'), 'utf8');
    if (!md.startsWith('---\n') || !new RegExp('^name: *'+skill.id+' *$', 'm').test(md) || !/^description:\s*\S/m.test(md) || /\[TODO:/.test(md)) throw new Error(`${skill.id} 的技能入口不完整`);
    for (const tool of skill.requires.tools) if (!names.has(tool)) throw new Error(`${skill.id} 依赖的工具不存在：${tool}`);
    if (skill.licenseFile) {
      const license = readFileSync(join(dir, skill.licenseFile), 'utf8');
      if (!license.trim() || (skill.requiredNotices ?? []).some(notice => !license.includes(notice))) throw new Error(`${skill.id} 缺少完整许可声明`);
    }
    for (const [, target] of md.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^[a-z]+:|^#/.test(target) || target.includes('<')) continue;
      const path = resolve(dir, target.split('#')[0]);
      if (!inside(root, path) || !existsSync(path)) throw new Error(`${skill.id} 的相对引用失效：${target}`);
    }
  }
  const p = json(join(root, 'plugin.json')), z = json(join(root, '.zcode-plugin/plugin.json'));
  if (!['dayfolio', 'tododesk-teach'].includes(p.name) || p.name !== z.name || p.version !== release.version || z.version !== release.version) throw new Error('宿主清单身份或版本不一致');
  for (const file of ['mcp.json', '.mcp.json']) {
    const config = json(join(root, file)), entries = config.mcpServers;
    if (file === 'mcp.json' && config.$schema !== 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json') throw new Error('MCP 声明缺少 schema');
    const entry = entries?.tododesk;
    if (!entries || Object.keys(entries).length !== 1 || entry?.type !== 'stdio' || entry?.command !== 'node' || entry?.args?.length !== 1 || entry.args[0] !== '${CLAUDE_PLUGIN_ROOT}/mcp/mcp-server.cjs' || JSON.stringify(entry.env ?? {}).includes('${')) throw new Error('MCP 接入声明不兼容');
  }
  if (JSON.stringify(json(join(root, 'mcp.json')).mcpServers) !== JSON.stringify(json(join(root, '.mcp.json')).mcpServers)) throw new Error('两个宿主的 MCP 声明不一致');
  return release;
}

/** 在源码工作区验收时，还要确认产物对应当前源码，而非仅内部自洽。 */
export function verifySourceFreshness(bundle, root) {
  const source = join(root, 'packages/agent-kit');
  const version = json(join(root, 'package.json')).version;
  if (json(join(bundle, 'release.json')).version !== version) throw new Error('能力包版本陈旧，请重新构建');
  for (const dir of ['skills', 'runtime']) {
    const expected = filesIn(join(source, dir));
    if (JSON.stringify(expected) !== JSON.stringify(filesIn(join(bundle, dir)))) throw new Error(`${dir} 文件集与源码不一致`);
    for (const file of expected) if (digest(join(source, dir, file)) !== digest(join(bundle, dir, file))) throw new Error(`能力包源码已更新，请重新构建：${dir}/${file}`);
  }
  for (const [from, to] of [['apps/mcp/dist/mcp-server.cjs', 'mcp/mcp-server.cjs'], ['apps/mcp/dist/agent-catalog.json', 'catalog.json'], ['packages/agent-kit/manifest.json', 'manifest.json']]) {
    if (digest(join(root, from)) !== digest(join(bundle, to))) throw new Error(`构建产物陈旧：${to}`);
  }
  for (const script of ['package.mjs', 'verify.mjs']) if (digest(join(source, 'scripts', script)) !== digest(join(bundle, 'scripts', script))) throw new Error(`维护脚本陈旧：${script}`);
  for (const [from, to] of [['codex/plugin.json', 'plugin.json'], ['codex/mcp.json', 'mcp.json'], ['zcode/plugin.json', '.zcode-plugin/plugin.json'], ['zcode/mcp.json', '.mcp.json']]) {
    const expected = JSON.parse(readFileSync(join(source, 'hosts', from), 'utf8').replaceAll('{{version}}', version));
    const actual = json(join(bundle, to));
    if (to.endsWith('plugin.json') && actual.name === 'tododesk-teach') expected.name = 'tododesk-teach';
    if (!isDeepStrictEqual(expected, actual)) throw new Error(`宿主模板已更新，请重新构建：${from}`);
  }
  const inputs = json(join(bundle, 'build-inputs.json'));
  for (const [file, hash] of Object.entries(inputs)) {
    if (!inside(root, resolve(root, file)) || digest(join(root, file)) !== hash) throw new Error(`MCP 源码在构建后变更，请重新构建：${file}`);
  }
}

export function buildAgentKit({ root, outDir = join(root, 'dist/agent-kit') }) {
  outDir = resolve(outDir);
  if (outDir === root || inside(outDir, root) || inside(join(root, 'packages'), outDir) || inside(join(root, 'apps'), outDir)) throw new Error('构建目录不能覆盖源码');
  const source = join(root, 'packages/agent-kit');
  const manifest = json(join(source, 'manifest.json'));
  validateManifest(manifest);
  const { version } = json(join(root, 'package.json'));
  const stage = outDir + '.stage-' + randomUUID();
  const backup = outDir + '.previous-' + randomUUID();
  mkdirSync(stage, { recursive: true });
  try {
    for (const skill of manifest.skills) {
      const dir = join(source, 'skills', skill.id);
      filesIn(dir); // 在复制之前拒绝逃出能力包的链接。
      cpSync(dir, join(stage, 'skills', skill.id), { recursive: true });
    }
    cpSync(join(source, 'runtime'), join(stage, 'runtime'), { recursive: true });
    mkdirSync(join(stage, 'scripts'), { recursive: true });
    for (const script of ['package.mjs', 'verify.mjs']) cpSync(join(source, 'scripts', script), join(stage, 'scripts', script));
    for (const alias of ['validate-package.mjs', 'install-verify.mjs']) writeFileSync(join(stage, 'scripts', alias), "// 自动生成的兼容入口。\nimport { main } from './verify.mjs';\nmain();\n");
    const sportsProbe = join(source, 'test/verify-sports-skill.mjs');
    if (existsSync(sportsProbe)) cpSync(sportsProbe, join(stage, 'scripts/verify-sports-skill.mjs'));
    mkdirSync(join(stage, 'mcp'), { recursive: true });
    cpSync(join(root, 'apps/mcp/dist/mcp-server.cjs'), join(stage, 'mcp/mcp-server.cjs'));
    cpSync(join(root, 'apps/mcp/dist/agent-catalog.json'), join(stage, 'catalog.json'));
    if (existsSync(join(root, 'apps/mcp/dist/build-inputs.json'))) cpSync(join(root, 'apps/mcp/dist/build-inputs.json'), join(stage, 'build-inputs.json'));
    cpSync(join(source, 'manifest.json'), join(stage, 'manifest.json'));
    for (const [from, to] of [['codex/plugin.json', 'plugin.json'], ['codex/mcp.json', 'mcp.json'], ['zcode/plugin.json', '.zcode-plugin/plugin.json'], ['zcode/mcp.json', '.mcp.json']]) {
      mkdirSync(dirname(join(stage, to)), { recursive: true });
      writeFileSync(join(stage, to), readFileSync(join(source, 'hosts', from), 'utf8').replaceAll('{{version}}', version));
    }
    const files = Object.fromEntries(filesIn(stage).map(file => [file, digest(join(stage, file))]));
    writeFileSync(join(stage, 'release.json'), JSON.stringify({ schemaVersion: 1, name: 'dayfolio', version, files }, null, 2) + '\n');
    verifyAgentKit(stage);
    if (existsSync(outDir)) renameSync(outDir, backup);
    try { renameSync(stage, outDir); } catch (error) { if (existsSync(backup)) renameSync(backup, outDir); throw error; }
    rmSync(backup, { recursive: true, force: true });
    return outDir;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

/** 只更新显式指定的受管能力包目录；现有文件有人工改动时停止，不覆盖。 */
export function installAgentKit(source, target, options = {}) {
  source = resolve(source); target = resolve(target);
  if (source === target || inside(source, target) || inside(target, source)) throw new Error('安装源与目标目录不能互相包含');
  if (options.dryRun) return installManagedPackage(source, target, options);
  mkdirSync(dirname(target), { recursive: true });
  const lock = target + '.update-lock';
  try { mkdirSync(lock); } catch (error) { if (error.code === 'EEXIST') throw new Error(`能力包正在更新或存在遗留更新锁：${lock}`); throw error; }
  try { return installManagedPackage(source, target, options); }
  finally { rmSync(lock, { recursive: true, force: true }); }
}

function installManagedPackage(source, target, { dryRun = false, rollback = false } = {}) {
  source = resolve(source); target = resolve(target);
  if (source === target || inside(source, target) || inside(target, source)) throw new Error('安装源与目标目录不能互相包含');
  const backup = target + '.previous';
  if (lstatSafe(target)?.isSymbolicLink() || lstatSafe(backup)?.isSymbolicLink()) throw new Error('安装目录不能是符号链接');
  if (rollback) {
    const previous = verifyAgentKit(backup);
    if (existsSync(target)) verifyAgentKit(target);
    if (dryRun) return { version: previous.version, target, rollback: true, dryRun };
    const temp = target + '.swap-' + randomUUID();
    if (existsSync(target)) renameSync(target, temp);
    try { renameSync(backup, target); } catch (error) { if (existsSync(temp)) renameSync(temp, target); throw error; }
    if (existsSync(temp)) renameSync(temp, backup);
    return { version: previous.version, target, rollback: true };
  }
  const release = verifyAgentKit(source);
  if (existsSync(target)) verifyAgentKit(target);
  if (existsSync(backup)) verifyAgentKit(backup);
  if (dryRun) return { version: release.version, target, dryRun };
  mkdirSync(dirname(target), { recursive: true });
  const stage = target + '.stage-' + randomUUID();
  try {
    cpSync(source, stage, { recursive: true }); verifyAgentKit(stage);
    if (existsSync(target)) { rmSync(backup, { recursive: true, force: true }); renameSync(target, backup); }
    try { renameSync(stage, target); } catch (error) { if (existsSync(backup)) renameSync(backup, target); throw error; }
    return { version: release.version, target };
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

function lstatSafe(file) { try { return lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
