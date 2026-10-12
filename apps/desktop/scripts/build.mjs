// 主进程 / 预加载构建：esbuild 打包为 CJS（原生模块 better-sqlite3 保持 external）
import { build, context } from 'esbuild';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

const builds = [
  {
    entryPoints: [join(root, 'src/main/index.ts')],
    outfile: join(root, 'out/main/index.js'),
    external: ['electron', 'better-sqlite3'],
  },
  {
    entryPoints: [join(root, 'src/preload/index.ts')],
    outfile: join(root, 'out/preload/index.js'),
    external: ['electron'],
  },
];

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: false,
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const ctxs = await Promise.all(builds.map((b) => context({ ...common, ...b })));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('[build] 监听变更中…');
} else {
  await Promise.all(builds.map((b) => build({ ...common, ...b })));
}
