// 开发模式：vite dev server + esbuild 监听主进程 + 拉起 Electron
import { spawn, spawnSync } from 'node:child_process';
import { watch } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

// 0. 帮助文档先同步一次；之后监听 apps/help/docs/ 变更自动重跑（vite 会对生成文件热更新）
spawnSync('node', ['../../apps/help/scripts/sync.mjs'], { cwd: root, stdio: 'inherit' });
const catalog = () => spawnSync('node', ['../../packages/agent-kit/scripts/catalog.mjs'], { cwd: root, stdio: 'inherit' });
if (catalog().status !== 0) process.exit(1);
let catalogTimer;
for (const directory of ['../../apps/mcp/src', '../../packages/agent-kit/manifest.json']) {
  watch(join(root, directory), { recursive: true }, () => {
    clearTimeout(catalogTimer);
    catalogTimer = setTimeout(catalog, 300);
  });
}
let helpTimer;
watch(join(root, '../../apps/help/docs'), { recursive: true }, () => {
  clearTimeout(helpTimer);
  helpTimer = setTimeout(() => {
    spawnSync('node', ['../../apps/help/scripts/sync.mjs'], { cwd: root, stdio: 'inherit' });
  }, 300);
});

// 1. 启动渲染层 vite dev server
const vite = spawn('npx', ['vite', 'dev', '--port', '5188', '--strictPort', '--host', '127.0.0.1'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});

// 2. 等端口就绪
const waitOn = (port) =>
  new Promise((resolve) => {
    const timer = setInterval(() => {
      const probe = spawnSync('nc', ['-z', '127.0.0.1', String(port)]);
      if (probe.status === 0) {
        clearInterval(timer);
        resolve();
      }
    }, 400);
  });
await waitOn(5188);

// 3. 先构建一次主进程/预加载，再启动 Electron（指向 dev server）
const buildOnce = spawnSync('node', ['scripts/build.mjs'], { cwd: root, stdio: 'inherit' });
if (buildOnce.status !== 0) {
  vite.kill();
  process.exit(1);
}

const electron = spawn('npx', ['electron', '.'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_START_URL: 'http://127.0.0.1:5188' },
});

const cleanup = () => {
  vite.kill();
  electron.kill();
};
electron.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(0);
});
