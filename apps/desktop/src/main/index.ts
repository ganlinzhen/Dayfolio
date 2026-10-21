// Electron 主进程入口
import { app, BrowserWindow, protocol } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createCore } from '../../../../packages/core/src/index';
import { openDb } from './db';
import { defaultDbPath } from '../../../../packages/core/src';
import { createNewsAgentRunner } from './news-agent-runner';
import { registerIpc } from './ipc';
import { createTrayAndQuickCapture } from './tray';
import { registerToolFileProtocol, migrateLegacyToolsDir, TOOL_SCHEME } from './tools-store';
import { NEWS_SCHEME, registerNewsFileProtocol } from './news-store';
import { HOST_ORIGIN, HOST_SCHEME, RUNTIME_SCHEME, registerRuntimeProtocols } from './runtime-protocol';
import { registerRuntimeSessions } from './runtime-session';
import { migrateCalendarView } from './storage-preferences';
import { ensureOnboardingCourse } from './onboarding-course';

// 改名只影响展示：先保存原 userData 路径，继续使用已有设置、备份与旧工具资产。
const legacyUserData = app.getPath('userData');
app.setName('Dayfolio');
app.setPath('userData', legacyUserData);

// 测试/隔离支持：显式指定 userData 目录时立即改写（必须先于任何 userData 使用，
// 尤其是 migrateLegacyToolsDir——否则 TODODESK_DB 指向临时库时会把真实 userData/tools 搬走）
if (process.env.TODODESK_USER_DATA?.trim()) {
  app.setPath('userData', process.env.TODODESK_USER_DATA.trim());
  // Chromium 缓存与 localStorage 同样落在隔离目录，不能沿用默认会话路径。
  app.setPath('sessionData', process.env.TODODESK_USER_DATA.trim());
}

// App 与后台新闻 MCP 共用同一数据库；联网采集由设置中选择的 Agent 执行。
const core = createCore(openDb());
const newsAgent = createNewsAgentRunner({ core, dbPath: defaultDbPath(), nodeBinary: process.execPath,
  mcpServer: app.isPackaged ? join(process.resourcesPath, 'agent-kit/mcp/mcp-server.cjs') : join(__dirname, '../../../mcp/dist/mcp-server.cjs'),
});

// 自定义协议需在 app ready 前声明特权（standard 才能带 host/path，secure 才能跑 JS）
protocol.registerSchemesAsPrivileged([
  { scheme: HOST_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: RUNTIME_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
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
  mainWindow.on('focus',()=>{try{core.providerWorker.scheduleDue();void core.providerWorker.tick().catch(()=>{});}catch{/* 数据库瞬时忙由下一轮检查恢复。 */}});
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const parsed = new URL(url);
    const allowed = process.env.ELECTRON_START_URL ? new URL(process.env.ELECTRON_START_URL).origin : HOST_ORIGIN;
    if (parsed.protocol + '//' + parsed.host !== allowed) event.preventDefault();
  });
  const devUrl = process.env.ELECTRON_START_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadURL(HOST_ORIGIN + '/index.html');
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

app.whenReady().then(async () => {
  // 未打包环境（npm run dev / npm start）Dock 显示 DEV 角标图标，与正式安装版区分
  if (!app.isPackaged && process.platform === 'darwin' && app.dock) {
    const devIcon = join(__dirname, '../../build/icon-dev.png');
    if (existsSync(devIcon)) app.dock.setIcon(devIcon);
  }
  migrateLegacyToolsDir();
  ensureOnboardingCourse(core, app.isPackaged
    ? join(process.resourcesPath, 'onboarding')
    : join(app.getAppPath(), '../onboarding'));
  registerIpc(core, newsAgent);
  registerToolFileProtocol();
  registerNewsFileProtocol();
  const hostOrigin = process.env.ELECTRON_START_URL ? new URL(process.env.ELECTRON_START_URL).origin : HOST_ORIGIN;
  registerRuntimeProtocols(core, join(__dirname, '../renderer'), hostOrigin);
  registerRuntimeSessions(core, { hostOrigin });
  if (!process.env.ELECTRON_START_URL) {
    try { await migrateCalendarView(join(__dirname, '../renderer'), hostOrigin); }
    catch { console.error('日历视图偏好迁移未完成，保留现有偏好并在下次启动重试。'); }
  }
  core.providerWorker.start();
  newsAgent.start();
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

// 退出前停止当前执行者，不让已停止的网络响应在关闭连接后提交。
let stoppingProviders=false,providersStopped=false;
app.on('before-quit',event=>{
  if(providersStopped)return;
  event.preventDefault();if(stoppingProviders)return;stoppingProviders=true;
  // 原生 macOS 退出请求结束本轮回调后再重入，避免只关窗却保留进程。
  void Promise.all([core.providerWorker.stop(), newsAgent.stop()]).catch(()=>{}).finally(()=>{providersStopped=true;setImmediate(()=>app.quit());});
});
