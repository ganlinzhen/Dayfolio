// 将已验收的 macOS App 归档为可下载文件，保留符号链接、权限与签名。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('macOS 下载包必须在 macOS 上制作');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (!['arm64', 'x64'].includes(process.arch)) throw new Error(`不支持的架构：${process.arch}`);
if (process.env.RELEASE_ARCH && process.env.RELEASE_ARCH !== process.arch) throw new Error('构建机器架构与目标下载包不一致');
const app = join(root, 'apps/desktop/release/Dayfolio.app');
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim();
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
const plist = join(app, 'Contents/Info.plist');
for (const field of ['CFBundleShortVersionString', 'CFBundleVersion']) {
  if (run('/usr/libexec/PlistBuddy', ['-c', `Print :${field}`, plist]) !== version) throw new Error('App 版本与源码不一致');
}
const expected = process.arch === 'x64' ? 'x86_64' : 'arm64';
for (const binary of [
  join(app, 'Contents/MacOS/Dayfolio'),
  join(app, 'Contents/Resources/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node'),
]) {
  if (!existsSync(binary) || !run('/usr/bin/lipo', ['-archs', binary]).split(/\s+/).includes(expected)) throw new Error(`二进制架构不一致：${binary}`);
}
const out = join(root, 'dist/github-release/assets');
mkdirSync(out, { recursive: true });
const name = `Dayfolio-${version}-macOS-${process.arch}.zip`;
const archive = join(out, name);
run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
const hash = createHash('sha256');
for await (const chunk of createReadStream(archive)) hash.update(chunk);
const digest = hash.digest('hex');
writeFileSync(`${archive}.sha256`, `${digest}  ${name}\n`);
console.log(`下载包：${archive}\nSHA-256：${digest}`);
