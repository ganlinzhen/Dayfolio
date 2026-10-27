import { describe, expect, it, vi } from 'vitest';
import { mkCore, mkLegacyDb } from './helpers';
import { createCore } from '../src';
import type { NewsFeedConfig, NewsSubmissionItem } from '../src';

const item = (i: number, over: Partial<NewsSubmissionItem> = {}): NewsSubmissionItem => ({ title: `第${i}条独立事实`, summary: '主体发布结果，已核实关键数据。', source_url: `https://example.com/news/${i}`, source_name: '官方来源', published_at: new Date(Date.now() - 3600_000).toISOString(), topic_keys: ['开源模型'], ...over });
function only(c: NewsFeedConfig, ids: string[]) { c.modules = c.modules.filter(m => ids.includes(m.id)); return c; }

describe('模块新闻共用服务', () => {
  it('默认早中晚配置、草稿预览、修订冲突与旧长提示词互不覆盖', () => {
    const { core, cleanup } = mkCore(); try {
      const c = core.newsFeed.getConfig(); expect(c.schedule.times).toEqual(['08:00', '12:00', '17:00']); expect(c.learning.enabled).toBe(false);
      core.news.updateCollectionSettings({ prompt: '历史偏好保留', max_items: 11, window_hours: 24, expected_revision: 0 });
      const draft = structuredClone(c); draft.modules[0].scope = '新能源汽车和国内公共重点';
      expect(core.newsFeed.preview({ config: draft }).modules[0].instructions).toContain('新能源汽车');
      expect(core.newsFeed.getConfig().revision).toBe(0);
      const saved = core.newsFeed.updateConfig({ config: draft, expected_revision: 0 }); expect(saved.revision).toBe(1);
      expect(() => core.newsFeed.updateConfig({ config: draft, expected_revision: 0 })).toThrow('其他窗口');
      expect(core.news.getCollectionSettings().prompt).toBe('历史偏好保留');
      expect(core.newsFeed.preview().modules[0].instructions).toContain('不因个人点击兴趣缩小');
    } finally { cleanup(); }
  });
  it('先覆盖各模块再补足，接续、删除、重复点击都不返还模块预算', () => {
    const { core, cleanup } = mkCore(); try {
      const c = only(core.newsFeed.getConfig(), ['domestic', 'ai']); c.modules.forEach(m => { m.headline_count = 2; m.max_items = 3; });
      core.newsFeed.updateConfig({ config: c, expected_revision: 0 });
      let b = core.newsFeed.startUpdate(); expect(core.newsFeed.startUpdate().id).toBe(b.id);
      const first = b.next_task_id!, claim = core.news.claimTask(first);
      const submitted = core.news.submitItems(first, claim.claim_token, [item(1), item(2)]);
      expect(submitted.items[0].module_id).toBe('domestic'); expect(core.newsFeed.getTaskContext(first)?.remaining).toBe(0);
      core.news.completeTask(first, claim.claim_token, '重点已完成');
      b = core.newsFeed.advance(b.id)!; expect(b.modules.find(m => m.task_id === b.next_task_id)?.module_id).toBe('ai');
      const second = core.news.claimTask(b.next_task_id!); core.news.completeTask(second.task.id, second.claim_token, '本轮没有新增');
      b = core.newsFeed.advance(b.id)!; const third = core.news.claimTask(b.next_task_id!); expect(third.task.max_items).toBe(1);
      core.news.deleteItem(submitted.items[0].id);
      expect(core.newsFeed.getTaskContext(third.task.id)?.remaining).toBe(1);
      expect(() => core.news.submitItems(third.task.id, third.claim_token, [item(3), item(4)])).toThrow('额度');
      core.newsFeed.stopUpdate(b.id); const continued = core.newsFeed.continueUpdate({ batch_id: b.id });
      const t = core.news.getTask(continued.next_task_id!); expect(t.max_items).toBe(1);
      expect(core.newsFeed.getTaskContext(t.id)?.accepted_ids).toHaveLength(2);
      expect(() => core.news.submitItems(third.task.id, third.claim_token, [item(3)])).toThrow();
    } finally { cleanup(); }
  });
  it('图片与字段验证保持整批原子，独立新闻扩展可读且旧任务不可伪造模块', () => {
    const { core, cleanup } = mkCore(); try {
      const b = core.newsFeed.startUpdate(), claim = core.news.claimTask(b.next_task_id!);
      expect(() => core.news.submitItems(claim.task.id, claim.claim_token, [item(1), item(2, { image_url: 'https://127.0.0.1/a.jpg', image_source_url: 'https://example.com/a', image_caption: '来源图' })])).toThrow('内网');
      expect(core.news.list()).toHaveLength(0);
      expect(() => core.news.submitItems(claim.task.id, claim.claim_token, [item(2, { image_url: 'http://example.com/a.jpg', image_source_url: 'https://example.com/a', image_caption: '来源图' })])).toThrow('HTTPS');
      const n = core.news.submitItems(claim.task.id, claim.claim_token, [item(3, { image_url: 'https://example.com/a.jpg', image_source_url: 'https://example.com/a', image_caption: '来源图', background: '背景', impact: '影响', uncertainty: '尚待确认' })]).items[0];
      expect(n.background).toBe('背景'); expect(n.image_caption).toBe('来源图'); expect(n.topic_keys).toEqual(['开源模型']);
      expect(core.newsFeed.list({ module_id: 'domestic' })[0].id).toBe(n.id);
      const old = core.news.claimTask(core.news.createTask({ title: '兼容旧任务' }).id);
      expect(core.newsFeed.getTaskContext(old.task.id)).toBeNull();
      expect(() => core.news.submitItems(old.task.id, old.claim_token, [item(4, { module_id: 'ai' })])).toThrow('旧任务');
    } finally { cleanup(); }
  });
  it('时事撤回后旧令牌失效，恢复只授权新执行，到期暂停', () => {
    const { core, cleanup } = mkCore(); try {
      core.newsFeed.updateConfig({ config: only(core.newsFeed.getConfig(), ['events']), expected_revision: 0 });
      const b = core.newsFeed.startUpdate(), claim = core.news.claimTask(b.next_task_id!);
      const e = core.newsFeed.getInterests().events[0];
      const paused = core.newsFeed.updateEvent({ id: e.id, status: 'paused', expected_revision: e.revision });
      core.newsFeed.updateEvent({ id: e.id, status: 'active', expected_revision: paused.revision });
      expect(() => core.news.submitItems(claim.task.id, claim.claim_token, [item(1, { event_id: e.id })])).toThrow();
      const next = core.newsFeed.advance(b.id)!; expect(next.next_task_id).not.toBe(claim.task.id);
      const current = core.newsFeed.getInterests().events.find(v => v.id === e.id)!;
      core.newsFeed.updateEvent({ id: e.id, expires_at: new Date(Date.now() - 1000).toISOString(), expected_revision: current.revision });
      expect(core.newsFeed.getInterests().events.find(v => v.id === e.id)?.status).toBe('paused');
      core.newsFeed.resetLearning(); expect(core.newsFeed.getInterests().events.find(v => v.id === e.id)?.status).toBe('paused');
    } finally { cleanup(); }
  });
  it('反馈只在启用后学习，同条信号封顶，明确关注影响下一轮，清空擦除在途画像', () => {
    const { core, cleanup } = mkCore(); try {
      const t = core.news.claimTask(core.news.createTask({ title: '旧收藏兼容' }).id);
      const n = core.news.submitItems(t.task.id, t.claim_token, [item(1)]).items[0]; core.news.markStarred(n.id, true);
      expect(core.newsFeed.recordFeedback({ news_id: n.id, kind: 'star', source: 'app', idempotency_key: 'before' }).recorded).toBe(true);
      expect(core.db.prepare('SELECT COUNT(*) AS n FROM news_feed_feedback').get()?.n).toBe(0);
      const c = core.newsFeed.getConfig(); c.learning.enabled = true; core.newsFeed.updateConfig({ config: c, expected_revision: 0 });
      expect(core.newsFeed.getInterests().topics).toHaveLength(0);
      expect(() => core.newsFeed.recordFeedback({ news_id: n.id, kind: 'read', source: 'explicit', reading_seconds: 30, idempotency_key: 'fake' })).toThrow('助手');
      expect(() => core.newsFeed.recordFeedback({ news_id: n.id, kind: 'read', source: 'app', reading_seconds: 3, idempotency_key: 'fast' })).toThrow('20');
      expect(core.newsFeed.recordFeedback({ news_id: n.id, kind: 'star', source: 'app', idempotency_key: 'one' }).recorded).toBe(true);
      expect(core.newsFeed.recordFeedback({ news_id: n.id, kind: 'star', source: 'app', idempotency_key: 'two' }).recorded).toBe(false);
      core.newsFeed.manageTopic({ key: 'AI 编程', name: 'AI 编程', action: 'follow' });
      let b = core.newsFeed.startUpdate();
      while (core.newsFeed.getTaskContext(b.next_task_id!)?.module_id !== 'for_you') { const x = core.news.claimTask(b.next_task_id!); core.news.completeTask(x.task.id, x.claim_token, '无新增'); b = core.newsFeed.advance(b.id)!; }
      expect(core.newsFeed.getTaskContext(b.next_task_id!)?.instructions).toContain('AI 编程');
      expect(core.newsFeed.getTaskContext(b.next_task_id!)?.instructions).toContain('探索');
      const before = core.newsFeed.getInterests().epoch; const reset = core.newsFeed.resetLearning(); expect(reset.epoch).toBe(before + 1); expect(reset.topics.some(t => t.state === 'followed')).toBe(true);
      expect(() => core.newsFeed.getTaskContext(b.next_task_id!)).toThrow('失效');
      expect(core.news.getTask(b.next_task_id!).instructions).not.toContain('明确关注');
      expect(core.news.list({ filter: 'starred' })).toHaveLength(1);
      expect(core.newsFeed.importStarred({ news_ids: [n.id] }).imported).toBe(1);
    } finally { cleanup(); }
  });
  it('真实旧库升级清理历史，新的更正保留正文与已读，隐藏可撤销', () => {
    const legacy = mkLegacyDb(29); try {
      legacy.db.prepare("INSERT INTO news(source,title,url,summary,published_date,fetched_at,dedup_key,is_read,is_starred) VALUES('agent','旧新闻','https://example.com/old','旧摘要','2026-10-26','2026-10-26','old',1,1)").run();
      const core = createCore(legacy.db, { dbPath: legacy.dbPath }); expect(core.newsFeed.getInterests().topics).toHaveLength(0);
      expect(core.news.list()).toHaveLength(0);
      const task = core.news.claimTask(core.news.createTask({ title: '升级后新闻仍可正常写入' }).id);
      const n = core.news.submitItems(task.task.id, task.claim_token, [item(100)]).items[0]; core.news.markRead(n.id, true);
      const correction = core.newsFeed.submitCorrection({ news_id: n.id, summary: '原数字需要更正', evidence_url: 'https://example.com/correction' });
      expect(core.newsFeed.list({ history: true })[0].corrections[0].id).toBe(correction.id);
      expect(core.news.list()[0].summary).toBe(n.summary); expect(core.news.list()[0].is_read).toBe(true);
      core.newsFeed.dismissCorrection(correction.id); expect(core.newsFeed.list({ history: true })[0].corrections[0].acknowledged).toBe(true);
      core.newsFeed.recordFeedback({ news_id: n.id, kind: 'hide', source: 'app', idempotency_key: 'hide' }); expect(core.newsFeed.list({ history: true })).toHaveLength(0);
      core.newsFeed.recordFeedback({ news_id: n.id, kind: 'undo_hide', source: 'app', idempotency_key: 'show' }); expect(core.newsFeed.list({ history: true })).toHaveLength(1);
    } finally { legacy.cleanup(); }
  });
  it('时间预算终结后不会新建模块任务，显式继续保留计数', () => {
    const { core, cleanup } = mkCore(); try {
      const b = core.newsFeed.startUpdate();
      vi.useFakeTimers(); vi.setSystemTime(Date.now() + 21 * 60_000);
      expect(() => core.newsFeed.getTaskContext(b.next_task_id!)).toThrow('预算');
      expect(core.newsFeed.advance(b.id)?.status).toBe('budget_exhausted');
      expect(core.newsFeed.continueUpdate({ batch_id: b.id }).id).toBe(b.id);
    } finally { vi.useRealTimers(); cleanup(); }
  });
  it('新一轮先核实增量，再复用有效旧新闻；唯一主模块关联与累计数量不重复', () => {
    const { core, cleanup } = mkCore(); try {
      const c = only(core.newsFeed.getConfig(), ['ai']); c.modules[0].headline_count = 1; c.modules[0].max_items = 2;
      core.newsFeed.updateConfig({ config: c, expected_revision: 0 });
      let b = core.newsFeed.startUpdate(); let claim = core.news.claimTask(b.next_task_id!);
      const old = core.news.submitItems(claim.task.id, claim.claim_token, [item(1)]).items[0]; core.news.completeTask(claim.task.id, claim.claim_token);
      b = core.newsFeed.advance(b.id)!; claim = core.news.claimTask(b.next_task_id!); core.news.completeTask(claim.task.id, claim.claim_token, '无其他新消息');
      expect(core.newsFeed.advance(b.id)?.status).toBe('completed');
      b = core.newsFeed.startUpdate(); claim = core.news.claimTask(b.next_task_id!);
      expect(core.newsFeed.getTaskContext(claim.task.id)?.accepted_ids).toEqual([]);
      const fresh = core.news.submitItems(claim.task.id, claim.claim_token, [item(2)]).items[0]; core.news.completeTask(claim.task.id, claim.claim_token);
      b = core.newsFeed.advance(b.id)!; claim = core.news.claimTask(b.next_task_id!); core.news.completeTask(claim.task.id, claim.claim_token, '增量核实完毕');
      b = core.newsFeed.advance(b.id)!; expect(b.status).toBe('completed'); expect(b.modules[0].accepted_count).toBe(2);
      const members = core.db.prepare('SELECT news_id FROM news_feed_members WHERE batch_id=? ORDER BY news_id').all(b.id).map(r => Number(r.news_id));
      expect(members).toEqual([old.id, fresh.id]); expect(core.news.list()).toHaveLength(2);
    } finally { cleanup(); }
  });
  it('后台首模块失败释放后推进其他模块，阶段重试不会无限返额', () => {
    const { core, cleanup } = mkCore(); try {
      const c = only(core.newsFeed.getConfig(), ['domestic', 'ai']); core.newsFeed.updateConfig({ config: c, expected_revision: 0 });
      const b = core.newsFeed.startUpdate(), run = core.newsRuns.enqueue(b.next_task_id!);
      expect(core.newsRuns.claimNext('test-owner', process.pid)?.run.id).toBe(run.id);
      core.newsRuns.finish(run.id, 'test-owner', 'failed', '联网失败');
      const next = core.newsFeed.advance(b.id)!; expect(next.next_task_id).not.toBe(b.next_task_id);
      expect(core.newsFeed.getTaskContext(next.next_task_id!)?.module_id).toBe('ai');
      expect(() => core.newsFeed.getTaskContext(b.next_task_id!)).toThrow('撤回');
    } finally { cleanup(); }
  });
  it('跨日跨新闻证据形成推断，取消收藏撤回、降频来源恢复、关闭和清空后旧推荐失效', () => {
    const { core, cleanup } = mkCore(); try {
      const c = core.newsFeed.getConfig(); c.learning.enabled = true; core.newsFeed.updateConfig({ config: c, expected_revision: 0 });
      const t = core.news.claimTask(core.news.createTask({ title: '兴趣测试' }).id), ns = core.news.submitItems(t.task.id, t.claim_token, [item(1), item(2)]).items;
      core.newsFeed.recordFeedback({ news_id: ns[0].id, kind: 'star', source: 'app', idempotency_key: 'first' }); expect(core.newsFeed.getInterests().topics).toHaveLength(0);
      vi.useFakeTimers(); vi.setSystemTime(Date.now() + 24 * 3600_000);
      core.newsFeed.recordFeedback({ news_id: ns[1].id, kind: 'star', source: 'app', idempotency_key: 'second' });
      expect(core.newsFeed.getInterests().topics[0]).toMatchObject({ key: '开源模型', state: 'inferred', evidence_count: 2 });
      core.newsFeed.recordFeedback({ news_id: ns[1].id, kind: 'unstar', source: 'app', idempotency_key: 'unstar' }); expect(core.newsFeed.getInterests().topics).toHaveLength(0);
      core.newsFeed.manageSource({ source_name: '官方来源', action: 'reduce' }); expect(core.newsFeed.getInterests().reduced_sources).toContain('官方来源');
      core.newsFeed.manageSource({ source_name: '官方来源', action: 'restore' }); expect(core.newsFeed.getInterests().reduced_sources).toEqual([]);
      const off = core.newsFeed.getConfig(); off.learning.enabled = false; core.newsFeed.updateConfig({ config: off, expected_revision: off.revision });
      expect(core.newsFeed.getInterests().topics).toHaveLength(0); expect(core.newsFeed.getInterests().exploration).toBeNull();
      core.newsFeed.recordFeedback({ news_id: ns[0].id, kind: 'unstar', source: 'app', idempotency_key: 'off-unstar' });
      expect(core.db.prepare("SELECT COUNT(*) AS n FROM news_feed_feedback WHERE kind='star'").get()?.n).toBe(0);
    } finally { vi.useRealTimers(); cleanup(); }
  });
  it('AI冷启动候选随试读原子保存，伪造证据和换方向被拒，移除冷却即时阻止旧执行', () => {
    const { core, cleanup } = mkCore(); try {
      const c = only(core.newsFeed.getConfig(), ['ai']); c.learning.enabled = true; core.newsFeed.updateConfig({ config: c, expected_revision: 0 });
      expect(core.newsFeed.getInterests().exploration).toBeNull();
      expect(core.newsFeed.getInterests().exploration_seed?.basis_module_id).toBe('ai');
      let b = core.newsFeed.startUpdate(); const first = core.news.claimTask(b.next_task_id!); core.news.completeTask(first.task.id, first.claim_token, '无新增');
      b = core.newsFeed.advance(b.id)!; const claim = core.news.claimTask(b.next_task_id!); expect(core.newsFeed.getTaskContext(claim.task.id)?.module_id).toBe('for_you');
      const candidate = { key: '端侧编程助手', name: '端侧编程助手', scope: '在个人设备离线运行的开源编程助手与相关推理技术', reason: '探索推荐：来自你配置的 AI 编程与开源方向，目前没有阅读证据', basis_news_ids: [] as number[], basis_module_id: 'ai' };
      expect(() => core.news.submitItems(claim.task.id, claim.claim_token, [item(1)])).toThrow('候选');
      expect(() => core.news.submitItems(claim.task.id, claim.claim_token, [item(1, { candidate_topic: { ...candidate, basis_news_ids: [999] } })])).toThrow('证据');
      expect(() => core.news.submitItems(claim.task.id, claim.claim_token, [item(1, { candidate_topic: { ...candidate, name: 'AI新进展' } })])).toThrow('具体细分');
      expect(core.news.list()).toHaveLength(0);
      const sample = core.news.submitItems(claim.task.id, claim.claim_token, [item(1, { candidate_topic: candidate })]).items[0];
      expect(sample.topic_keys).toContain(candidate.key); expect(core.newsFeed.getInterests().exploration?.scope).toBe(candidate.scope);
      expect(core.newsFeed.getTaskContext(claim.task.id)?.candidate_topic?.key).toBe(candidate.key);
      expect(() => core.news.submitItems(claim.task.id, claim.claim_token, [item(2, { candidate_topic: { ...candidate, key: '另一个方向', name: '另一个方向' } })])).toThrow('一个稳定');
      core.newsFeed.manageTopic({ key: candidate.key, name: candidate.name, action: 'remove' });
      expect(core.newsFeed.getInterests().exploration).toBeNull();
      expect(() => core.news.submitItems(claim.task.id, claim.claim_token, [item(2, { candidate_topic: candidate })])).toThrow('冷却');
      core.newsFeed.manageTopic({ key: candidate.key, name: candidate.name, action: 'follow' });
      expect(core.newsFeed.getInterests().topics[0].scope).toBe(candidate.scope);
      core.newsFeed.stopUpdate(b.id); b = core.newsFeed.startUpdate(); const next = core.news.claimTask(b.next_task_id!); core.news.completeTask(next.task.id, next.claim_token);
      b = core.newsFeed.advance(b.id)!; expect(core.newsFeed.getTaskContext(b.next_task_id!)?.instructions).toContain(candidate.scope);
      core.newsFeed.resetLearning(); expect(core.db.prepare('SELECT COUNT(*) AS n FROM news_feed_candidates').get()?.n).toBe(0);
      expect(core.newsFeed.getInterests().topics.some(t => t.state === 'followed' && t.scope === candidate.scope)).toBe(true);
    } finally { cleanup(); }
  });
  it('候选只使用本轮真实正反馈证据，取消收藏后在途候选依据立即失效', () => {
    const { core, cleanup } = mkCore(); try {
      const c = only(core.newsFeed.getConfig(), ['ai']); c.learning.enabled = true; core.newsFeed.updateConfig({ config: c, expected_revision: 0 });
      const old = core.news.claimTask(core.news.createTask({ title: '偏好来源' }).id), ns = core.news.submitItems(old.task.id, old.claim_token, [item(1)]).items;
      core.newsFeed.recordFeedback({ news_id: ns[0].id, kind: 'star', source: 'app', idempotency_key: 'basis' });
      let b = core.newsFeed.startUpdate(); const first = core.news.claimTask(b.next_task_id!); core.news.completeTask(first.task.id, first.claim_token); b = core.newsFeed.advance(b.id)!;
      const claim = core.news.claimTask(b.next_task_id!), ctx = core.newsFeed.getTaskContext(claim.task.id)!; expect(ctx.interest_evidence[0].news_id).toBe(ns[0].id);
      core.newsFeed.recordFeedback({ news_id: ns[0].id, kind: 'unstar', source: 'app', idempotency_key: 'remove-basis' });
      expect(() => core.news.submitItems(claim.task.id, claim.claim_token, [item(2, { candidate_topic: { key: '模型压缩工具', name: '模型压缩工具', scope: '开源模型的量化压缩与端侧部署工具', reason: '根据收藏的开源模型消息探索相邻方向', basis_news_ids: [ns[0].id] } })])).toThrow('已撤回');
      expect(core.newsFeed.getInterests().exploration).toBeNull();
    } finally { cleanup(); }
  });
  it('关闭陌生探索仍采集已推断兴趣，匹配新闻无需伪装候选', () => {
    const { core, cleanup } = mkCore(); try {
      const c = only(core.newsFeed.getConfig(), ['ai']); c.learning.enabled = true; c.learning.exploration_enabled = false;
      core.newsFeed.updateConfig({ config: c, expected_revision: 0 });
      const t = core.news.claimTask(core.news.createTask({ title: '跨日兴趣证据' }).id), ns = core.news.submitItems(t.task.id, t.claim_token, [item(1), item(2)]).items;
      core.newsFeed.recordFeedback({ news_id: ns[0].id, kind: 'star', source: 'app', idempotency_key: 'day-one' });
      vi.useFakeTimers(); vi.setSystemTime(Date.now() + 24 * 3600_000);
      core.newsFeed.recordFeedback({ news_id: ns[1].id, kind: 'star', source: 'app', idempotency_key: 'day-two' });
      expect(core.newsFeed.getInterests().topics.some(t => t.state === 'inferred')).toBe(true); expect(core.newsFeed.getInterests().exploration_seed).toBeNull();
      let b = core.newsFeed.startUpdate(); const first = core.news.claimTask(b.next_task_id!); core.news.completeTask(first.task.id, first.claim_token); b = core.newsFeed.advance(b.id)!;
      const claim = core.news.claimTask(b.next_task_id!), ctx = core.newsFeed.getTaskContext(claim.task.id)!;
      expect(ctx.module_id).toBe('for_you'); expect(claim.task.max_items).toBe(5); expect(b.modules.find(m => m.module_id === 'for_you')?.target).toBe(10);
      expect(() => core.news.submitItems(claim.task.id, claim.claim_token, [item(3, { topic_keys: ['完全无关'] })])).toThrow('无依据');
      expect(core.news.submitItems(claim.task.id, claim.claim_token, [item(3)]).inserted).toBe(1);
    } finally { vi.useRealTimers(); cleanup(); }
  });
  it('有明确兴趣时混合匹配与陌生试读，候选两则上限在phase2和删除后仍累计', () => {
    const { core, cleanup } = mkCore(); try {
      const c = only(core.newsFeed.getConfig(), ['ai']); c.learning.enabled = true; c.modules[0].headline_count = 1; c.modules[0].max_items = 1;
      core.newsFeed.updateConfig({ config: c, expected_revision: 0 }); core.newsFeed.manageTopic({ key: '开源模型', action: 'follow' });
      let b = core.newsFeed.startUpdate(); const initial = core.news.claimTask(b.next_task_id!); core.news.completeTask(initial.task.id, initial.claim_token); b = core.newsFeed.advance(b.id)!;
      const p1 = core.news.claimTask(b.next_task_id!), candidate = { key: '端侧推理调优', name: '端侧推理调优', scope: '开源小模型的本地推理性能与量化工具', reason: '探索推荐：来自你配置的开源模型方向', basis_news_ids: [] as number[], basis_module_id: 'ai' };
      const accepted = core.news.submitItems(p1.task.id, p1.claim_token, [item(1, { candidate_topic: candidate }), item(2), item(3), item(4), item(5)]);
      core.news.completeTask(p1.task.id, p1.claim_token); b = core.newsFeed.advance(b.id)!;
      while (core.newsFeed.getTaskContext(b.next_task_id!)?.module_id !== 'for_you') { const other = core.news.claimTask(b.next_task_id!); core.news.completeTask(other.task.id, other.claim_token); b = core.newsFeed.advance(b.id)!; }
      expect(b.modules.find(m => m.task_id === b.next_task_id)?.phase).toBe(2);
      const p2 = core.news.claimTask(b.next_task_id!); expect(p2.task.max_items).toBe(5);
      core.news.submitItems(p2.task.id, p2.claim_token, [item(6, { candidate_topic: candidate })]);
      core.news.deleteItem(accepted.items[0].id);
      expect(() => core.news.submitItems(p2.task.id, p2.claim_token, [item(7, { candidate_topic: candidate })])).toThrow('最多 2');
      expect(core.news.submitItems(p2.task.id, p2.claim_token, [item(7)]).inserted).toBe(1);
    } finally { cleanup(); }
  });
  it('撤销或清空后旧反馈请求不能重放复活，收据只存不可反推的键摘要', () => {
    const { core, cleanup } = mkCore(); try {
      const c = core.newsFeed.getConfig(); c.learning.enabled = true; core.newsFeed.updateConfig({ config: c, expected_revision: 0 });
      const claim = core.news.claimTask(core.news.createTask({ title: '幂等行为测试' }).id), n = core.news.submitItems(claim.task.id, claim.claim_token, [item(1)]).items[0];
      core.newsFeed.recordFeedback({ news_id: n.id, kind: 'star', source: 'app', idempotency_key: 'star-original' });
      core.newsFeed.recordFeedback({ news_id: n.id, kind: 'unstar', source: 'app', idempotency_key: 'unstar-new' });
      expect(core.newsFeed.recordFeedback({ news_id: n.id, kind: 'star', source: 'app', idempotency_key: 'star-original' }).recorded).toBe(false);
      expect(core.news.list()[0].is_starred).toBe(false);
      core.newsFeed.recordFeedback({ news_id: n.id, kind: 'hide', source: 'app', idempotency_key: 'hide-original' });
      core.newsFeed.recordFeedback({ news_id: n.id, kind: 'undo_hide', source: 'app', idempotency_key: 'show-new' });
      expect(core.newsFeed.recordFeedback({ news_id: n.id, kind: 'hide', source: 'app', idempotency_key: 'hide-original' }).recorded).toBe(false);
      expect(core.newsFeed.list({ history: true })).toHaveLength(1);
      core.newsFeed.resetLearning(); expect(core.newsFeed.recordFeedback({ news_id: n.id, kind: 'star', source: 'app', idempotency_key: 'star-original' }).recorded).toBe(false);
      for (const r of core.db.prepare('SELECT * FROM news_feed_feedback_receipts').all()) expect(r.key_hash).toMatch(/^[a-f0-9]{64}$/);
    } finally { cleanup(); }
  });
  it('收藏反馈在学习关闭时仍保存状态，标记动作被禁用则整个反馈事务回滚', () => {
    const { core, cleanup } = mkCore(); try {
      const claim = core.news.claimTask(core.news.createTask({ title: '收藏对称入口' }).id), n = core.news.submitItems(claim.task.id, claim.claim_token, [item(1)]).items[0];
      core.newsFeed.recordFeedback({ news_id: n.id, kind: 'star', source: 'explicit', idempotency_key: 'disabled-learning-star' });
      expect(core.news.list()[0].is_starred).toBe(true); expect(core.db.prepare('SELECT COUNT(*) AS n FROM news_feed_feedback').get()?.n).toBe(0);
      core.newsFeed.recordFeedback({ news_id: n.id, kind: 'unstar', source: 'explicit', idempotency_key: 'disabled-learning-unstar' }); expect(core.news.list()[0].is_starred).toBe(false);
      core.ontology.updateActionType('mark_news_starred', { status: 'disabled' });
      expect(() => core.newsFeed.recordFeedback({ news_id: n.id, kind: 'star', source: 'explicit', idempotency_key: 'blocked-star' })).toThrow('ACTION_DISABLED');
      expect(core.news.list()[0].is_starred).toBe(false);
      expect(core.db.prepare('SELECT COUNT(*) AS n FROM news_feed_feedback_receipts').get()?.n).toBe(2);
      expect(() => core.commands.execute('record_news_feedback', { input: { news_id: n.id, kind: 'read', source: 'app', reading_seconds: 30, idempotency_key: 'fake-app' } })).toThrow();
    } finally { cleanup(); }
  });
  it('暂停事件的公共重大报道仍可入库，不恢复关注也不进入推荐', () => {
    const { core, cleanup } = mkCore(); try {
      const config = only(core.newsFeed.getConfig(), ['international']); core.newsFeed.updateConfig({ config, expected_revision: 0 });
      const e = core.newsFeed.getInterests().events[0]; core.newsFeed.updateEvent({ id: e.id, status: 'ended', expected_revision: e.revision });
      const b = core.newsFeed.startUpdate(), task = core.news.claimTask(b.next_task_id!);
      const n = core.news.submitItems(task.task.id, task.claim_token, [item(1, { event_id: e.id })]).items[0];
      expect(n.module_id).toBe('international'); expect(n.event_id).toBe(e.id);
      expect(core.newsFeed.getInterests().events.find(v => v.id === e.id)?.status).toBe('ended');
      expect(core.newsFeed.list({ module_id: 'for_you' })).toHaveLength(0);
      expect(() => core.news.submitItems(task.task.id, task.claim_token, [item(2, { event_id: 'unknown-event' })])).toThrow('撤回');
    } finally { cleanup(); }
  });
  it('固定时间窗按批次开始核实，提交稍晚不移动边界，纯展示调整不改已有快照', () => {
    const { core, cleanup } = mkCore(); try {
      const c = only(core.newsFeed.getConfig(), ['domestic']); c.modules[0].window_hours = 1; c.modules[0].headline_count = 1; c.modules[0].max_items = 2; c.budget_minutes = 120;
      core.newsFeed.updateConfig({ config: c, expected_revision: 0 }); const b = core.newsFeed.startUpdate(), task = core.news.claimTask(b.next_task_id!), end = Date.parse(b.window_end);
      const display = core.newsFeed.getConfig(); display.content.summary_depth = 'deep'; core.newsFeed.updateConfig({ config: display, expected_revision: display.revision });
      expect(core.newsFeed.getTaskContext(task.task.id)?.instructions).toContain('摘要深度：standard');
      vi.useFakeTimers(); vi.setSystemTime(end + 10 * 60_000);
      expect(() => core.news.submitItems(task.task.id, task.claim_token, [item(1, { published_at: new Date(end + 1).toISOString() })])).toThrow('固定时间窗');
      expect(core.news.submitItems(task.task.id, task.claim_token, [item(1, { published_at: new Date(end - 55 * 60_000).toISOString() })]).inserted).toBe(1);
      core.news.completeTask(task.task.id, task.claim_token); const next = core.newsFeed.advance(b.id)!;
      expect(core.newsFeed.getTaskContext(next.next_task_id!)?.instructions).toContain('摘要深度：deep');
      expect(core.newsFeed.preview().modules[0].instructions).toContain('摘要深度：deep');
    } finally { vi.useRealTimers(); cleanup(); }
  });
  it('模块改名、顺序和折叠数量立即应用，不替换排队任务也不撤回运行令牌', () => {
    const { core, cleanup } = mkCore(); try {
      const c = only(core.newsFeed.getConfig(), ['domestic', 'ai']); core.newsFeed.updateConfig({ config: c, expected_revision: 0 });
      const b = core.newsFeed.startUpdate(), original = b.next_task_id!, snapshot = core.newsFeed.getTaskContext(original)!.instructions;
      const display = core.newsFeed.getConfig(); display.modules.reverse(); display.modules.find(m => m.id === 'domestic')!.name = '国内重点'; display.modules.find(m => m.id === 'domestic')!.headline_count = 3; display.content.image_display = 'detail_only';
      core.newsFeed.updateConfig({ config: display, expected_revision: display.revision });
      const current = core.newsFeed.listBatches()[0]; expect(current.id).toBe(b.id); expect(current.status).toBe('active'); expect(current.next_task_id).toBe(original);
      expect(current.modules.map(m => m.module_id)).toEqual(['ai', 'domestic']); expect(current.modules[1].name).toBe('国内重点');
      expect(core.newsFeed.getTaskContext(original)?.instructions).toBe(snapshot);
      const held = core.news.claimTask(original); const nextDisplay = core.newsFeed.getConfig(); nextDisplay.modules[1].name = '中国'; core.newsFeed.updateConfig({ config: nextDisplay, expected_revision: nextDisplay.revision });
      expect(core.news.submitItems(original, held.claim_token, [item(1)]).inserted).toBe(1);
    } finally { cleanup(); }
  });
  it('未开始任务用最新范围替代，运行中保留快照，后续模块与阶段读取新要求但不重置预算', () => {
    const { core, cleanup } = mkCore(); try {
      const c = only(core.newsFeed.getConfig(), ['domestic', 'ai']); c.modules.forEach(m => { m.headline_count = 2; m.max_items = 4; }); core.newsFeed.updateConfig({ config: c, expected_revision: 0 });
      const b = core.newsFeed.startUpdate(), superseded = b.next_task_id!;
      const changed = core.newsFeed.getConfig(); Object.assign(changed.modules[0], { scope: '首次新范围：新能源政策', source_preferences: ['中国政府网'], source_exclusions: ['二次转载'], window_hours: 6, max_items: 3 });
      core.newsFeed.updateConfig({ config: changed, expected_revision: changed.revision });
      const replacement = core.newsFeed.listBatches()[0].next_task_id!; expect(replacement).not.toBe(superseded); expect(core.news.getTask(superseded).status).toBe('cancelled');
      const context = core.newsFeed.getTaskContext(replacement)!; expect(context.batch_id).toBe(b.id); expect(context.window_end).toBe(b.window_end); expect(context.instructions).toContain('新能源政策'); expect(context.instructions).toContain('中国政府网'); expect(context.instructions).toContain('二次转载');
      const held = core.news.claimTask(replacement); core.news.submitItems(replacement, held.claim_token, [item(1)]);
      const later = core.newsFeed.getConfig(); Object.assign(later.modules[0], { scope: '第二次新范围：经济政策', window_hours: 2, max_items: 2 }); later.modules[1].scope = '尚未开始的开源基础设施新闻'; later.content.summary_depth = 'deep';
      core.newsFeed.updateConfig({ config: later, expected_revision: later.revision });
      const running = core.newsFeed.getTaskContext(replacement)!; expect(running.instructions).toBe(context.instructions); expect(running.window_start).toBe(context.window_start); expect(running.remaining).toBe(1);
      expect(core.news.submitItems(replacement, held.claim_token, [item(2)]).inserted).toBe(1); expect(() => core.news.submitItems(replacement, held.claim_token, [item(3)])).toThrow('额度');
      core.news.completeTask(replacement, held.claim_token); const advanced = core.newsFeed.advance(b.id)!;
      const next = core.newsFeed.getTaskContext(advanced.next_task_id!)!; expect(next.module_id).toBe('ai'); expect(next.instructions).toContain('尚未开始的开源基础设施'); expect(next.instructions).toContain('摘要深度：deep'); expect(next.window_end).toBe(b.window_end);
      const increased = core.newsFeed.getConfig(); increased.modules[0].max_items = 4; core.newsFeed.updateConfig({ config: increased, expected_revision: increased.revision });
      expect(core.newsFeed.listBatches()[0].modules.find(m => m.module_id === 'domestic')).toMatchObject({ accepted_count: 2, target: 2 });
      core.newsFeed.stopUpdate(b.id); const continued = core.newsFeed.continueUpdate({ batch_id: b.id }); expect(continued.id).toBe(b.id); expect(continued.modules.find(m => m.module_id === 'domestic')?.accepted_count).toBe(2);
    } finally { cleanup(); }
  });
  it('降低上限不删除已收录，停用模块与关闭学习只撤回相关任务', () => {
    const { core, cleanup } = mkCore(); try {
      const c = only(core.newsFeed.getConfig(), ['domestic', 'ai']); c.learning.enabled = true; c.modules[0].headline_count = 3; c.modules[0].max_items = 5; core.newsFeed.updateConfig({ config: c, expected_revision: 0 });
      const b = core.newsFeed.startUpdate(), held = core.news.claimTask(b.next_task_id!); core.news.submitItems(held.task.id, held.claim_token, [item(1), item(2), item(3)]);
      const lower = core.newsFeed.getConfig(); lower.modules[0].headline_count = 2; lower.modules[0].max_items = 2; core.newsFeed.updateConfig({ config: lower, expected_revision: lower.revision });
      expect(core.newsFeed.getTaskContext(held.task.id)?.remaining).toBe(0); expect(core.news.list()).toHaveLength(3);
      const disabled = core.newsFeed.getConfig(); disabled.modules[0].enabled = false; core.newsFeed.updateConfig({ config: disabled, expected_revision: disabled.revision }); expect(() => core.news.completeTask(held.task.id, held.claim_token)).toThrow();
      const next = core.newsFeed.advance(b.id)!, publicTask = core.news.claimTask(next.next_task_id!); expect(core.newsFeed.getTaskContext(publicTask.task.id)?.module_id).toBe('ai');
      const noLearning = core.newsFeed.getConfig(); noLearning.learning.enabled = false; core.newsFeed.updateConfig({ config: noLearning, expected_revision: noLearning.revision });
      expect(core.newsFeed.listBatches()[0].status).toBe('active'); expect(core.news.submitItems(publicTask.task.id, publicTask.claim_token, [item(4)]).inserted).toBe(1);
      expect(core.newsFeed.listBatches()[0].modules.find(m => m.module_id === 'for_you')?.status).toBe('skipped');
    } finally { cleanup(); }
  });
  it('候选移除和少推荐分别保留明确关注，恢复频率不撤订阅且辅助记录不冒充兴趣', () => {
    const { core, cleanup } = mkCore(); try {
      const c = only(core.newsFeed.getConfig(), ['ai']); c.learning.enabled = true; core.newsFeed.updateConfig({ config: c, expected_revision: 0 });
      core.newsFeed.manageTopic({ key: 'AI 编程', name: 'AI 编程', action: 'follow' }); core.newsFeed.manageTopic({ key: '开源模型', action: 'follow' });
      core.newsFeed.manageTopic({ key: 'AI 编程', action: 'remove' }); core.newsFeed.manageTopic({ key: 'AI 编程', action: 'reduce' });
      const interests = core.newsFeed.getInterests(); expect(interests.topics).toHaveLength(2); expect(interests.topics.find(t => t.key === 'ai编程')).toMatchObject({ state: 'followed', reduced: true }); expect(interests.topics.find(t => t.key === 'ai编程')?.candidate_cooldown_until).toBeTruthy();
      let b = core.newsFeed.startUpdate(); const initial = core.news.claimTask(b.next_task_id!); core.news.completeTask(initial.task.id, initial.claim_token); b = core.newsFeed.advance(b.id)!;
      const personal = core.news.claimTask(b.next_task_id!), context = core.newsFeed.getTaskContext(personal.task.id)!; expect(context.interests.some(t => t.key === 'ai编程')).toBe(true); expect(context.instructions).toContain('少推荐主题：AI 编程');
      const accepted = core.news.submitItems(personal.task.id, personal.claim_token, [item(1, { topic_keys: ['AI 编程'] }), item(2)]).items;
      expect(core.newsFeed.list({ module_id: 'for_you' })[0].id).toBe(accepted[1].id);
      core.newsFeed.manageTopic({ key: '开源模型', action: 'unfollow' }); core.newsFeed.stopUpdate(b.id); b = core.newsFeed.startUpdate(); expect(b.modules.find(m => m.module_id === 'for_you')?.target).toBe(5);
      const restored = core.newsFeed.manageTopic({ key: 'AI 编程', action: 'restore' }).topics.find(t => t.key === 'ai编程')!; expect(restored.state).toBe('followed'); expect(restored.reduced).toBe(false); expect(restored.candidate_cooldown_until).toBeNull();
      expect(core.newsFeed.manageTopic({ key: 'AI 编程', action: 'unfollow' }).topics.some(t => t.state === 'followed')).toBe(false);
    } finally { cleanup(); }
  });
});
