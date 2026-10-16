// 使用 Node 内置模块生成资源摘要；每个新工具不运行宿主构建或代码生成。
import { readdirSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = resolve(process.argv[2] ?? '');
try {
 if (!process.argv[2] || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error('请提供非符号链接的工具包目录');
 const manifestPath = join(root, 'manifest.json');
 const info=lstatSync(manifestPath);if(info.isSymbolicLink()||!info.isFile()||info.size>1024*1024)throw new Error('manifest 必须是有界普通文件');
 const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
 const files = {};
 const walk = directory => { for (const entry of readdirSync(directory, { withFileTypes: true })) {
  const path = join(directory, entry.name), name = relative(root, path).split('\\').join('/');
  if (name === 'manifest.json') continue;
  if (entry.isSymbolicLink()) throw new Error('拒绝符号链接：' + name);
  if (entry.isDirectory()) walk(path);
  else if (entry.isFile()) {if(lstatSync(path).size>5*1024*1024)throw new Error('单个资源超过5MiB：'+name);files[name] = createHash('sha256').update(readFileSync(path)).digest('hex');}
  else throw new Error('拒绝非普通资源：' + name);
 }};
 walk(root); manifest.files = files;
 writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
 const result = spawnSync(process.execPath, [fileURLToPath(new URL('./validate.cjs', import.meta.url)), root], { stdio: 'inherit' });
 process.exitCode = result.status ?? 1;
} catch (error) { console.error('打包失败：' + error.message); process.exitCode = 1; }
