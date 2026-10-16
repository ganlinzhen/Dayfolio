// Electron 主进程入口
import { app, BrowserWindow, protocol } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createCore } from '../../../../packages/core/src/index';
import { openDb } from './db';
import { registerIpc } from './ipc';
import { createTrayAndQuickCapture } from './tray';
import { registerToolFileProtocol, migrateLegacyToolsDir, TOOL_SCHEME } from './tools-store';
import { NEWS_SCHEME, registerNewsFileProtocol } from './news-store';

// 改名只影响展示：先保存原 userData 路径，继续使用已有设置、备份与旧工具资产。
const legacyUserData = app.getPath('userData');
app.setName('Dayfolio');
app.setPath('userData', legacyUserData);

// 测试/隔离支持：显式指定 userData 目录时立即改写（必须先于任何 userData 使用，
// 尤其是 migrateLegacyToolsDir——否则 TODODESK_DB 指向临时库时会把真实 userData/tools 搬走）
if (process.env.TODODESK_USER_DATA?.trim()) {
  app.setPath('userData', process.env.TODODESK_USER_DATA.trim());
}

// RSS-only：本地刷新不请求 X，装配不再读取任何 X 凭据（凭证文件保留但无人读取）
const core = createCore(openDb());

// 自定义协议需在 app ready 前声明特权（standard 才能带 host/path，secure 才能跑 JS）
protocol.registerSchemesAsPrivileged([
  { scheme: TOOL_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: NEWS_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let mainWindow: BrowserWindow | null = null;

/** 新闻原文内嵌阅读只接受干净的 HTTPS 地址，避免 file/data/javascript 等协议进入 guest 页面 */
const isSafeNewsSourceUrl = (value: string | undefined): value is string => {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 880,
    minHeight: 600,
    title: 'Dayfolio',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  // 新闻原文使用 <webview> 内嵌展示。这里在 attach 前收紧 guest 配置：
  // 无 preload/Node、保留 web security、使用独立非持久会话；弹窗统一关闭。
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (!isSafeNewsSourceUrl(params.src)) {
      event.preventDefault();
      return;
    }
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.webSecurity = true;
    webPreferences.sandbox = true;
    params.partition = 'news-source';
    delete params.allowpopups; // 未显式开启即保持禁用
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  const devUrl = process.env.ELECTRON_START_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

/** 打开（或聚焦）主窗口：关窗后可从菜单栏唤醒 */
function openMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

app.whenReady().then(() => {
  // 未打包环境（npm run dev / npm start）Dock 显示 DEV 角标图标，与正式安装版区分
  if (!app.isPackaged && process.platform === 'darwin' && app.dock) {
    const devIcon = join(__dirname, '../../build/icon-dev.png');
    if (existsSync(devIcon)) app.dock.setIcon(devIcon);
  }
  migrateLegacyToolsDir();
  registerIpc(core);
  registerToolFileProtocol();
  registerNewsFileProtocol();
  createWindow();
  createTrayAndQuickCapture(core, openMainWindow);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length === 0) openMainWindow();
  });
});

// 新闻原文 guest 页面不申请系统权限，也不打开新窗口；页面内跳转仍限定 HTTPS。
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  contents.on('will-navigate', (event, url) => {
    if (!isSafeNewsSourceUrl(url)) event.preventDefault();
  });
});

app.on('window-all-closed', () => {
  // macOS 惯例：关窗不退出（菜单栏常驻）；如需彻底退出用 Cmd+Q 或菜单栏退出项
  if (process.platform !== 'darwin') app.quit();
});
