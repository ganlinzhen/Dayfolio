import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildAgentKit, digest, filesIn, installAgentKit, verifyAgentKit, verifySourceFreshness } from '../scripts/package.mjs';
import { shouldSyncCodexSkill, syncCodexSkill } from '../scripts/sync-codex.mjs';

let work: string;
let root: string;
const write = (path: string, content: string) => { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, content); };
const make = () => buildAgentKit({ root, outDir: join(work, 'candidate') });
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'dayfolio-kit-test-')); root = join(work, 'repo');
  cpSync(new URL('../hosts', import.meta.url), join(root, 'packages/agent-kit/hosts'), { recursive: true });
  for (const script of ['package.mjs', 'verify.mjs']) {
    const to = join(root, 'packages/agent-kit/scripts', script); mkdirSync(resolve(to, '..'), { recursive: true }); cpSync(new URL('../scripts/' + script, import.meta.url), to);
  }
  write(join(root, 'package.json'), JSON.stringify({ version: '0.20.0' }));
  write(join(root, 'packages/agent-kit/manifest.json'), JSON.stringify({ schemaVersion: 1, name: 'dayfolio', serverId: 'tododesk', skills: [{ id: 'dayfolio', requires: { tools: ['get_today'] } }] }));
  write(join(root, 'packages/agent-kit/skills/dayfolio/SKILL.md'), '---\nname: dayfolio\ndescription: 读取今日任务\n---\n使用 get_today。');
  write(join(root, 'packages/agent-kit/runtime/call.mjs'), '// 隔离构建夹具\n');
  write(join(root, 'apps/mcp/dist/mcp-server.cjs'), '// 隔离构建夹具\n');
  write(join(root, 'apps/mcp/dist/agent-catalog.json'), JSON.stringify({ version: '0.20.0', serverId: 'tododesk', tools: [{ name: 'get_today' }] }));
  write(join(root, 'apps/mcp/dist/build-inputs.json'), JSON.stringify({ 'package.json': digest(join(root, 'package.json')) }));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

describe('统一能力包的构建与更新', () => {
  it('只允许统一入口，内部参考缺失时保留旧产物', () => {
    const source = make();
    write(join(root, 'packages/agent-kit/skills/dayfolio/references/teaching.md'), '[赛事](sports.md)');
    expect(() => make()).toThrow('引用');
    expect(verifyAgentKit(source).version).toBe('0.20.0');
    write(join(root, 'packages/agent-kit/manifest.json'), JSON.stringify({ schemaVersion: 1, name: 'dayfolio', serverId: 'tododesk', skills: [{ id: 'dayfolio', requires: { tools: [] } }, { id: 'tododesk-teach', requires: { tools: [] } }] }));
    expect(() => make()).toThrow('一个 dayfolio');
  });

  it('同步 Codex 时备份旧入口，在异地安装完整包且重复执行只保留一个入口', () => {
    const source = make(), home = join(work, 'home'), codexHome = join(home, '自选Codex');
    write(join(home, '.agents/skills/tododesk/SKILL.md'), '我的旧技能');
    mkdirSync(join(home, '.codex/skills'), { recursive: true });
    symlinkSync(join(work, '不再存在的旧源码'), join(home, '.codex/skills/tododesk-sports'));
    write(join(codexHome, 'skills/tododesk-teach/SKILL.md'), '旧教学');
    write(join(codexHome, 'skills/other/SKILL.md'), '其他技能');
    const first = syncCodexSkill({ source, home, codexHome });
    expect(first.removedEntries).toHaveLength(3);
    expect(readFileSync(join(first.backup!, '0-skills-tododesk/SKILL.md'), 'utf8')).toBe('我的旧技能');
    expect(readlinkSync(first.skill)).toBe(join(first.target, 'skills/dayfolio'));
    expect(verifyAgentKit(first.target).version).toBe('0.20.0');
    expect(readFileSync(join(codexHome, 'skills/other/SKILL.md'), 'utf8')).toBe('其他技能');
    expect(readdirSync(join(home, '.agents/skills'))).toEqual([]);
    expect(readdirSync(join(home, '.codex/skills'))).toEqual([]);
    expect(syncCodexSkill({ source, home, codexHome }).removedEntries).toEqual([]);
    write(join(root, 'package.json'), JSON.stringify({ version: '0.21.0' }));
    write(join(root, 'apps/mcp/dist/agent-catalog.json'), JSON.stringify({ version: '0.21.0', serverId: 'tododesk', tools: [{ name: 'get_today' }] }));
    make();
    expect(syncCodexSkill({ source, home, codexHome }).version).toBe('0.21.0');
    expect(readFileSync(join(first.skill, 'SKILL.md'), 'utf8')).toContain('name: dayfolio');
    expect(verifyAgentKit(first.target + '.previous').version).toBe('0.20.0');
  });

  it('同步失败不会移除旧技能；CI 与隔离验收可跳过自动同步', () => {
    const source = make(), home = join(work, 'home'), codexHome = join(home, '.codex');
    const result = syncCodexSkill({ source, home, codexHome });
    write(join(result.target, 'skills/dayfolio/SKILL.md'), '我的改写');
    write(join(home, '.agents/skills/tododesk/SKILL.md'), '必须保留');
    expect(() => syncCodexSkill({ source, home, codexHome })).toThrow('摘要');
    expect(readFileSync(join(home, '.agents/skills/tododesk/SKILL.md'), 'utf8')).toBe('必须保留');
    expect(shouldSyncCodexSkill({})).toBe(true);
    expect(shouldSyncCodexSkill({ CI: 'true' })).toBe(false);
    expect(shouldSyncCodexSkill({ DAYFOLIO_SKIP_CODEX_SYNC: '1' })).toBe(false);
  });

  it('从三个旧技能的完整能力包更新时清理旧文件，保留可恢复上一版', () => {
    const source = make(), target = join(work, 'legacy');
    cpSync(source, target, { recursive: true });
    rmSync(join(target, 'skills'), { recursive: true });
    const skills = ['tododesk', 'tododesk-teach', 'tododesk-sports'].map(id => ({ id, requires: { tools: ['get_today'] } }));
    write(join(target, 'manifest.json'), JSON.stringify({ schemaVersion: 1, name: 'dayfolio', serverId: 'tododesk', skills }));
    for (const { id } of skills) write(join(target, `skills/${id}/SKILL.md`), `---\nname: ${id}\ndescription: 旧入口\n---\n读取 get_today。`);
    const release = JSON.parse(readFileSync(join(target, 'release.json'), 'utf8'));
    release.files = Object.fromEntries(filesIn(target).filter(file => file !== 'release.json').map(file => [file, digest(join(target, file))]));
    write(join(target, 'release.json'), JSON.stringify(release));
    expect(() => verifyAgentKit(target)).toThrow('一个 dayfolio');
    installAgentKit(source, target);
    expect(readdirSync(join(target, 'skills'))).toEqual(['dayfolio']);
    expect(verifyAgentKit(target + '.previous', { allowLegacySkills: true }).version).toBe('0.20.0');
  });

  it('作者校验器缺失时保留旧产物；合同或校验器变更使旧能力包失效', () => {
    const previous = make(), before = digest(join(previous, 'release.json'));
    write(join(root, 'packages/agent-kit/extension-tools/README.md'), '隔离作者夹具');
    write(join(root, 'packages/core/src/contracts/event.schema.json'), '{"type":"object"}');
    expect(() => make()).toThrow();
    expect(digest(join(previous, 'release.json'))).toBe(before);
    expect(() => verifyAgentKit(previous)).not.toThrow();
    write(join(root, 'apps/mcp/dist/extension-validator.cjs'), '// 隔离校验器夹具，不冒充真实校验逻辑\n');
    const built = make();
    expect(readFileSync(join(built, 'extension-tools/contracts/event.schema.json'), 'utf8')).toContain('object');
    expect(() => verifySourceFreshness(built, root)).not.toThrow();
    write(join(root, 'packages/core/src/contracts/event.schema.json'), '{"type":"array"}');
    expect(() => verifySourceFreshness(built, root)).toThrow('作者合同');
    write(join(root, 'packages/core/src/contracts/event.schema.json'), '{"type":"object"}');
    write(join(root, 'apps/mcp/dist/extension-validator.cjs'), '// 已变化的隔离夹具\n');
    expect(() => verifySourceFreshness(built, root)).toThrow('校验器陈旧');
  });

  it('在任意路径安装完整包，保留既有配置，支持更新与恢复上一版', () => {
    const source = make(), target = join(work, '异地安装/Dayfolio-Agent');
    const config = join(work, 'client.json'); write(config, '{"mcpServers":{"other":{}}}');
    const before = readFileSync(config, 'utf8');
    expect(installAgentKit(source, target, { dryRun: true }).version).toBe('0.20.0');
    expect(existsSync(target)).toBe(false);
    installAgentKit(source, target); expect(verifyAgentKit(target).version).toBe('0.20.0');
    write(join(root, 'package.json'), JSON.stringify({ version: '0.21.0' }));
    write(join(root, 'apps/mcp/dist/agent-catalog.json'), JSON.stringify({ version: '0.21.0', serverId: 'tododesk', tools: [{ name: 'get_today' }] }));
    make(); installAgentKit(source, target);
    expect(verifyAgentKit(target).version).toBe('0.21.0');
    installAgentKit(source, target, { rollback: true });
    expect(verifyAgentKit(target).version).toBe('0.20.0');
    expect(readFileSync(config, 'utf8')).toBe(before);
  });

  it('拒绝覆盖人工修改过的能力包，并保留修改', () => {
    const source = make(), target = join(work, 'installed'); installAgentKit(source, target);
    const skill = join(target, 'skills/dayfolio/SKILL.md'); writeFileSync(skill, '我的改写');
    expect(() => installAgentKit(source, target)).toThrow('摘要');
    expect(readFileSync(skill, 'utf8')).toBe('我的改写');
  });

  it('拒绝接管不属于 Dayfolio 的目录', () => {
    const source = make(), target = join(work, 'foreign'); mkdirSync(target); write(join(target, 'note.txt'), '用户文件');
    expect(() => installAgentKit(source, target)).toThrow();
    expect(readFileSync(join(target, 'note.txt'), 'utf8')).toBe('用户文件');
  });

  it('拒绝缺失文件、未知文件和破损的更新候选，已安装版本仍然可用', () => {
    const source = make(), target = join(work, 'installed'); installAgentKit(source, target);
    write(join(source, 'unknown.txt'), '混入文件'); expect(() => verifyAgentKit(source)).toThrow('文件');
    expect(() => installAgentKit(source, target)).toThrow();
    expect(verifyAgentKit(target).version).toBe('0.20.0');
    rmSync(join(source, 'unknown.txt')); rmSync(join(source, 'mcp/mcp-server.cjs'));
    expect(() => verifyAgentKit(source)).toThrow('文件');
  });

  it('构建失败时保留上次产物，校验技能工具依赖及相对引用', () => {
    const source = make();
    write(join(root, 'apps/mcp/dist/agent-catalog.json'), JSON.stringify({ version: '0.20.0', serverId: 'tododesk', tools: [] }));
    expect(() => make()).toThrow('依赖'); expect(verifyAgentKit(source).version).toBe('0.20.0');
    write(join(root, 'apps/mcp/dist/agent-catalog.json'), JSON.stringify({ version: '0.20.0', serverId: 'tododesk', tools: [{ name: 'get_today' }] }));
    write(join(root, 'packages/agent-kit/skills/dayfolio/SKILL.md'), '---\nname: dayfolio\ndescription: 读取今日任务\n---\n[参考](references/missing.md)');
    expect(() => make()).toThrow('引用'); expect(verifyAgentKit(source).version).toBe('0.20.0');
  });

  it('拒绝源技能和安装目录中的符号链接', () => {
    const source = make();
    symlinkSync(source, join(work, 'alias'));
    expect(() => installAgentKit(source, join(work, 'alias'))).toThrow('符号链接');
    symlinkSync(join(work, '外部文件'), join(root, 'packages/agent-kit/skills/dayfolio/external'));
    expect(() => make()).toThrow('符号链接');
  });

  it('并行更新锁阻止第二个安装者，既有包保持可读', () => {
    const source = make(), target = join(work, 'installed'); installAgentKit(source, target);
    mkdirSync(target + '.update-lock');
    expect(() => installAgentKit(source, target)).toThrow('更新锁');
    expect(verifyAgentKit(target).version).toBe('0.20.0');
  });

  it('非法技能目录在复制之前被拒绝，不写出构建目录', () => {
    write(join(root, 'packages/agent-kit/manifest.json'), JSON.stringify({ schemaVersion: 1, name: 'dayfolio', serverId: 'tododesk', skills: [{ id: '../../../escape', requires: { tools: [] } }] }));
    expect(() => make()).toThrow('非法技能');
    expect(existsSync(join(work, 'escape'))).toBe(false);
  });

  it('源码或宿主模板更新后，旧产物不能通过新鲜度验收', () => {
    const source = make();
    expect(() => verifySourceFreshness(source, root)).not.toThrow();
    const template = join(root, 'packages/agent-kit/hosts/codex/mcp.json');
    const before = readFileSync(template, 'utf8');
    writeFileSync(template, before.replace('"node"', '"custom-node"'));
    expect(() => verifySourceFreshness(source, root)).toThrow('宿主模板');
    writeFileSync(template, before);
    write(join(root, 'package.json'), JSON.stringify({ version: '0.20.0', description: '构建输入已变化' }));
    expect(() => verifySourceFreshness(source, root)).toThrow('构建后变更');
    expect(verifyAgentKit(source).version).toBe('0.20.0');
  });
});
