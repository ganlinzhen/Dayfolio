// 将已验收的完整能力包同步到 Codex；旧技能移出发现目录，保留可恢复备份。
import { existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installAgentKit, verifyAgentKit } from './package.mjs';

const stat = path => { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
export const shouldSyncCodexSkill = (env = process.env) => !['1', 'true'].includes(env.CI) && env.DAYFOLIO_SKIP_CODEX_SYNC !== '1';

export function syncCodexSkill({ source, home = homedir(), codexHome = process.env.CODEX_HOME || join(home, '.codex') }) {
  source = resolve(source); codexHome = resolve(codexHome);
  const release = verifyAgentKit(source);
  const target = join(codexHome, 'dayfolio/agent-kit');
  const entry = join(codexHome, 'skills/dayfolio');
  const skill = join(target, 'skills/dayfolio');
  if (!existsSync(join(source, 'skills/dayfolio/SKILL.md'))) throw new Error('候选能力包缺少统一 dayfolio 技能');
  const lock = join(codexHome, 'dayfolio/.skill-sync-lock');
  mkdirSync(dirname(lock), { recursive: true });
  try { mkdirSync(lock); } catch (error) { if (error.code === 'EEXIST') throw new Error('Codex 技能正在同步，请等待当前任务完成'); throw error; }
  const moved = [];
  let backup = null;
  const pending = join(lock, 'dayfolio');
  try {
    mkdirSync(dirname(entry), { recursive: true });
    symlinkSync(skill, pending, 'dir');
    // 先验证并安装完整能力包；损坏或人工修改过的受管包不会被覆盖。
    installAgentKit(source, target);
    const candidates = [...new Set([join(home, '.agents/skills'), join(home, '.codex/skills'), join(codexHome, 'skills')])]
      .flatMap(dir => ['tododesk', 'tododesk-teach', 'tododesk-sports', 'dayfolio'].map(name => join(dir, name)));
    for (const path of candidates) {
      const current = stat(path);
      if (!current || (path === entry && current.isSymbolicLink() && resolve(dirname(path), readlinkSync(path)) === skill)) continue;
      backup ??= join(codexHome, 'backups/dayfolio-skills', new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID());
      mkdirSync(backup, { recursive: true });
      const saved = join(backup, String(moved.length) + '-' + path.split('/').slice(-2).join('-'));
      renameSync(path, saved); moved.push({ path, saved });
    }
    if (!stat(entry)) renameSync(pending, entry);
    if (verifyAgentKit(target).version !== release.version || !existsSync(join(entry, 'SKILL.md'))) throw new Error('Codex 技能安装回读失败');
    return { version: release.version, target, skill: entry, backup, removedEntries: moved.map(item => item.path) };
  } catch (error) {
    for (const { path, saved } of moved.reverse()) {
      if (path === entry && stat(path)?.isSymbolicLink()) rmSync(path);
      if (!stat(path)) renameSync(saved, path);
    }
    throw error;
  } finally { rmSync(lock, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = resolve(process.argv[2] ?? new URL('../../../dist/agent-kit', import.meta.url).pathname);
  try { console.log(JSON.stringify(syncCodexSkill({ source }), null, 2)); }
  catch (error) { console.error('[agent:sync-codex] ' + error.message); process.exitCode = 1; }
}
