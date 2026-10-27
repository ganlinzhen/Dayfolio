import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkCore, type TestCtx } from '../../../packages/core/test/helpers';

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input?: unknown) => Promise<{ ok: boolean; data?: any; error?: string }>>(),
  window: null as any, focused: true,
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (event: unknown, input: unknown) => Promise<any>) => state.handlers.set(name, fn) },
  BrowserWindow: { fromWebContents: () => state.window }, protocol: {},
}));
import { registerNewsFeedIpc } from '../src/main/news-feed-ipc';
import { createNewsAgentRunner } from '../src/main/news-agent-runner';

describe('新闻前台阅读与受信宿主 IPC', () => {
  let ctx: TestCtx;
  let event: { sender: EventEmitter & { id: number; mainFrame: { url: string } }; senderFrame: { url: string } };
  let newsId: number;
  const request = (name: string, input?: unknown, from?: unknown) => state.handlers.get(`news:${name}`)!(from ?? event, input);
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-27T03:00:00Z')); ctx = mkCore(); state.focused = true;
    state.window = Object.assign(new EventEmitter(), { isDestroyed: () => false, isVisible: () => true, isFocused: () => state.focused, isMinimized: () => false });
    const frame = { url: 'dayfolio-app://app/index.html' };
    event = { sender: Object.assign(new EventEmitter(), { id: 41, mainFrame: frame }), senderFrame: frame };
    const config = ctx.core.newsFeed.getConfig();
    ctx.core.newsFeed.updateConfig({ config: { ...config, learning: { ...config.learning, enabled: true } }, expected_revision: config.revision });
    const task = ctx.core.news.createTask({ title: '前台阅读测试' }), claim = ctx.core.news.claimTask(task.id, 'test');
    newsId = ctx.core.news.submitItems(task.id, claim.claim_token, [{ title: '需要实际阅读的新闻', summary: '用于核对前台心跳与不可伪造用时。', source_url: 'https://example.com/reading', published_at: new Date().toISOString(), topic_keys: ['阅读工具'] }]).items[0].id;
    ctx.core.news.completeTask(task.id, claim.claim_token);
    registerNewsFeedIpc(ctx.core, createNewsAgentRunner({ core: ctx.core, dbPath: ctx.dbPath, nodeBinary: process.execPath, mcpServer: '/unused.cjs', scheduling: false }));
  });
  afterEach(() => { ctx.cleanup(); state.handlers.clear(); vi.useRealTimers(); });

  it('拒绝子页面和外部来源，即使使用相同路由也不能读取或写入新闻设置', async () => {
    expect((await request('feedConfig', undefined, { ...event, senderFrame: { url: event.senderFrame.url } })).ok).toBe(false);
    event.senderFrame.url = 'https://example.com/';
    expect((await request('feedConfig')).ok).toBe(false);
  });

  it('页面自报超长阅读时长无效，连续前台心跳满二十秒才记录一次', async () => {
    const first = await request('feedReadingState', { id: newsId });
    const payload = { news_id: newsId, kind: 'read', source: 'app', idempotency_key: 'read-once', reading_seconds: 9999, reading_token: first.data.token };
    expect((await request('feedFeedback', payload)).ok).toBe(false);
    for (let i = 0; i < 4; i++) { vi.advanceTimersByTime(5000); await request('feedReadingState', { id: newsId }); }
    expect((await request('feedFeedback', payload)).data.recorded).toBe(true);
    expect((await request('feedFeedback', payload)).data.recorded).toBe(false);
    expect(ctx.core.db.prepare("SELECT COUNT(*) AS n FROM news_feed_feedback WHERE kind='read'").get()?.n).toBe(1);
  });

  it('切出窗口的时间不累计，学习开关或清空使旧阅读令牌失效', async () => {
    const first = await request('feedReadingState', { id: newsId });
    for (let i = 0; i < 2; i++) { vi.advanceTimersByTime(5000); await request('feedReadingState', { id: newsId }); }
    state.focused = false; state.window.emit('blur'); vi.advanceTimersByTime(5000);
    state.focused = true;
    await request('feedReadingState', { id: newsId });
    const payload = { news_id: newsId, kind: 'read', source: 'app', idempotency_key: 'focus-read', reading_token: first.data.token };
    expect((await request('feedFeedback', payload)).ok).toBe(false);
    for (let i = 0; i < 2; i++) { vi.advanceTimersByTime(5000); await request('feedReadingState', { id: newsId }); }
    expect((await request('feedFeedback', payload)).ok).toBe(true);
    const config = ctx.core.newsFeed.getConfig();
    expect((await request('feedUpdateConfig', { config: { ...config, learning: { ...config.learning, enabled: false } }, expected_revision: config.revision })).ok).toBe(true);
    expect((await request('feedFeedback', { ...payload, idempotency_key: 'stale-after-disable' })).ok).toBe(false);
    await request('feedReadingState', { id: newsId });
    await request('feedResetLearning');
    expect((await request('feedFeedback', { ...payload, idempotency_key: 'stale-after-reset' })).ok).toBe(false);
  });
});
