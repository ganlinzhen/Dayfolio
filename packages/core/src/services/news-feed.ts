// 新闻配置、批次和兴趣学习共用服务；提交事务中校验预算及撤回权限。
import { createHash, randomUUID } from 'node:crypto';
import { inTx, mapNews, type DbAdapter } from '../db';
import type { NewsArticleMetadata, NewsItem, NewsSubmissionItem, NewsCandidateTopic } from '../types';
import type { NewsService } from './news';
import { validateSourceUrl } from './news';
import type { NewsContentOptions, NewsFeedConfig, NewsFeedBatch, NewsFeedBatchModule, NewsTaskContext, NewsEventFollow, NewsEventInput, NewsFeedbackInput, NewsTopicInput, NewsSourceInput, NewsTopicInterest, NewsInterestState, NewsFeedItem, NewsCorrection, NewsCorrectionInput, NewsFeedPreview } from '../news-types';
type StoredTaskContext = NewsTaskContext & { module_snapshot?: NewsFeedConfig['modules'][number] };

const nowIso = () => new Date().toISOString();
const HOUR = 3600_000;
const keyOf = (s: string) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '').slice(0, 80);
const text = (s: unknown, max = 2000) => { if (typeof s !== 'string' || s.length > max) throw new Error(`文本须为不超过 ${max} 字的字符串`); return s.trim(); };
const json = <T>(v: unknown): T => JSON.parse(String(v));
const CONTENT: NewsContentOptions = { summary_depth: 'standard', image_policy: 'prefer_original', image_display: 'list_thumbnail', show_background: true, show_impact: true, show_uncertainty: true };
export function defaultNewsFeedConfig(): NewsFeedConfig {
  return { revision: 0, updated_at: null, modules: [
    { id: 'domestic', name: '国内', kind: 'public', scope: '中国国内公共重要新闻，兼顾政策、经济、社会、科技与民生', exclusions: '', enabled: true, window_hours: 24, headline_count: 5, max_items: 10, content: {} },
    { id: 'international', name: '国际', kind: 'public', scope: '国际公共重要新闻，兼顾世界各地区的重要进展', exclusions: '', enabled: true, window_hours: 24, headline_count: 5, max_items: 10, content: {} },
    { id: 'ai', name: 'AI', kind: 'topic', scope: '大模型、Agent、AI 编程、开源模型、Codex、Claude Code 与重要研究', exclusions: '', enabled: true, window_hours: 24, headline_count: 5, max_items: 10, content: {} },
    { id: 'events', name: '时事关注', kind: 'events', scope: '仅跟踪当前仍有效的事件关注，多个事件共享本模块配额', exclusions: '', enabled: true, window_hours: 24, headline_count: 5, max_items: 10, content: {} },
  ], content: { ...CONTENT }, schedule: { enabled: true, timezone: 'Asia/Shanghai', times: ['08:00', '12:00', '17:00'] }, learning: { enabled: false, exploration_enabled: true }, budget_minutes: 20 };
}
function validateContent(v: Partial<NewsContentOptions>, partial = false): void {
  const allowed = Object.keys(CONTENT);
  if (!v || typeof v !== 'object' || Object.keys(v).some(k => !allowed.includes(k))) throw new Error('摘要展示配置无效');
  for (const [k, value] of Object.entries(v)) if (k === 'summary_depth' ? !['brief', 'standard', 'deep'].includes(String(value)) : k === 'image_policy' ? !['prefer_original', 'none'].includes(String(value)) : k === 'image_display' ? !['list_thumbnail', 'detail_only'].includes(String(value)) : typeof value !== 'boolean') throw new Error('摘要展示配置值无效');
  if (!partial && allowed.some(k => k !== 'image_display' && !(k in v))) throw new Error('摘要展示配置不完整');
}
function validateConfig(input: NewsFeedConfig): NewsFeedConfig {
  const c = structuredClone(input);
  if (!c || !Array.isArray(c.modules) || c.modules.length > 20 || c.modules.length < 1) throw new Error('模块数量须为 1~20');
  const ids = new Set<string>();
  for (const m of c.modules) {
    if (!/^[a-z0-9_-]{1,60}$/.test(m.id) || m.id === 'for_you' || ids.has(m.id)) throw new Error('模块身份无效或重复');
    ids.add(m.id); m.name = text(m.name, 50); m.scope = text(m.scope, 1200); m.exclusions = text(m.exclusions, 600);
    if (!m.name || !m.scope || !['public', 'topic', 'events'].includes(m.kind) || typeof m.enabled !== 'boolean') throw new Error('模块名称、类型或关注范围无效');
    if (!Number.isInteger(m.window_hours) || m.window_hours < 1 || m.window_hours > 720 || !Number.isInteger(m.headline_count) || m.headline_count < 1 || m.headline_count > 5 || !Number.isInteger(m.max_items) || m.max_items < m.headline_count || m.max_items > 10) throw new Error('模块时间窗须为 1~720 小时，重点 1~5 则，总数最多 10 则');
    validateContent(m.content, true);
    for (const field of ['source_preferences', 'source_exclusions'] as const) if (m[field] != null && (!Array.isArray(m[field]) || m[field]!.length > 20 || m[field]!.some(s => typeof s !== 'string' || !s.trim() || s.length > 200))) throw new Error('来源偏好须为最多 20 个有效来源');
    if (m.extra_instructions != null) m.extra_instructions = text(m.extra_instructions, 1500);
  }
  validateContent(c.content);
  if (!Number.isInteger(c.budget_minutes) || c.budget_minutes < 5 || c.budget_minutes > 120) throw new Error('整轮预算须为 5~120 分钟');
  if (!c.schedule || c.schedule.timezone !== 'Asia/Shanghai' || typeof c.schedule.enabled !== 'boolean' || !Array.isArray(c.schedule.times) || c.schedule.times.length < 1 || c.schedule.times.length > 12 || c.schedule.times.some(t => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) || new Set(c.schedule.times).size !== c.schedule.times.length) throw new Error('定时更新须使用北京时间有效时刻，不得重复');
  if (!c.learning || typeof c.learning.enabled !== 'boolean' || typeof c.learning.exploration_enabled !== 'boolean') throw new Error('兴趣学习设置无效');
  return c;
}

export function createNewsFeedService(db: DbAdapter, news: NewsService) {
  if (!db.prepare('SELECT 1 FROM news_feed_state WHERE id=1').get()) {
    db.prepare('INSERT INTO news_feed_state(id,config_json) VALUES(1,?)').run(JSON.stringify(defaultNewsFeedConfig()));
    for (const [id, name] of [['russia-ukraine', '俄乌'], ['us-iran', '美伊']]) {
      const e: NewsEventFollow = { id, name, scope: `${name}局势的已核实重要进展`, status: 'active', expires_at: null, revision: 1, updated_at: nowIso(), last_viewed_at: null, reminder_due: false };
      db.prepare('INSERT INTO news_feed_events(id,data_json) VALUES(?,?)').run(id, JSON.stringify(e));
    }
  }
  const state = () => db.prepare('SELECT * FROM news_feed_state WHERE id=1').get()!;
  const epoch = () => Number(state().learning_epoch);
  const getConfig = (): NewsFeedConfig => json(state().config_json);
  const events = (): NewsEventFollow[] => db.prepare('SELECT * FROM news_feed_events ORDER BY rowid').all().map(r => {
    const e = json<NewsEventFollow>(r.data_json);
    if (e.status === 'active' && e.expires_at && e.expires_at <= nowIso()) return { ...e, status: 'paused', reminder_due: false };
    return { ...e, reminder_due: e.status === 'active' && Date.now() - Date.parse(e.last_viewed_at ?? e.updated_at) > 14 * 24 * HOUR };
  });
  const liveEvents = () => events().filter(e => e.status === 'active');
  const saveBatch = (b: NewsFeedBatch) => db.prepare('INSERT INTO news_feed_batches(id,data_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json').run(b.id, JSON.stringify(b));
  const getBatch = (id: string): NewsFeedBatch => { const row = db.prepare('SELECT data_json FROM news_feed_batches WHERE id=?').get(id); if (!row) throw new Error('新闻批次不存在'); return json(row.data_json); };
  const hydrate = (b: NewsFeedBatch): NewsFeedBatch => ({ ...b, modules: b.modules.map(m => {
    const count = db.prepare('SELECT COUNT(*) AS n FROM news_feed_members WHERE batch_id=? AND module_id=?').get(b.id, m.module_id)!;
    const task = m.task_id == null ? null : news.getTask(m.task_id);
    return { ...m, accepted_count: Number(count.n), status: task?.status ?? m.status, note: task?.completed_note ?? task?.last_error ?? m.note };
  }) });
  const listBatches = (opts: { limit?: number } = {}): NewsFeedBatch[] => db.prepare('SELECT data_json FROM news_feed_batches ORDER BY rowid DESC LIMIT ?').all(Math.min(Math.max(opts.limit ?? 20, 1), 100)).map(r => hydrate(json(r.data_json)));
  const invalidate = (reason: string) => {
    for (const b of listBatches({ limit: 100 }).filter(b => b.status === 'active')) {
      b.status = 'invalidated'; b.finished_at = nowIso(); b.next_task_id = null; saveBatch(b);
      for (const m of b.modules) if (m.task_id != null) db.prepare("UPDATE news_tasks SET status='cancelled',claim_token=NULL,claim_expires_at=NULL,last_error=?,updated_at=? WHERE id=? AND status IN ('pending','claimed')").run(reason, nowIso(), m.task_id);
    }
  };
  const updateConfig = (input: { config: NewsFeedConfig; expected_revision: number }): NewsFeedConfig => inTx(db, () => {
    const old = getConfig(); if (old.revision !== input.expected_revision) throw new Error('新闻配置已被其他窗口更新，请重新加载后再保存');
    const c = validateConfig(input.config); c.revision = old.revision + 1; c.updated_at = nowIso();
    const learningChanged = old.learning.enabled !== c.learning.enabled;
    if (learningChanged) db.prepare('UPDATE news_feed_state SET learning_epoch=learning_epoch+1 WHERE id=1').run();
    db.prepare('UPDATE news_feed_state SET config_json=? WHERE id=1').run(JSON.stringify(c));
    for (const b of listBatches({ limit: 100 }).filter(b => b.status === 'active')) {
      b.learning_epoch = epoch();
      for (const m of b.modules) {
        const current = c.modules.find(v => v.id === m.module_id), previous = old.modules.find(v => v.id === m.module_id);
        const task = m.task_id == null ? null : news.getTask(m.task_id);
        const withdrawn = m.module_id === 'for_you' ? learningChanged : !current?.enabled;
        if (withdrawn) {
          if (task && ['pending', 'claimed'].includes(task.status)) db.prepare("UPDATE news_tasks SET status='cancelled',claim_token=NULL,claim_expires_at=NULL,last_error='相关关注范围已撤回',updated_at=? WHERE id=?").run(nowIso(), task.id);
          m.task_id = null; m.status = 'skipped'; m.note = '相关关注范围已撤回'; continue;
        }
        if (current) { m.name = current.name; m.target = Math.min(m.target, current.max_items); }
        // 已认领或曾执行的重试保留原快照；仅替代从未开始的排队任务。
        const acquisition = (v: NewsFeedConfig['modules'][number] | undefined, global: NewsContentOptions) => {
          if (!v) return null;
          const { name: _name, headline_count: _headline, content, ...rest } = v;
          const { image_display: _display, ...rules } = { ...global, ...content };
          return { ...rest, content: rules };
        };
        const changed = m.module_id === 'for_you' ? old.learning.exploration_enabled !== c.learning.exploration_enabled : JSON.stringify(acquisition(previous, old.content)) !== JSON.stringify(acquisition(current, c.content));
        if (task?.status === 'pending' && task.attempts === 0 && changed) {
          db.prepare("UPDATE news_tasks SET status='cancelled',last_error='已由最新配置替代，批次配额沿用',updated_at=? WHERE id=?").run(nowIso(), task.id);
          m.task_id = null;
          if (m.accepted_count >= m.target) m.status = 'completed';
          else { m.status = 'waiting'; makeTask(b, c, m, m.phase); }
        }
      }
      const order = new Map(c.modules.map((m, i) => [m.id, i]));
      b.modules.sort((a, d) => (order.get(a.module_id) ?? Number.MAX_SAFE_INTEGER) - (order.get(d.module_id) ?? Number.MAX_SAFE_INTEGER));
      b.next_task_id = b.modules.find(m => ['pending', 'claimed'].includes(m.status))?.task_id ?? null;
      saveBatch(b);
    }
    return c;
  });

  const getInterests = (): NewsInterestState => {
    const enabled = getConfig().learning.enabled;
    const explicit = db.prepare("SELECT * FROM news_feed_topics WHERE state IN ('followed','reduced','removed')").all();
    const reductions = new Set(db.prepare("SELECT key FROM news_feed_topics WHERE state='topic_reduced'").all().map(r => String(r.key).slice('reduction:'.length)));
    const cooldowns = new Map(db.prepare("SELECT key,cooldown_until FROM news_feed_topics WHERE state='candidate_removed'").all().map(r => [String(r.key).slice('candidate:'.length), String(r.cooldown_until)]));
    const stats = new Map<string, { score: number; news: Set<number>; dates: Set<string>; reasons: Set<string> }>();
    const weights: Record<string, number> = { open: 0.2, read: 1, source_open: 1.5, star: 3, interested: 4, less_topic: -5 };
    if (enabled) for (const r of db.prepare('SELECT f.*,n.topic_keys_json,n.event_id FROM news_feed_feedback f JOIN news n ON n.id=f.news_id WHERE f.epoch=? AND f.created_at>=? ORDER BY f.created_at').all(epoch(), new Date(Date.now() - 90 * 24 * HOUR).toISOString())) {
      if (r.event_id) continue;
      if (!weights[String(r.kind)]) continue;
      const keys: string[] = r.topic_key ? [String(r.topic_key)] : r.topic_keys_json ? json(r.topic_keys_json) : [];
      for (const key of keys) {
        const v = stats.get(key) ?? { score: 0, news: new Set(), dates: new Set(), reasons: new Set() };
        v.score += (weights[String(r.kind)] ?? 0) * Math.pow(0.5, (Date.now() - Date.parse(String(r.created_at))) / (30 * 24 * HOUR));
        if (weights[String(r.kind)] > 0) { v.news.add(Number(r.news_id)); v.dates.add(String(r.created_at).slice(0, 10)); }
        if (weights[String(r.kind)] > 0) v.reasons.add(r.kind === 'star' ? '收藏过该方向新闻' : r.kind === 'interested' ? '明确表示感兴趣' : '近期阅读该方向新闻');
        stats.set(key, v);
      }
    }
    const topics: NewsTopicInterest[] = [];
    for (const r of explicit) {
      const key = String(r.key), v = stats.get(key); stats.delete(key);
      topics.push({ key, name: String(r.name), scope: r.scope ? String(r.scope) : undefined, reduced: reductions.has(key), candidate_cooldown_until: cooldowns.get(key) ?? null, state: r.state as NewsTopicInterest['state'], score: v?.score ?? 0, evidence_count: v?.news.size ?? 0, reasons: [r.state === 'followed' ? '你明确关注了该主题' : r.state === 'reduced' ? '你选择了少推荐' : '你移除了该候选'], cooldown_until: r.cooldown_until == null ? null : String(r.cooldown_until) });
    }
    for (const [key, v] of stats) if (v.news.size >= 2 && v.dates.size >= 2 && v.score >= 2) topics.push({ key, name: key, state: 'inferred', reduced: reductions.has(key), candidate_cooldown_until: cooldowns.get(key) ?? null, score: v.score, evidence_count: v.news.size, reasons: [...v.reasons], cooldown_until: null });
    const priority = (t: NewsTopicInterest) => (t.state === 'followed' ? 100 : t.score) * (t.reduced ? 0.2 : 1);
    topics.sort((a, b) => priority(b) - priority(a));
    const blocked = new Set(events().filter(e => e.status !== 'active').flatMap(e => [keyOf(e.id), keyOf(e.name)]));
    const candidates = db.prepare('SELECT data_json FROM news_feed_candidates WHERE epoch=? ORDER BY rowid DESC').all(epoch()).map(r => json<NewsCandidateTopic>(r.data_json));
    const exploration = enabled && getConfig().learning.exploration_enabled ? candidates.find(t => !blocked.has(keyOf(t.key)) && !reductions.has(t.key) && !(cooldowns.get(t.key) && cooldowns.get(t.key)! > nowIso()) && !topics.some(x => x.key === t.key && (x.state === 'followed' || x.state === 'reduced' || (x.state === 'removed' && (!x.cooldown_until || x.cooldown_until > nowIso()))))) ?? null : null;
    const seedModule = getConfig().modules.find(m => m.enabled && m.kind === 'topic');
    const exploration_seed = enabled && getConfig().learning.exploration_enabled ? { scope: topics.filter(t => t.state === 'followed' || t.state === 'inferred').map(t => t.scope || t.name).join('；') || seedModule?.scope || '根据公共重要新闻寻找有价值的具体新方向', basis_module_id: seedModule?.id } : null;
    const reduced = db.prepare("SELECT name FROM news_feed_topics WHERE state='source_reduced'").all().map(r => String(r.name));
    return { enabled, epoch: epoch(), topics, events: events(), exploration, exploration_seed, reduced_sources: reduced };
  };
  const compile = (c: NewsFeedConfig, moduleId: string, phase: 1 | 2 = 1, target?: number, end = nowIso()): string => {
    const m = c.modules.find(m => m.id === moduleId), interests = getInterests(), personal = moduleId === 'for_you';
    if (!m && !personal) throw new Error('新闻模块不存在');
    const content = { ...c.content, ...m?.content }, e = m?.kind === 'events' ? liveEvents() : [];
    const lines = [`请用中文整理「${m?.name ?? '猜你喜欢'}」的独立新闻。每则先打开原始来源核实，不用搜索摘要、传闻或旧闻凑数。`,
      `检索范围：${m?.scope ?? '根据以下明确关注与新行为，少量探索相邻方向'}。排除：${m?.exclusions || '无额外排除'}。`,
      `本轮第 ${phase} 阶段，最多收录 ${target ?? m?.headline_count ?? 2} 则；模块身份 module_id=${moduleId}。`,
      phase === 1 ? '首轮按公共重要性、影响范围和必要背景选出重点，不能只取时间最新的消息。' : '补充阶段先核实实质新进展，再补充相关消息；不重复前轮重点。',
      `固定时间窗：${new Date(Date.parse(end) - (m?.window_hours ?? 24) * HOUR).toISOString()} 至 ${end}。提交真实 published_at，不能用整理时间替代。`,
      `摘要深度：${content.summary_depth}。summary 应直接讲清主体、发生什么、关键事实与意义，让读者不用打开原文也能理解。${content.show_background ? 'background 提供必要背景。' : ''}${content.show_impact ? 'impact 区分已发生影响和可能影响。' : ''}${content.show_uncertainty ? 'uncertainty 说明未核实或存在分歧的部分。' : ''}`,
      content.image_policy === 'none' ? '本模块不要提交图片。' : '提取来源页面公开原图，提交 image_url、image_source_url 和准确图注 image_caption；无可靠原图则省略，不用生成图代替新闻事实。',
      '每则独立提交，不打包为 brief。附 source_url、source_name、topic_keys，时事需 event_id。同一事件的转载不重复收录；实质进展说明新增事实。已有新闻不要重复提交；缺口和联网故障分别如实说明。',
      `优先来源：${m?.source_preferences?.join('、') || '官方发布与可信一手报道'}；排除来源：${m?.source_exclusions?.join('、') || '无额外排除'}。${m?.extra_instructions || ''}`];
    if (m?.kind === 'public') lines.push('保留公共重要性与地区覆盖，不因个人点击兴趣缩小选题。');
    if (m?.kind === 'events') lines.push(`只允许有效事件：${e.map(v => `${v.name}（event_id=${v.id}，${v.scope}）`).join('；') || '无活跃事件，本模块不检索'}。暂停、结束、到期的事件不能恢复跟踪。`);
    if (personal) {
      lines.push(`明确关注：${interests.topics.filter(t => t.state === 'followed').map(t => `${t.name}（${t.scope || t.name}）`).join('、') || '暂无'}。`);
      if (interests.enabled) lines.push(`推断兴趣：${interests.topics.filter(t => t.state === 'inferred').map(t => `${t.name}（${t.reasons.join('；')}）`).join('、') || '证据不足'}；少推荐主题：${interests.topics.filter(t => t.state === 'reduced' || t.reduced).map(t => t.name).join('、')}（仍明确关注的主题保留搜索，但减少选取并排在其他匹配方向之后）；减少来源：${interests.reduced_sources.join('、')}。`);
      lines.push('优先采集与明确关注或有效推断兴趣匹配的已核实新闻，topic_keys须包含对应兴趣身份；这些新闻不附 candidate_topic，也不伪装为陌生主题。');
      if (interests.exploration_seed) lines.push(`探索种子：${interests.exploration_seed.scope}。另外可根据真实 interest_evidence 或明确配置，选择一个相关但尚未关注的具体细分方向，实时核实至多 2 则试读（整批跨阶段累计，不是每个任务 2 则），每条附相同 candidate_topic={key,name,scope,reason,basis_news_ids,basis_module_id?}。理由如实标明阅读证据或配置来源，不虚构高置信度。已有 broad 模块名或「AI新进展」不算新方向。没有可靠试读则说明缺口，不编造候选。`);
      lines.push(`禁止恢复已暂停或结束的时事：${events().filter(e => e.status !== 'active').map(e => e.name).join('、') || '暂无'}。不得从阅读推断政治立场。`);
    }
    return lines.join('\n');
  };
  const preview = (opts: { module_id?: string; config?: NewsFeedConfig } = {}): NewsFeedPreview => {
    const c = opts.config ? validateConfig(opts.config) : getConfig();
    if (opts.module_id === 'for_you') return { config_revision: c.revision, modules: [{ module_id: 'for_you', name: '猜你喜欢', instructions: compile(c, 'for_you') }] };
    return { config_revision: c.revision, modules: c.modules.filter(m => !opts.module_id || m.id === opts.module_id).map(m => ({ module_id: m.id, name: m.name, instructions: compile(c, m.id) })) };
  };
  const contextRow = (taskId: number) => db.prepare('SELECT * FROM news_feed_tasks WHERE task_id=?').get(taskId);
  const assertContext = (taskId: number): NewsTaskContext | null => {
    const row = contextRow(taskId); if (!row) return null;
    const ctx = json<NewsTaskContext>(row.context_json), b = getBatch(String(row.batch_id));
    if (b.status !== 'active') throw new Error('采集批次已停止或失效');
    if (Date.now() >= Date.parse(b.deadline_at)) throw new Error('整轮采集时间预算已用尽，已收录内容保留');
    if (ctx.module_id === 'for_you' && ctx.learning_epoch !== epoch()) throw new Error('兴趣学习代次已变化，旧任务不能继续使用画像');
    if (ctx.module_id !== 'for_you' && !getConfig().modules.some(m => m.id === ctx.module_id && m.enabled)) throw new Error('该模块已停用或移除，不能继续执行');
    if (news.getTask(taskId).status === 'cancelled') throw new Error('该模块任务已撤回，不能继续执行');
    for (const [id, rev] of Object.entries(ctx.event_revisions)) { const e = liveEvents().find(e => e.id === id); if (!e || e.revision !== rev) throw new Error('事件关注已撤回或变化，旧任务不再允许提交'); }
    const count = Number(db.prepare('SELECT COUNT(*) AS n FROM news_feed_members WHERE batch_id=? AND module_id=?').get(b.id, ctx.module_id)!.n), m = b.modules.find(m => m.module_id === ctx.module_id)!;
    const candidate = db.prepare('SELECT data_json FROM news_feed_candidates WHERE batch_id=? AND epoch=?').get(b.id, epoch());
    return { ...ctx, candidate_topic: candidate ? json(candidate.data_json) : null, task: news.getTask(taskId), remaining: Math.max(0, Math.min(news.getTask(taskId).remaining, m.target - count)), accepted_ids: db.prepare('SELECT news_id FROM news_feed_members WHERE batch_id=?').all(b.id).map(r => Number(r.news_id)), excluded_ids: db.prepare('SELECT id FROM news').all().map(r => Number(r.id)) };
  };
  const getTaskContext = (taskId: number): NewsTaskContext | null => assertContext(Number(taskId));
  const makeTask = (b: NewsFeedBatch, c: NewsFeedConfig, m: NewsFeedBatchModule, phase: 1 | 2): void => {
    const configM = c.modules.find(v => v.id === m.module_id), cap = Math.min(phase === 1 ? configM?.headline_count ?? (m.target > 2 ? 5 : 2) : m.target - m.accepted_count, m.target - m.accepted_count);
    if (configM?.kind === 'events' && !liveEvents().length) { m.status = 'skipped'; m.task_id = null; m.note = '当前没有有效时事关注'; return; }
    if (cap <= 0) return;
    const instructions = compile(c, m.module_id, phase, cap, b.window_end);
    const task = news.createTask({ title: `${m.name} · ${phase === 1 ? '重点' : '补充'}新闻`, instructions: instructions.slice(0, 2000), max_items: cap, window_hours: configM?.window_hours ?? 24 }, 'news-feed');
    const e = configM?.kind === 'events' ? liveEvents() : [];
    const interest_evidence: NewsTaskContext['interest_evidence'] = [];
    if (m.module_id === 'for_you' && c.learning.enabled) for (const r of db.prepare("SELECT n.id,n.title,n.topic_keys_json,GROUP_CONCAT(DISTINCT f.kind) AS signals FROM news_feed_feedback f JOIN news n ON n.id=f.news_id WHERE f.epoch=? AND f.kind IN ('read','source_open','star','interested','open') AND n.event_id IS NULL AND f.created_at>=? GROUP BY n.id ORDER BY MAX(f.created_at) DESC LIMIT 30").all(epoch(), new Date(Date.now() - 90 * 24 * HOUR).toISOString())) interest_evidence.push({ news_id: Number(r.id), title: String(r.title), topic_keys: r.topic_keys_json ? json(r.topic_keys_json) : [], signals: String(r.signals).split(',') });
    const ctx: StoredTaskContext = { task, batch_id: b.id, module_id: m.module_id, module_snapshot: configM ? structuredClone(configM) : undefined, instructions, window_start: new Date(Date.parse(b.window_end) - task.window_hours * HOUR).toISOString(), window_end: b.window_end, remaining: cap, accepted_ids: [], excluded_ids: [], config_revision: c.revision, learning_epoch: b.learning_epoch, event_revisions: Object.fromEntries(e.map(v => [v.id, v.revision])), interests: m.module_id === 'for_you' ? getInterests().topics.filter(t => t.state === 'followed' || t.state === 'inferred') : [], interest_evidence, exploration_seed: m.module_id === 'for_you' ? getInterests().exploration_seed : null, candidate_topic: null };
    db.prepare('INSERT INTO news_feed_tasks(task_id,batch_id,module_id,phase,context_json) VALUES(?,?,?,?,?)').run(task.id, b.id, m.module_id, phase, JSON.stringify(ctx));
    m.phase = phase; m.task_id = task.id; m.status = 'pending';
  };
  const advance = (batchId?: string): NewsFeedBatch | null => inTx(db, () => {
    const source = batchId ? getBatch(batchId) : listBatches({ limit: 100 }).find(b => b.status === 'active'); if (!source) return null;
    const b = hydrate(source); b.next_task_id = null; if (b.status !== 'active') return b;
    if (Date.now() >= Date.parse(b.deadline_at)) { b.status = 'budget_exhausted'; b.finished_at = nowIso(); saveBatch(b); return b; }
    // 执行失败会释放任务回 pending；先覆盖其他模块，避免在原地无限重排。
    for (const m of b.modules) if (m.task_id != null && m.status === 'pending') {
      const run = db.prepare('SELECT status,error FROM news_agent_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(m.task_id);
      if (run && ['failed', 'cancelled', 'interrupted'].includes(String(run.status))) {
        db.prepare("UPDATE news_tasks SET status='cancelled',updated_at=? WHERE id=? AND status='pending'").run(nowIso(), m.task_id);
        m.status = 'cancelled'; m.note = String(run.error ?? '本阶段执行未完成，已保留结果');
      }
    }
    const open = b.modules.find(m => m.task_id != null && ['pending', 'claimed'].includes(m.status));
    if (open) { b.next_task_id = open.task_id; saveBatch(b); return b; }
    const c = getConfig(), waiting = b.modules.find(m => m.status === 'waiting');
    if (waiting) makeTask(b, c, waiting, waiting.phase);
    else { const rest = b.modules.find(m => m.phase === 1 && m.accepted_count < m.target && m.status !== 'skipped'); if (rest) makeTask(b, c, rest, 2); else { b.status = 'completed'; b.finished_at = nowIso(); } }
    b.next_task_id = b.modules.find(m => ['pending', 'claimed'].includes(m.status))?.task_id ?? null; saveBatch(b); return b;
  });
  const startUpdate = (input: { trigger?: 'manual' | 'scheduled'; slot_key?: string } = {}): NewsFeedBatch => inTx(db, () => {
    const active = listBatches({ limit: 100 }).find(b => b.status === 'active'); if (active) return advance(active.id)!;
    if (input.trigger === 'scheduled' && input.slot_key && state().last_slot_key === input.slot_key) return listBatches({ limit: 1 })[0];
    const c = getConfig(), now = nowIso();
    const modules: NewsFeedBatchModule[] = c.modules.filter(m => m.enabled).map(m => ({ module_id: m.id, name: m.name, phase: 1, target: m.max_items, accepted_count: 0, task_id: null, status: m.kind === 'events' && !liveEvents().length ? 'skipped' : 'waiting', note: m.kind === 'events' && !liveEvents().length ? '当前没有有效时事关注' : null }));
    const interests = getInterests(), hasInterests = interests.topics.some(t => t.state === 'followed' || t.state === 'inferred');
    const onlyReduced = hasInterests && interests.topics.filter(t => t.state === 'followed' || t.state === 'inferred').every(t => t.reduced);
    if (interests.exploration_seed || hasInterests) modules.push({ module_id: 'for_you', name: '猜你喜欢', phase: 1, target: hasInterests ? onlyReduced ? 5 : 10 : 2, accepted_count: 0, task_id: null, status: 'waiting', note: null });
    const b: NewsFeedBatch = { id: randomUUID(), status: 'active', trigger: input.trigger ?? 'manual', created_at: now, finished_at: null, config_revision: c.revision, config_snapshot: c, learning_epoch: epoch(), deadline_at: new Date(Date.now() + c.budget_minutes * 60_000).toISOString(), window_end: now, modules, next_task_id: null };
    saveBatch(b); if (input.trigger === 'scheduled' && input.slot_key) db.prepare('UPDATE news_feed_state SET last_slot_key=? WHERE id=1').run(input.slot_key); return advance(b.id)!;
  });
  const stopUpdate = (id: string): NewsFeedBatch => inTx(db, () => {
    const b = getBatch(id); if (b.status === 'active') { b.status = 'stopped'; b.finished_at = nowIso(); b.next_task_id = null; saveBatch(b); for (const r of db.prepare('SELECT task_id FROM news_feed_tasks WHERE batch_id=?').all(id)) db.prepare("UPDATE news_tasks SET status='cancelled',claim_token=NULL,claim_expires_at=NULL,updated_at=? WHERE id=? AND status IN ('pending','claimed')").run(nowIso(), r.task_id); } return hydrate(b);
  });
  const continueUpdate = (input: { batch_id: string }): NewsFeedBatch => inTx(db, () => {
    const b = hydrate(getBatch(input.batch_id));
    if (!['stopped', 'budget_exhausted'].includes(b.status)) throw new Error('只有已停止或预算用尽的批次可以继续');
    if (b.learning_epoch !== epoch()) throw new Error('兴趣已变化，请创建新一轮更新');
    if (listBatches({ limit: 100 }).some(x => x.status === 'active')) throw new Error('已有其他批次正在更新');
    b.status = 'active'; b.finished_at = null; b.deadline_at = new Date(Date.now() + getConfig().budget_minutes * 60_000).toISOString();
    for (const m of b.modules) {
      const current = getConfig().modules.find(v => v.id === m.module_id);
      if (m.module_id !== 'for_you' && !current?.enabled) { m.task_id = null; m.status = 'skipped'; continue; }
      if (current) { m.name = current.name; m.target = Math.min(m.target, current.max_items); }
      if (m.task_id != null && ['pending', 'claimed', 'cancelled'].includes(m.status)) {
      db.prepare("UPDATE news_tasks SET status='cancelled',claim_token=NULL,claim_expires_at=NULL,updated_at=? WHERE id=? AND status IN ('pending','claimed')").run(nowIso(), m.task_id);
      if (m.accepted_count < m.target) { m.task_id = null; m.status = 'waiting'; }
      }
    }
    saveBatch(b); return advance(b.id)!;
  });

  const validateMetadata = (raw: NewsSubmissionItem): NewsArticleMetadata => {
    const result: NewsArticleMetadata = {};
    for (const field of ['background', 'impact', 'uncertainty', 'image_caption'] as const) if (raw[field] != null) result[field] = text(raw[field], field === 'image_caption' ? 500 : 2000);
    for (const field of ['module_id', 'event_id'] as const) if (raw[field] != null) { if (!/^[a-z0-9_-]{1,80}$/.test(raw[field]!)) throw new Error('新闻模块或事件身份无效'); result[field] = raw[field]; }
    if (raw.topic_keys != null) {
      if (!Array.isArray(raw.topic_keys) || raw.topic_keys.length > 12 || raw.topic_keys.some(k => typeof k !== 'string' || !k.trim() || k.length > 80)) throw new Error('新闻主题须为最多 12 个有效标签');
      result.topic_keys = [...new Set(raw.topic_keys.map(keyOf))];
    }
    const imageValues = [raw.image_url, raw.image_source_url, raw.image_caption];
    if (imageValues.some(Boolean)) {
      if (!imageValues.every(v => typeof v === 'string' && v.trim())) throw new Error('图片须同时包含原图地址、来源页面和图注');
      result.image_url = validateSourceUrl(raw.image_url!); result.image_source_url = validateSourceUrl(raw.image_source_url!);
      if (!result.image_url.startsWith('https://')) throw new Error('新闻图片只允许 HTTPS 原图');
    }
    return result;
  };
  const validateCandidate = (raw: NewsCandidateTopic, ctx: NewsTaskContext | null): NewsCandidateTopic => {
    if (!ctx || ctx.module_id !== 'for_you' || !getConfig().learning.enabled || !getConfig().learning.exploration_enabled) throw new Error('候选主题仅能由开启探索的猜你喜欢任务提交');
    if (!raw || typeof raw !== 'object') throw new Error('候选主题无效');
    const candidate: NewsCandidateTopic = { key: keyOf(text(raw.key, 80)), name: text(raw.name, 80), scope: text(raw.scope, 600), reason: text(raw.reason, 600), basis_news_ids: raw.basis_news_ids, ...(raw.basis_module_id ? { basis_module_id: text(raw.basis_module_id, 60) } : {}) };
    if (!candidate.key || !candidate.name || !candidate.scope || !candidate.reason || !Array.isArray(candidate.basis_news_ids) || candidate.basis_news_ids.length > 12 || candidate.basis_news_ids.some(n => !Number.isInteger(n) || n <= 0)) throw new Error('候选主题须有具体名称、范围、推荐理由和真实证据身份');
    candidate.basis_news_ids = [...new Set(candidate.basis_news_ids)].sort((a, b) => a - b);
    const combined = keyOf(candidate.key + candidate.name + candidate.scope);
    if (events().filter(e => e.status !== 'active').some(e => combined.includes(keyOf(e.name)) || combined.includes(keyOf(e.id)))) throw new Error('已暂停或结束的时事不能改名进入探索');
    const current = getInterests();
    if (current.topics.some(t => (t.key === candidate.key || keyOf(t.name) === keyOf(candidate.name)) && (t.reduced || t.state === 'reduced' || (t.candidate_cooldown_until && t.candidate_cooldown_until > nowIso()) || (t.state === 'removed' && (!t.cooldown_until || t.cooldown_until > nowIso()))))) throw new Error('候选主题已被降频或处于移除冷却期');
    const existing = db.prepare('SELECT data_json FROM news_feed_candidates WHERE batch_id=?').get(ctx.batch_id);
    if (existing && JSON.stringify(json(existing.data_json)) !== JSON.stringify(candidate)) throw new Error('同一批次只能探索一个稳定候选方向');
    if (!existing && (ctx.interests.some(t => t.key === candidate.key || keyOf(t.name) === keyOf(candidate.name)) || getConfig().modules.some(m => keyOf(m.name) === keyOf(candidate.name) || keyOf(m.name + '新进展') === keyOf(candidate.name)))) throw new Error('候选须为尚未关注的具体细分方向，不能重复已有模块或主题');
    if (candidate.basis_news_ids.length) {
      for (const id of candidate.basis_news_ids) {
        if (!(ctx.interest_evidence ?? []).some(e => e.news_id === id)) throw new Error('候选引用了任务上下文之外的兴趣证据');
        if (!db.prepare("SELECT id FROM news_feed_feedback WHERE news_id=? AND epoch=? AND kind IN ('open','read','source_open','star','interested')").get(id, epoch())) throw new Error('候选的阅读或收藏依据已撤回');
      }
    } else if (!candidate.basis_module_id || candidate.basis_module_id !== ctx.exploration_seed?.basis_module_id || !getConfig().modules.some(m => m.id === candidate.basis_module_id && m.enabled && m.kind === 'topic')) throw new Error('冷启动候选须明确引用有效的主题模块配置');
    return candidate;
  };
  const beforeSubmit = (taskId: number, items: NewsSubmissionItem[]) => {
    const ctx = assertContext(taskId);
    let candidate: NewsCandidateTopic | null = null;
    for (const item of items) {
      validateMetadata(item);
      if (item.candidate_topic) {
        const normalized = validateCandidate(item.candidate_topic, ctx);
        if (candidate && JSON.stringify(candidate) !== JSON.stringify(normalized)) throw new Error('同一批次只能探索一个稳定候选方向');
        candidate = normalized;
      }
      if (!ctx) {
        if (item.module_id || item.event_id) throw new Error('旧任务不能声明模块或事件归属，请使用模块采集任务');
        continue;
      }
      if (item.brief) throw new Error('模块新闻须独立提交，不能使用旧版 brief');
      if (ctx.module_id === 'for_you' && !item.candidate_topic) {
        const keys = (item.topic_keys ?? []).map(keyOf), current = getInterests();
        if (!ctx.interests.some(t => keys.includes(t.key) && current.topics.some(v => v.key === t.key && (v.state === 'followed' || v.state === 'inferred')))) throw new Error('猜你喜欢须附候选主题或匹配本轮已有兴趣，不能无依据推荐');
      }
      if (item.module_id && item.module_id !== ctx.module_id) throw new Error('新闻模块与任务归属不一致');
      if (Object.keys(ctx.event_revisions).length && (!item.event_id || !(item.event_id in ctx.event_revisions))) throw new Error('时事新闻须绑定本任务有效 event_id');
      if (item.event_id && !(item.event_id in ctx.event_revisions)) {
        const module = (ctx as StoredTaskContext).module_snapshot ?? getConfig().modules.find(m => m.id === ctx.module_id), known = events().find(e => e.id === item.event_id);
        if (!known || module?.kind !== 'public') throw new Error('该任务不能恢复已撤回的事件关注');
        // 公共重大报道可以保留事件关系，关系本身不改变暂停/结束状态，也不进入兴趣画像。
      }
      const ts = Date.parse(item.published_at); if (ts < Date.parse(ctx.window_start) || ts > Date.parse(ctx.window_end)) throw new Error('新闻发布时间超出本批次固定时间窗');
    }
    if (ctx && items.length > ctx.remaining) throw new Error('超出本批次模块剩余额度，接续不会返还预算');
    if (ctx && items.some(i => i.candidate_topic)) {
      const accepted = Number(db.prepare('SELECT COUNT(*) AS n FROM news_feed_members WHERE batch_id=? AND candidate_key IS NOT NULL').get(ctx.batch_id)!.n);
      if (accepted + items.filter(i => i.candidate_topic).length > 2) throw new Error('同一批次候选试读最多 2 则，跨阶段与接续累计');
    }
    return ctx ? { window_end: ctx.window_end } : null;
  };
  const afterSubmit = (taskId: number, raw: NewsSubmissionItem[], inserted: NewsItem[]) => {
    const ctx = assertContext(taskId);
    for (const [index, item] of inserted.entries()) {
      const meta = validateMetadata(raw[index]);
      if (raw[index].candidate_topic && ctx) {
        const candidate = validateCandidate(raw[index].candidate_topic!, ctx);
        db.prepare('INSERT OR IGNORE INTO news_feed_candidates(batch_id,epoch,data_json,created_at) VALUES(?,?,?,?)').run(ctx.batch_id, epoch(), JSON.stringify(candidate), nowIso());
        meta.topic_keys = [...new Set([candidate.key, ...(meta.topic_keys ?? [])])].slice(0, 12);
      }
      db.prepare('UPDATE news SET module_id=?,event_id=?,topic_keys_json=?,image_url=?,image_source_url=?,image_caption=?,background=?,impact=?,uncertainty=? WHERE id=?')
        .run(ctx?.module_id ?? null, meta.event_id ?? null, JSON.stringify(meta.topic_keys ?? []), meta.image_url ?? null, meta.image_source_url ?? null, meta.image_caption ?? null, meta.background ?? null, meta.impact ?? null, meta.uncertainty ?? null, item.id);
      if (ctx) db.prepare('INSERT INTO news_feed_members(batch_id,module_id,news_id,phase,candidate_key) VALUES(?,?,?,?,?)').run(ctx.batch_id, ctx.module_id, item.id, Number(contextRow(taskId)!.phase), raw[index].candidate_topic ? keyOf(raw[index].candidate_topic!.key) : null);
      Object.assign(item, mapNews(db.prepare('SELECT * FROM news WHERE id=?').get(item.id)!));
    }
  };
  const beforeComplete = (taskId: number): void => {
    const ctx = assertContext(taskId), row = contextRow(taskId); if (!ctx || !row || Number(row.phase) !== 2) return;
    // 补充阶段已完成新进展检索，再以仍合格的旧新闻补精选；不会抢先占掉新消息位置。
    const b = hydrate(getBatch(ctx.batch_id!)), m = b.modules.find(m => m.module_id === ctx.module_id)!;
    let remaining = m.target - m.accepted_count; if (remaining <= 0) return;
    const candidates = db.prepare(`SELECT n.* FROM news n WHERE n.module_id=? AND n.published_at>=? AND n.published_at<=?
      AND NOT EXISTS(SELECT 1 FROM news_feed_members f WHERE f.batch_id=? AND f.news_id=n.id)
      AND NOT EXISTS(SELECT 1 FROM news_feed_feedback f WHERE f.news_id=n.id AND f.kind='hide') ORDER BY n.published_at DESC,n.id DESC`).all(ctx.module_id, ctx.window_start, ctx.window_end, b.id);
    for (const n of candidates) {
      if (remaining <= 0) break;
      if (n.event_id && !Object.keys(ctx.event_revisions).includes(String(n.event_id))) continue;
      if (ctx.module_id === 'for_you' && !ctx.interests.some(t => (mapNews(n).topic_keys ?? []).includes(t.key) && getInterests().topics.some(v => v.key === t.key && ['followed', 'inferred'].includes(v.state)))) continue;
      db.prepare('INSERT INTO news_feed_members(batch_id,module_id,news_id) VALUES(?,?,?)').run(b.id, ctx.module_id, n.id); remaining--;
    }
  };
  const updateEvent = (input: NewsEventInput): NewsEventFollow => inTx(db, () => {
    if (!/^[a-z0-9_-]{1,80}$/.test(input.id)) throw new Error('事件身份无效');
    const oldRow = db.prepare('SELECT data_json FROM news_feed_events WHERE id=?').get(input.id), old = oldRow ? json<NewsEventFollow>(oldRow.data_json) : null;
    if ((old?.revision ?? 0) !== input.expected_revision) throw new Error('事件关注已被更新，请重新加载');
    if (input.status && !['active', 'paused', 'ended'].includes(input.status)) throw new Error('事件状态无效');
    if (input.expires_at != null && !Number.isFinite(Date.parse(input.expires_at))) throw new Error('事件期限无效');
    const e: NewsEventFollow = { id: input.id, name: text(input.name ?? old?.name ?? '', 80), scope: text(input.scope ?? old?.scope ?? '', 1000), status: input.status ?? old?.status ?? 'active', expires_at: input.expires_at === undefined ? old?.expires_at ?? null : input.expires_at, revision: (old?.revision ?? 0) + 1, updated_at: nowIso(), last_viewed_at: old?.last_viewed_at ?? null, reminder_due: false };
    if (!e.name || !e.scope) throw new Error('事件名称与关注范围不能为空');
    db.prepare('INSERT INTO news_feed_events(id,data_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json').run(e.id, JSON.stringify(e));
    // 更换授权版本后，即使恢复原状态也不能重用旧执行令牌。
    for (const r of db.prepare('SELECT * FROM news_feed_tasks').all()) {
      const c = json<NewsTaskContext>(r.context_json); if (!(input.id in c.event_revisions)) continue;
      db.prepare("UPDATE news_tasks SET status='cancelled',claim_token=NULL,claim_expires_at=NULL,last_error='事件关注已变化',updated_at=? WHERE id=? AND status IN ('pending','claimed')").run(nowIso(), r.task_id);
    }
    return e;
  });
  const dismissEventReminder = (id: string): NewsEventFollow => {
    const row = db.prepare('SELECT data_json FROM news_feed_events WHERE id=?').get(id); if (!row) throw new Error('事件不存在');
    const e = json<NewsEventFollow>(row.data_json); e.last_viewed_at = nowIso(); e.reminder_due = false;
    db.prepare('UPDATE news_feed_events SET data_json=? WHERE id=?').run(JSON.stringify(e), id); return e;
  };
  const manageTopic = (input: NewsTopicInput): NewsInterestState => inTx(db, () => {
    const key = keyOf(input.key); if (!key) throw new Error('主题身份不能为空');
    const name = text(input.name ?? input.key, 80); if (!name) throw new Error('主题名称不能为空');
    if (!['follow', 'unfollow', 'reduce', 'remove', 'restore'].includes(input.action)) throw new Error('主题操作无效');
    const previous = db.prepare('SELECT * FROM news_feed_topics WHERE key=?').get(key);
    if (input.action === 'unfollow') {
      if (previous?.state === 'followed') {
        const reduced = db.prepare("SELECT 1 FROM news_feed_topics WHERE key=? AND state='topic_reduced'").get(`reduction:${key}`);
        const removed = db.prepare("SELECT cooldown_until FROM news_feed_topics WHERE key=? AND state='candidate_removed'").get(`candidate:${key}`);
        if (reduced) db.prepare("UPDATE news_feed_topics SET state='reduced',cooldown_until=NULL,updated_at=? WHERE key=?").run(nowIso(), key);
        else if (removed?.cooldown_until && String(removed.cooldown_until) > nowIso()) db.prepare("UPDATE news_feed_topics SET state='removed',cooldown_until=?,updated_at=? WHERE key=?").run(removed.cooldown_until, nowIso(), key);
        else db.prepare('DELETE FROM news_feed_topics WHERE key=?').run(key);
      }
    } else if (input.action === 'restore') {
      db.prepare("DELETE FROM news_feed_topics WHERE key IN (?,?)").run(`candidate:${key}`, `reduction:${key}`);
      if (previous?.state !== 'followed') db.prepare('DELETE FROM news_feed_topics WHERE key=?').run(key);
      db.prepare("DELETE FROM news_feed_feedback WHERE topic_key=? AND kind='less_topic'").run(key);
    } else {
      const candidate = db.prepare('SELECT data_json FROM news_feed_candidates ORDER BY rowid DESC').all().map(r => json<NewsCandidateTopic>(r.data_json)).find(c => c.key === key);
      const cooldown = input.action === 'remove' ? new Date(Date.now() + 30 * 24 * HOUR).toISOString() : null;
      if (input.action === 'remove' || input.action === 'reduce') db.prepare('INSERT INTO news_feed_topics(key,name,state,cooldown_until,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET state=excluded.state,cooldown_until=excluded.cooldown_until,updated_at=excluded.updated_at')
        .run(input.action === 'remove' ? `candidate:${key}` : `reduction:${key}`, name, input.action === 'remove' ? 'candidate_removed' : 'topic_reduced', cooldown, nowIso());
      // 候选冷却、推荐频率与明确订阅是三个独立维度，前两者不能偷偷取消订阅。
      if (previous?.state === 'followed' && input.action !== 'follow') return getInterests();
      db.prepare('INSERT INTO news_feed_topics(key,name,state,scope,cooldown_until,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET name=excluded.name,state=excluded.state,scope=COALESCE(excluded.scope,news_feed_topics.scope),cooldown_until=excluded.cooldown_until,updated_at=excluded.updated_at')
        .run(key, name, input.action === 'follow' ? 'followed' : input.action === 'reduce' ? 'reduced' : 'removed', candidate?.scope ?? previous?.scope ?? null, cooldown, nowIso());
    }
    return getInterests();
  });
  const manageSource = (input: NewsSourceInput): NewsInterestState => inTx(db, () => {
    const name = text(input.source_name, 120); if (!name || !['reduce', 'restore'].includes(input.action)) throw new Error('来源操作无效');
    const key = `source:${name}`;
    if (input.action === 'restore') db.prepare('DELETE FROM news_feed_topics WHERE key=?').run(key);
    else db.prepare("INSERT INTO news_feed_topics(key,name,state,cooldown_until,updated_at) VALUES(?,?,'source_reduced',NULL,?) ON CONFLICT(key) DO UPDATE SET state='source_reduced',updated_at=excluded.updated_at").run(key, name, nowIso());
    if (input.action === 'restore') db.prepare("DELETE FROM news_feed_feedback WHERE kind='less_source' AND news_id IN (SELECT id FROM news WHERE source_name=?)").run(name);
    return getInterests();
  });
  const recordFeedback = (input: NewsFeedbackInput): { recorded: boolean; interests: NewsInterestState } => inTx(db, () => {
    const id = text(input.idempotency_key, 160); if (!id) throw new Error('反馈幂等标识不能为空');
    if (!['open', 'read', 'source_open', 'star', 'unstar', 'interested', 'less_topic', 'less_source', 'hide', 'undo_hide'].includes(input.kind)) throw new Error('反馈类型无效');
    if (!['app', 'explicit'].includes(input.source)) throw new Error('反馈来源无效');
    if (input.source === 'explicit' && ['open', 'read', 'source_open'].includes(input.kind)) throw new Error('助手查询不能冒充用户阅读行为');
    const row = db.prepare('SELECT * FROM news WHERE id=?').get(input.news_id); if (!row) throw new Error('新闻不存在');
    const receipt = createHash('sha256').update(id).digest('hex');
    if (db.prepare('SELECT key_hash FROM news_feed_feedback_receipts WHERE key_hash=?').get(receipt)) return { recorded: false, interests: getInterests() };
    if (input.kind === 'read' && (!Number.isFinite(input.reading_seconds) || input.reading_seconds! < 20)) throw new Error('有效阅读需要前台可见至少 20 秒');
    if (row.event_id && input.source === 'app' && ['open', 'read', 'source_open'].includes(input.kind)) dismissEventReminder(String(row.event_id));
    const personalAction = ['hide', 'undo_hide', 'star', 'unstar'].includes(input.kind);
    if (!getConfig().learning.enabled && !personalAction) return { recorded: false, interests: getInterests() };
    const key = input.topic_key ? keyOf(input.topic_key) : null;
    if (input.kind === 'less_topic' && (!key || !(mapNews(row).topic_keys ?? []).includes(key))) throw new Error('减少推荐须选择该新闻已有的主题');
    db.prepare('INSERT INTO news_feed_feedback_receipts(key_hash) VALUES(?)').run(receipt);
    if (input.kind === 'star' || input.kind === 'unstar') news.markStarred(input.news_id, input.kind === 'star');
    if (input.kind === 'unstar') db.prepare("DELETE FROM news_feed_feedback WHERE news_id=? AND kind='star'").run(input.news_id);
    if (!getConfig().learning.enabled && ['star', 'unstar'].includes(input.kind)) return { recorded: true, interests: getInterests() };
    if (input.kind === 'undo_hide') db.prepare("DELETE FROM news_feed_feedback WHERE news_id=? AND kind='hide'").run(input.news_id);
    // 同一新闻同一类信号终身封顶，不允许换幂等标识反复放大权重。
    if (db.prepare('SELECT id FROM news_feed_feedback WHERE news_id=? AND kind=? AND epoch=?').get(input.news_id, input.kind, epoch())) return { recorded: false, interests: getInterests() };
    db.prepare('INSERT INTO news_feed_feedback(id,news_id,kind,source,topic_key,created_at,epoch) VALUES(?,?,?,?,?,?,?)').run(id, input.news_id, input.kind, input.source, key, nowIso(), epoch());
    if (input.kind === 'less_topic') manageTopic({ key: key!, action: 'reduce' });
    if (input.kind === 'less_source' && row.source_name) manageSource({ source_name: String(row.source_name), action: 'reduce' });
    if (row.event_id && ['open', 'read', 'source_open', 'star', 'interested'].includes(input.kind)) dismissEventReminder(String(row.event_id));
    db.prepare('DELETE FROM news_feed_feedback WHERE created_at<? AND kind NOT IN (?,?)').run(new Date(Date.now() - 90 * 24 * HOUR).toISOString(), 'hide', 'undo_hide');
    return { recorded: true, interests: getInterests() };
  });
  const resetLearning = (): NewsInterestState => inTx(db, () => {
    invalidate('兴趣学习已清空，旧执行上下文失效');
    db.prepare("DELETE FROM news_feed_feedback WHERE kind NOT IN ('hide','undo_hide')").run();
    db.prepare('UPDATE news_feed_state SET learning_epoch=learning_epoch+1 WHERE id=1').run();
    db.prepare('DELETE FROM news_feed_candidates').run();
    // 历史任务只保留不含画像的审计身份，清除编译文本，避免清空后回流。
    for (const r of db.prepare('SELECT task_id,context_json FROM news_feed_tasks').all()) {
      const c = json<NewsTaskContext>(r.context_json); c.interests = []; c.interest_evidence = []; c.candidate_topic = null; c.exploration_seed = null; c.instructions = '兴趣学习结果已清空；请创建新任务读取当前配置。'; c.task.instructions = c.instructions;
      db.prepare('UPDATE news_feed_tasks SET context_json=? WHERE task_id=?').run(JSON.stringify(c), r.task_id);
      db.prepare('UPDATE news_tasks SET instructions=? WHERE id=?').run(c.instructions, r.task_id);
    }
    return getInterests();
  });
  const importStarred = (input: { news_ids?: number[] } = {}): { imported: number; interests: NewsInterestState } => inTx(db, () => {
    if (!getConfig().learning.enabled) throw new Error('请先启用兴趣学习');
    const ids = input.news_ids ?? news.list({ filter: 'starred', limit: 10000 }).map(n => n.id);
    if (!Array.isArray(ids) || ids.length > 10000 || ids.some(id => !Number.isInteger(id) || id <= 0)) throw new Error('收藏新闻身份无效');
    let imported = 0; for (const id of new Set(ids)) {
      const n = db.prepare('SELECT * FROM news WHERE id=? AND is_starred=1').get(id); if (!n || n.event_id) continue;
      if (recordFeedback({ news_id: id, kind: 'star', source: 'explicit', idempotency_key: `import:${epoch()}:${id}` }).recorded) imported++;
    }
    return { imported, interests: getInterests() };
  });
  const correctionRows = (id: number): NewsCorrection[] => db.prepare('SELECT * FROM news_feed_corrections WHERE news_id=? ORDER BY created_at DESC').all(id).map(r => ({ id: String(r.id), news_id: Number(r.news_id), summary: String(r.summary), evidence_url: String(r.evidence_url), created_at: String(r.created_at), acknowledged: !!r.acknowledged }));
  const submitCorrection = (input: NewsCorrectionInput): NewsCorrection => inTx(db, () => {
    if (!db.prepare('SELECT id FROM news WHERE id=?').get(input.news_id)) throw new Error('新闻不存在');
    const summary = text(input.summary, 2000), evidence = validateSourceUrl(input.evidence_url); if (!summary) throw new Error('更正说明不能为空');
    const existing = correctionRows(input.news_id).find(c => c.summary === summary && c.evidence_url === evidence); if (existing) return existing;
    const c: NewsCorrection = { id: randomUUID(), news_id: input.news_id, summary, evidence_url: evidence, created_at: nowIso(), acknowledged: false };
    db.prepare('INSERT INTO news_feed_corrections(id,news_id,summary,evidence_url,created_at) VALUES(?,?,?,?,?)').run(c.id, c.news_id, c.summary, c.evidence_url, c.created_at); return c;
  });
  const dismissCorrection = (id: string): NewsCorrection => {
    const row = db.prepare('SELECT news_id FROM news_feed_corrections WHERE id=?').get(id); if (!row) throw new Error('新闻更正不存在');
    db.prepare('UPDATE news_feed_corrections SET acknowledged=1 WHERE id=?').run(id); return correctionRows(Number(row.news_id)).find(c => c.id === id)!;
  };
  const list = (opts: { module_id?: string; filter?: 'all' | 'unread' | 'starred' | 'hidden'; history?: boolean; search?: string; corrections_only?: boolean; limit?: number; offset?: number } = {}): NewsFeedItem[] => {
    const where: string[] = [], params: unknown[] = [], config = getConfig();
    if (opts.module_id && opts.module_id !== 'for_you') { where.push('n.module_id=?'); params.push(opts.module_id); }
    if (opts.filter === 'unread') where.push('n.is_read=0');
    if (opts.filter === 'starred') where.push('n.is_starred=1');
    if (opts.corrections_only) where.push('n.is_read=1 AND EXISTS(SELECT 1 FROM news_feed_corrections c WHERE c.news_id=n.id AND c.acknowledged=0)');
    if (opts.search?.trim()) { where.push('(n.title LIKE ? OR n.summary LIKE ? OR n.background LIKE ? OR n.impact LIKE ?)'); const q = `%${opts.search.trim()}%`; params.push(q, q, q, q); }
    const hidden = "EXISTS(SELECT 1 FROM news_feed_feedback f WHERE f.news_id=n.id AND f.kind='hide')";
    where.push(opts.filter === 'hidden' ? hidden : `NOT ${hidden}`);
    if (!opts.history && opts.filter !== 'starred') { const hours = config.modules.find(m => m.id === opts.module_id)?.window_hours ?? 24; where.push("julianday(COALESCE(n.published_at,n.published_date || 'T23:59:59+08:00'))>=julianday(?)"); params.push(new Date(Date.now() - hours * HOUR).toISOString()); }
    let rows = db.prepare(`SELECT n.* FROM news n WHERE ${where.length ? where.join(' AND ') : '1=1'} ORDER BY COALESCE(n.published_at,n.published_date) DESC,n.id DESC`).all(...params);
    const selected = new Map<number, number>();
    if (!opts.history && opts.module_id && opts.module_id !== 'for_you' && !opts.corrections_only && opts.filter !== 'starred') {
      const latest = db.prepare('SELECT m.batch_id FROM news_feed_members m JOIN news_feed_batches b ON b.id=m.batch_id WHERE m.module_id=? ORDER BY b.rowid DESC LIMIT 1').get(opts.module_id);
      if (latest) for (const r of db.prepare('SELECT news_id,phase FROM news_feed_members WHERE batch_id=? AND module_id=?').all(latest.batch_id, opts.module_id)) selected.set(Number(r.news_id), Number(r.phase));
      // 只给本模块最新有结果的一轮应用首轮优先，旧批次重点不会永久占据头部。
      rows.sort((a, b) => (selected.has(Number(a.id)) ? selected.get(Number(a.id))! : 3) - (selected.has(Number(b.id)) ? selected.get(Number(b.id))! : 3));
    }
    if (opts.module_id === 'for_you') {
      const interests = getInterests(), preferred = interests.topics.filter(t => t.state === 'followed' || (interests.enabled && t.state === 'inferred')).map(t => t.key), reduced = interests.topics.filter(t => t.state === 'reduced' || (t.state === 'removed' && (!t.cooldown_until || t.cooldown_until > nowIso()))).map(t => t.key);
      rows = rows.filter(r => { const n = mapNews(r); if (n.event_id && !liveEvents().some(e => e.id === n.event_id)) return false; const ctxRow = n.task_id ? contextRow(n.task_id) : null; const currentExploration = interests.enabled && n.module_id === 'for_you' && ctxRow && json<NewsTaskContext>(ctxRow.context_json).learning_epoch === epoch(); return !(n.topic_keys ?? []).some(k => reduced.includes(k)) && !interests.reduced_sources.includes(n.source_name ?? '') && (currentExploration || (n.topic_keys ?? []).some(k => preferred.includes(k))); });
      const rank = (n: NewsItem) => (n.topic_keys ?? []).reduce((sum, key) => sum + (preferred.includes(key) ? interests.topics.find(t => t.key === key)?.reduced ? 1 : 5 : 0), 0);
      rows.sort((a, b) => rank(mapNews(b)) - rank(mapNews(a)));
    }
    const limit = Math.max(1, Math.min(opts.limit ?? (opts.history ? 100 : 10), 1000)), offset = Math.max(0, opts.offset ?? 0);
    return rows.slice(offset, offset + limit).map(r => ({ ...mapNews(r), hidden: opts.filter === 'hidden', corrections: correctionRows(Number(r.id)), ...(selected.has(Number(r.id)) ? { selection_kind: selected.get(Number(r.id)) === 1 ? 'headline' as const : 'supplement' as const } : {}) }));
  };
  return { getConfig, updateConfig, preview, startUpdate, advance, stopUpdate, continueUpdate, listBatches, getTaskContext, list, recordFeedback, getInterests, manageTopic, manageSource, resetLearning, updateEvent, dismissEventReminder, importStarred, submitCorrection, dismissCorrection, beforeSubmit, afterSubmit, beforeComplete, assertContext };
}
export type NewsFeedService = ReturnType<typeof createNewsFeedService>;
