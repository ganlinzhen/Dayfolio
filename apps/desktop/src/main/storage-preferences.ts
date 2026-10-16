// 首次切换来源只迁移周/月偏好；不运行旧页面，不复制其他 localStorage 数据。
import { BrowserWindow } from 'electron';
import { join } from 'node:path';
export const STORAGE_BRIDGE_PATH = '/__dayfolio_storage__/bridge';
export const STORAGE_BRIDGE_HTML = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><title>日历偏好迁移</title>';
const KEY = 'dayfolio.calView', MARKER = 'dayfolio.calendarOriginMigrated';
const valid = (value: unknown): value is 'week' | 'month' => value === 'week' || value === 'month';
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('日历偏好迁移超时')), 3000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
export async function migrateCalendarView(rendererRoot: string, hostOrigin: string): Promise<'existing' | 'migrated' | 'default'> {
  const bridge = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  bridge.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  bridge.webContents.on('will-navigate', event => event.preventDefault());
  const inspect = (): Promise<{view: unknown;migrated: unknown}> => bounded(bridge.webContents.executeJavaScript(`({ view: localStorage.getItem(${JSON.stringify(KEY)}), migrated: localStorage.getItem(${JSON.stringify(MARKER)}) })`));
  try {
    await bounded(bridge.loadURL(hostOrigin + STORAGE_BRIDGE_PATH));
    const current = await inspect();
    if (valid(current.view) || current.migrated === '1') {
      if (current.migrated !== '1') await bounded(bridge.webContents.executeJavaScript(`localStorage.setItem(${JSON.stringify(MARKER)}, '1'); true`));
      return 'existing';
    }
    // Electron 当前 file 来源共用存储；只加载随包的空白桥接文件，旧业务脚本始终不执行。
    await bounded(bridge.loadFile(join(rendererRoot, 'storage-bridge.html')));
    const previous = await inspect();
    const view = valid(previous.view) ? previous.view : null;
    await bounded(bridge.loadURL(hostOrigin + STORAGE_BRIDGE_PATH));
    await bounded(bridge.webContents.executeJavaScript(`(() => {
      const current = localStorage.getItem(${JSON.stringify(KEY)});
      if (current !== 'week' && current !== 'month' && ${JSON.stringify(view)} !== null) localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(view)});
      localStorage.setItem(${JSON.stringify(MARKER)}, '1');
      return true;
    })()`));
    return view ? 'migrated' : 'default';
  } finally { if (!bridge.isDestroyed()) bridge.destroy(); }
}
