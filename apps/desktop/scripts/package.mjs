// 打包脚本：复用 node_modules/electron/dist 的 Electron.app 骨架组装 Dayfolio.app
// 产物：apps/desktop/release/Dayfolio.app（未公证，ad-hoc 签名，本机可直接运行）
import { cpSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname; // apps/desktop
const monorepo = join(root, '..', '..');
// 版本号以仓库根 package.json 为单一来源（渲染层界面与安装包 Info.plist 均由此注入）
const { version } = JSON.parse(readFileSync(join(monorepo, 'package.json'), 'utf8'));

// 1. 校验构建产物（需先 npm run build:desktop）
for (const p of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']) {
  if (!existsSync(join(root, p))) {
    console.error(`[package] 缺少构建产物 ${p}，请先运行 npm run build:desktop`);
    process.exit(1);
  }
}

const electronDist = join(monorepo, 'node_modules', 'electron', 'dist', 'Electron.app');
if (!existsSync(electronDist)) {
  console.error(`[package] 未找到 Electron 骨架：${electronDist}`);
  process.exit(1);
}

// 2. 复制 Electron.app 骨架
const releaseDir = join(root, 'release');
const appPath = join(releaseDir, 'Dayfolio.app');
rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(releaseDir, { recursive: true });
// 必须用系统 cp -R：Node cpSync 会把相对 symlink 解析成指向源的绝对路径，
// 导致 codesign 报 unsealed contents 且安装后链接失效
execFileSync('cp', ['-R', electronDist, appPath]);
console.log('[package] 已复制 Electron 骨架');

// 图标：正式版写入剑形徽章 icns（开发版 DEV 角标由主进程在未打包环境叠加，见 src/main/index.ts）
cpSync(join(root, 'build', 'icon.icns'), join(appPath, 'Contents', 'Resources', 'icon.icns'));

// 3. 修改 Info.plist（展示名与可执行文件同步更名，保留 bundle id 兼容原安装）
const plist = join(appPath, 'Contents', 'Info.plist');
const set = (key, value) =>
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
set('CFBundleName', 'Dayfolio');
set('CFBundleDisplayName', 'Dayfolio');
set('CFBundleIconFile', 'icon');
set('CFBundleExecutable', 'Dayfolio'); // 与下一步重命名联动
set('CFBundleIdentifier', 'com.zhenganlin.tododesk');
set('CFBundleShortVersionString', version);
set('CFBundleVersion', version);
// 重命名可执行文件，Dock/活动监视器里显示 Dayfolio 而非 Electron
rmSync(join(appPath, 'Contents', 'MacOS', 'Electron'));
cpSync(
  join(monorepo, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
  join(appPath, 'Contents', 'MacOS', 'Dayfolio'),
);
console.log('[package] 已写入 Info.plist 并重命名可执行文件');

// 4. 组装 Resources/app：入口清单 + out 产物 + 运行时原生依赖
const appDir = join(appPath, 'Contents', 'Resources', 'app');
mkdirSync(appDir, { recursive: true });
writeFileSync(
  join(appDir, 'package.json'),
  JSON.stringify({ name: 'tododesk-desktop', version, main: 'out/main/index.js' }, null, 2),
);
cpSync(join(root, 'out'), join(appDir, 'out'), { recursive: true });
// 上手课程随正式 App 携带，启动时经课程服务补入用户库，资产仍落数据库旁。
cpSync(join(monorepo, 'apps', 'onboarding'), join(appPath, 'Contents', 'Resources', 'onboarding'), { recursive: true });
// 能力包在签名前随正式 App 写入；构建来源统一，正式安装后可离开源码仓库导出。
const agentKit = join(monorepo, 'dist', 'agent-kit');
const { verifyAgentKit, verifySourceFreshness } = await import('../../../packages/agent-kit/scripts/package.mjs');
if (verifyAgentKit(agentKit).version !== version) throw new Error('能力包与 App 版本不一致');
verifySourceFreshness(agentKit, monorepo);
cpSync(agentKit, join(appPath, 'Contents', 'Resources', 'agent-kit'), { recursive: true });

// better-sqlite3 为 workspace 提升安装，需手动带入其运行时依赖链
for (const pkg of ['better-sqlite3', 'bindings', 'file-uri-to-path', 'prebuild-install']) {
  cpSync(
    join(monorepo, 'node_modules', pkg),
    join(appDir, 'node_modules', pkg),
    { recursive: true, filter: (src) => !src.includes(`${pkg}/deps/`) && !src.includes(`${pkg}/src/`) },
  );
}
console.log('[package] 已组装 app 目录（out + better-sqlite3 依赖链）');

// 5. ad-hoc 签名：先清扩展属性，再从内到外分层签（直接 --deep 会报 unsealed contents）
execFileSync('xattr', ['-cr', appPath]);
const frameworksDir = join(appPath, 'Contents', 'Frameworks');
for (const name of readdirSync(frameworksDir)) {
  if (name.endsWith('.framework') || name.endsWith('.app')) {
    execFileSync('codesign', ['--force', '--sign', '-', join(frameworksDir, name)], { stdio: 'inherit' });
  }
}
execFileSync('codesign', ['--force', '--sign', '-', appPath], { stdio: 'inherit' });
console.log(`[package] 完成：${appPath}`);
