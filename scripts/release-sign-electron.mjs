// 发布准备：Intel Electron 分发包中的部分内嵌程序未签名，先补齐叶子代码签名。
// 随后的正式打包脚本继续从内到外签署 Framework、辅助 App 和主 App。
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('Electron 签名准备只能在 macOS 上执行');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = resolve(process.argv[2] ?? join(root, 'node_modules/electron/dist/Electron.app'));
if (basename(app) !== 'Electron.app') throw new Error('目标必须是待打包的 Electron.app');
let signed = 0;
function visit(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    // 不跟随 Framework 的 Current 等符号链接，避免重复或越界遍历。
    if (entry.isDirectory()) visit(path);
    else if (entry.isFile()) {
      const type = execFileSync('/usr/bin/file', ['-b', path], { encoding: 'utf8' });
      if (!type.startsWith('Mach-O')) continue;
      const verification = spawnSync('/usr/bin/codesign', ['--verify', '--strict', path], { encoding: 'utf8' });
      if (verification.error) throw verification.error;
      if (verification.status === 0) continue;
      execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', path], { stdio: 'inherit' });
      execFileSync('/usr/bin/codesign', ['--verify', '--strict', path]);
      signed++;
    }
  }
}
visit(join(app, 'Contents'));
console.log(`Electron 内嵌代码签名准备完成，补签 ${signed} 个文件`);
