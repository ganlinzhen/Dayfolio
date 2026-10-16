// apps/plugin 仅保留为旧接入路径的自动生成副本，插件身份兼容 tododesk-teach。
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, filesIn, installAgentKit, verifyAgentKit } from './package.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const source = join(root, 'dist/agent-kit'), target = join(root, 'apps/plugin');
if (process.argv.includes('--verify')) {
  const release = verifyAgentKit(target);
  if (release.version !== JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version) throw new Error('兼容插件版本陈旧，运行 npm run plugin:build');
  for (const file of ['mcp/mcp-server.cjs', 'catalog.json', ...filesIn(join(source, 'skills')).map(f => 'skills/' + f)]) {
    if (digest(join(source, file)) !== digest(join(target, file))) throw new Error(`兼容插件产物陈旧：${file}`);
  }
  console.log('[plugin:verify] 兼容入口与统一能力包一致');
} else {
  if (existsSync(target) && !existsSync(join(target, 'release.json'))) throw new Error('apps/plugin 尚有旧源码；先完成源码迁移，不能覆盖。');
  const work = mkdtempSync(join(tmpdir(), 'dayfolio-legacy-'));
  try {
    const stage = join(work, 'plugin'); cpSync(source, stage, { recursive: true });
    for (const file of ['plugin.json', '.zcode-plugin/plugin.json']) {
      const path = join(stage, file), manifest = JSON.parse(readFileSync(path, 'utf8'));
      manifest.name = 'tododesk-teach'; writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
    }
    const release = JSON.parse(readFileSync(join(stage, 'release.json'), 'utf8'));
    release.files = Object.fromEntries(filesIn(stage).filter(f => f !== 'release.json').map(f => [f, digest(join(stage, f))]));
    writeFileSync(join(stage, 'release.json'), JSON.stringify(release, null, 2) + '\n');
    installAgentKit(stage, target);
    rmSync(target + '.previous', { recursive: true, force: true });
    console.log('[plugin:build] 已生成兼容插件：' + target);
  } finally { rmSync(work, { recursive: true, force: true }); }
}
