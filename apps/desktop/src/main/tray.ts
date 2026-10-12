// 菜单栏常驻 + 菜单「快速捕获…」呼出速记窗
// - Tray title 实时显示「今日该做数量」（逾期加 ! 前缀）
// - 菜单：今日概览 / 快速捕获 / 每日打卡 / 打开主窗口 / 退出
// - 「快速捕获…」呼出速记小窗（回车入库，Esc/失焦关闭）
import { app, BrowserWindow, Menu, Tray, nativeImage, screen } from 'electron';
import { join } from 'node:path';
import type { TodoDeskCore } from '../../../../packages/core/src/index';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** 快速捕获窗内容（极简原生 DOM，走主进程 dataURL，不进 vite 构建） */
const QUICK_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  :root { color-scheme: light; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font: 14px/1.5 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
    background: #faf9f7; color: #1a1a1a; padding: 14px 16px 12px;
    -webkit-app-region: drag;
  }
  h1 {
    font-family: Georgia, "Songti SC", serif; font-size: 13px; font-weight: 600;
    color: #6b6b6b; margin-bottom: 10px; letter-spacing: 0.05em;
  }
  .row { display: flex; gap: 8px; -webkit-app-region: no-drag; }
  input {
    flex: 1; font-size: 14px; padding: 8px 10px; color: #1a1a1a;
    background: #fff; border: 1px solid #e2e0dc; border-radius: 6px; outline: none;
  }
  input:focus { border-color: #1a1a1a; }
  button {
    font-size: 13px; padding: 8px 14px; cursor: pointer; color: #faf9f7;
    background: #1a1a1a; border: none; border-radius: 6px;
  }
  .hint { margin-top: 8px; font-size: 11px; color: #9a968f; -webkit-app-region: no-drag; }
  .saved { color: #4a7a4a; }
</style>
</head>
<body>
  <h1>快速捕获</h1>
  <div class="row">
    <input id="q" type="text" placeholder="想到什么记什么，回车保存" autofocus />
    <button id="save">保存</button>
  </div>
  <div class="hint" id="hint">回车保存 · Esc 关闭 · 前缀 ! 设为高优先级</div>
<script>
  const input = document.getElementById('q');
  const hint = document.getElementById('hint');
  const hintDefault = hint.textContent;
  async function save() {
    const title = input.value.trim();
    if (!title) return;
    const priority = title.startsWith('!') ? 'high' : 'medium';
    const clean = title.replace(/^!+\\s*/, '');
    if (!clean) return;
    const res = await window.tododesk.todos.add({ title: clean, priority, source: 'app' });
    if (res && res.ok) {
      hint.textContent = '已添加：' + clean;
      hint.className = 'hint saved';
      input.value = '';
      setTimeout(() => { hint.textContent = hintDefault; hint.className = 'hint'; }, 1500);
    } else {
      hint.textContent = '保存失败：' + (res && res.error ? res.error : '未知错误');
      hint.className = 'hint';
    }
  }
  document.getElementById('save').addEventListener('click', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') window.close();
  });
</script>
</body>
</html>`;

export function createTrayAndQuickCapture(core: TodoDeskCore, openMainWindow: () => void): void {
  let tray: Tray | null = null;
  let quickWin: BrowserWindow | null = null;
  let timer: NodeJS.Timeout | null = null;

  // ---------- Tray ----------

  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('TodoDesk');

  const buildMenu = () => {
    const today = core.today.getToday();
    const overdue = today.overdue_todos.length;
    const dueToday = today.due_today_todos.length;
    // title：逾期 !N / 今日 N / 无事 ·（保持可见，空 title 会让图标从菜单栏消失）
    tray!.setTitle(overdue > 0 ? `!${overdue}` : dueToday > 0 ? `${dueToday}` : '·');
    tray!.setContextMenu(
      Menu.buildFromTemplate([
        { label: `逾期 ${overdue} · 今日 ${dueToday} · 连续打卡 ${today.streak} 天`, enabled: false },
        { type: 'separator' },
        ...(overdue > 0
          ? [{ label: `逾期待办（先处理）`, click: openMainWindow }]
          : []),
        {
          label: '快速捕获…',
          click: () => toggleQuickWindow(),
        },
        { label: '每日打卡', click: () => { core.checkins.checkin({ ref_type: 'day' }); refresh(); } },
        { type: 'separator' },
        { label: '打开主窗口', click: openMainWindow },
        { label: '退出 TodoDesk', role: 'quit' },
      ]),
    );
  };

  const refresh = () => {
    try {
      buildMenu();
    } catch {
      // 数据库瞬时占用等异常不打扰菜单栏，下次刷新再试
    }
  };

  // ---------- 快速捕获窗 ----------

  const createQuickWindow = () => {
    const workArea = screen.getPrimaryDisplay().workArea;
    const width = 440;
    const height = 150;
    quickWin = new BrowserWindow({
      width,
      height,
      x: Math.round(workArea.x + workArea.width - width - 24),
      y: Math.round(workArea.y + 8),
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      frame: false,
      alwaysOnTop: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    quickWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    quickWin.on('blur', () => quickWin?.hide());
    quickWin.on('hide', () => {
      // 清空输入状态，下次呼出是干净的一次
      quickWin?.webContents.reloadIgnoringCache();
    });
    void quickWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(QUICK_HTML));
    quickWin.once('ready-to-show', () => {
      quickWin?.show();
      quickWin?.focus();
    });
  };

  const toggleQuickWindow = () => {
    if (quickWin && quickWin.isVisible()) {
      quickWin.hide();
      return;
    }
    if (!quickWin || quickWin.isDestroyed()) {
      createQuickWindow();
    } else {
      quickWin.show();
      quickWin.focus();
    }
  };

  // ---------- 生命周期 ----------

  refresh();
  timer = setInterval(refresh, REFRESH_INTERVAL_MS);

  app.on('before-quit', () => {
    if (timer) clearInterval(timer);
    tray?.destroy();
  });
}
