// 新闻工作台只接受受信宿主主页面。有效阅读使用主进程前台时钟，不信任页面自报秒数。
import { randomUUID } from 'node:crypto';
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { runtimeErrorInfo, type TodoDeskCore } from '../../../../packages/core/src';
import { HOST_ORIGIN } from './runtime-protocol';
import type { createNewsAgentRunner } from './news-agent-runner';

interface ReadingSession { newsId: number; token: string; lastSeen: number; visibleMs: number; wasVisible: boolean; epoch: number; }

export function registerNewsFeedIpc(core: TodoDeskCore, runner: ReturnType<typeof createNewsAgentRunner>) {
  const sessions = new Map<number, ReadingSession>();
  const registered = new Set<number>();
  const trusted = (event: IpcMainInvokeEvent) => {
    if (event.senderFrame !== event.sender.mainFrame) throw new Error('新闻操作仅允许来自主页面');
    const actual = new URL(event.senderFrame.url);
    const expected = new URL(process.env.ELECTRON_START_URL || HOST_ORIGIN);
    if (actual.protocol !== expected.protocol || actual.host !== expected.host) throw new Error('新闻页面身份已失效');
  };
  const visible = (event: IpcMainInvokeEvent) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return !!window && !window.isDestroyed() && window.isVisible() && window.isFocused() && !window.isMinimized();
  };
  const handle = (name: string, fn: (input: any, event: IpcMainInvokeEvent) => unknown) => {
    ipcMain.handle(`news:${name}`, async (event, input) => {
      try {
        trusted(event);
        return { ok: true, data: await fn(input, event) };
      } catch (error) {
        const info = runtimeErrorInfo(error);
        return { ok: false, error: info.message, code: info.code, retryable: info.retryable };
      }
    });
  };
  handle('feedConfig', () => core.newsFeed.getConfig());
  handle('feedUpdateConfig', input => {
    const before = core.newsFeed.getConfig();
    const next = core.newsFeed.updateConfig(input);
    if (before.learning.enabled !== next.learning.enabled) sessions.clear();
    return next;
  });
  handle('feedPreview', input => core.newsFeed.preview(input ?? {}));
  handle('feedStartUpdate', () => runner.startFeedUpdate());
  handle('feedAdvance', input => { const batch = core.newsFeed.advance(input?.batch_id); runner.tick(); return batch; });
  handle('feedContinueUpdate', input => { const batch = core.newsFeed.continueUpdate(input); runner.tick(); return batch; });
  handle('feedStopUpdate', input => core.newsFeed.stopUpdate(input.batch_id));
  handle('feedBatches', input => core.newsFeed.listBatches(input ?? {}));
  handle('feedList', input => core.newsFeed.list(input ?? {}));
  handle('feedDailyEditions', input => core.newsFeed.listDailyEditions(input ?? {}));
  handle('feedDailyEdition', input => core.newsFeed.getDailyEdition(input));
  handle('feedInterests', () => core.newsFeed.getInterests());
  handle('feedManageTopic', input => core.newsFeed.manageTopic(input));
  handle('feedManageSource', input => core.newsFeed.manageSource(input));
  handle('feedResetLearning', () => { sessions.clear(); return core.newsFeed.resetLearning(); });
  handle('feedImportStarred', input => core.newsFeed.importStarred(input ?? {}));
  handle('feedUpdateEvent', input => core.newsFeed.updateEvent(input));
  handle('feedSubmitCorrection', input => core.newsFeed.submitCorrection(input));
  handle('feedDismissCorrection', input => core.newsFeed.dismissCorrection(input.id));
  handle('feedDismissEventReminder', input => core.newsFeed.dismissEventReminder(input.id));
  handle('feedScheduleStatus', () => runner.scheduleStatus());
  handle('feedReadingState', (input, event) => {
    const id = Number(input?.id);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('阅读新闻身份无效');
    const now = Date.now(), isVisible = visible(event), epoch = core.newsFeed.getInterests().epoch;
    let session = sessions.get(event.sender.id);
    if (!session || session.newsId !== id || session.epoch !== epoch) {
      session = { newsId: id, token: randomUUID(), lastSeen: now, visibleMs: 0, wasVisible: isVisible, epoch };
      sessions.set(event.sender.id, session);
    }
    if (!registered.has(event.sender.id)) {
      registered.add(event.sender.id);
      const window = BrowserWindow.fromWebContents(event.sender);
      const pause = () => { const state = sessions.get(event.sender.id); if (state) { state.wasVisible = false; state.lastSeen = Date.now(); } };
      window?.on('blur', pause);
      window?.on('hide', pause);
      window?.on('minimize', pause);
      event.sender.once('destroyed', () => {
        sessions.delete(event.sender.id); registered.delete(event.sender.id);
        window?.removeListener('blur', pause); window?.removeListener('hide', pause); window?.removeListener('minimize', pause);
      });
    }
    const gap = now - session.lastSeen;
    // 页面每五秒提交一次有效阅读心跳。失焦或较长间隔不计入前台时长。
    if (isVisible && session.wasVisible && gap >= 0 && gap <= 7000) session.visibleMs += gap;
    session.lastSeen = now;
    session.wasVisible = isVisible;
    return { visible: isVisible, token: session.token };
  });
  handle('feedFeedback', (input, event) => {
    const { reading_token, ...feedback } = input ?? {};
    if (feedback.kind === 'read') {
      const session = sessions.get(event.sender.id);
      if (!visible(event) || !session || session.newsId !== feedback.news_id || session.token !== reading_token || session.epoch !== core.newsFeed.getInterests().epoch || !core.newsFeed.getConfig().learning.enabled || session.visibleMs < 20_000 || Date.now() - session.lastSeen > 7000) {
        throw new Error('尚未形成有效的前台阅读记录');
      }
      feedback.reading_seconds = Math.floor(Math.min(session.visibleMs, 300_000) / 1000);
    }
    return core.newsFeed.recordFeedback({ ...feedback, source: 'app' });
  });
}
