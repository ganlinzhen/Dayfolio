// 渲染层（React）Vite 配置
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vite';

const root = new URL('.', import.meta.url).pathname;
const monorepo = join(root, '..', '..');
const pkg = JSON.parse(readFileSync(join(monorepo, 'package.json'), 'utf8'));

export default defineConfig({
  root: join(root, 'src/renderer'),
  define: {
    // 版本与发版记录：构建时从根 package.json / CHANGELOG.md 注入，渲染层只读展示
    __APP_VERSION__: JSON.stringify(pkg.version),
    __CHANGELOG__: JSON.stringify(readFileSync(join(monorepo, 'CHANGELOG.md'), 'utf8')),
  },
  plugins: [react()],
  base: './',
  clearScreen: false,
  server: {
    port: 5188,
    strictPort: true,
  },
  build: {
    outDir: join(root, 'out/renderer'),
    emptyOutDir: true,
  },
});
