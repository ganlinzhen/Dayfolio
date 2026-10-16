// 新闻服务（agent-only）单测：任务生命周期 / 认领租约 / 提交硬校验 / 去重 / 跨批次预算 /
// 24h 窗口与历史 / 收藏保护 / 重启边界。
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openNodeSqliteDb } from '../src/adapters/node-sqlite';
import { beijingDateOf, createCore, newsDedupKey, newsRootForDb, NEWS_HTML_MAX_CHARS, todayStr } from '../src/index';
import type { NewsSubmissionItem } from '../src/types';
import { mkCore, mkLegacyDb } from './helpers';
import { MIGRATIONS } from '../src/migrations';

const H = 3600_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

/** 构造一条合法提交（默认 1 小时前发布） */
const item = (over: Partial<NewsSubmissionItem> = {}): NewsSubmissionItem => ({
  title: '某公司发布新一代开源模型',
  summary: '正文摘要：性能提升与许可证变化。',
  source_url: 'https://example.com/story/1',
  source_name: 'Example News',
  published_at: iso(-1 * H),
  ...over,
});

const insertLegacy = (dbPath: string, id: number, title: string, url: string, date: string, starred = false) => {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(
      "INSERT INTO news (id, source, title, url, summary, published_date, fetched_at, dedup_key, is_starred) VALUES (?, 'zhihu_daily', ?, ?, '旧摘要', ?, '2026-10-01T08:00:00.000', ?, ?)",
    ).run(id, title, url, date, `legacy:${id}`, starred ? 1 : 0);
  } finally {
    db.close();
  }
};

describe('新闻任务：生命周期与参数校验', () => {
  it('创建 → 认领 → 提交 → 完成 全链路', () => {
    const { core, cleanup } = mkCore();
    try {
      const task = core.news.createTask({ title: 'AI 领域最近 24 小时重要新闻', instructions: '偏基础设施', window_hours: 24 });
      expect(task.status).toBe('pending');
      expect(task.max_items).toBe(10);
      expect(task.remaining).toBe(10);

      const claim = core.news.claimTask(task.id, 'zcode');
      expect(claim.task.status).toBe('claimed');
      expect(claim.task.attempts).toBe(1);
      expect(claim.task.claimed_by).toBe('zcode');
      expect(claim.claim_token).toBeTruthy();
      expect(claim.lease_minutes).toBeGreaterThanOrEqual(1);

      const res = core.news.submitItems(task.id, claim.claim_token, [item(), item({ title: '另一条独立新闻', source_url: 'https://example.com/story/2' })]);
      expect(res.inserted).toBe(2);
      expect(res.items[0].source).toBe('agent');
      expect(res.items[0].task_id).toBe(task.id);
      expect(res.items[0].source_name).toBe('Example News');
      expect(res.task.inserted_count).toBe(2);
      expect(res.task.remaining).toBe(8);

      const done = core.news.completeTask(task.id, claim.claim_token, '收录 2 条');
      expect(done.status).toBe('completed');
      expect(done.completed_note).toBe('收录 2 条');
      // 完成后不能再提交
      expect(() => core.news.submitItems(task.id, claim.claim_token, [item({ source_url: 'https://example.com/x' })])).toThrow('非执行中');
    } finally {
      cleanup();
    }
  });

  it('创建参数硬校验', () => {
    const { core, cleanup } = mkCore();
    try {
      expect(() => core.news.createTask({ title: '  ' })).toThrow('标题不能为空');
      expect(() => core.news.createTask({ title: 'x'.repeat(201) })).toThrow('过长');
      expect(() => core.news.createTask({ title: 'x', max_items: 11 })).toThrow('1~10');
      expect(() => core.news.createTask({ title: 'x', max_items: 0 })).toThrow('1~10');
      expect(() => core.news.createTask({ title: 'x', window_hours: 0 })).toThrow('时间窗');
      expect(() => core.news.createTask({ title: 'x', window_hours: 721 })).toThrow('时间窗');
      expect(core.news.createTask({ title: '窄预算', max_items: 3 }).max_items).toBe(3);
    } finally {
      cleanup();
    }
  });

  it('未终结任务数上限（防无限堆积）', () => {
    const { core, cleanup } = mkCore();
    try {
      for (let i = 0; i < 50; i++) core.news.createTask({ title: `t${i}` });
      expect(() => core.news.createTask({ title: 'overflow' })).toThrow('上限');
      core.news.cancelTask(1); // 取消腾出名额
      expect(core.news.createTask({ title: 'ok' }).status).toBe('pending');
    } finally {
      cleanup();
    }
  });

  it('提交持久化：INSERT 列值逐字段断言（防列错位/参数数目回归）', () => {
    const { core, dbPath, cleanup } = mkCore();
    try {
      const task = core.news.createTask({ title: '持久化任务' });
      const t = core.news.claimTask(task.id).claim_token;
      const publishedAt = new Date(Date.now() - 3600_000).toISOString();
      const url = 'https://example.com/persist-1?utm_source=x'; // 存储保留原样，去重键走规范化（剥跟踪参数）
      const res = core.news.submitItems(task.id, t, [{
        title: '持久化：标题甲', summary: '持久化：摘要甲。',
        source_url: url, source_name: 'Persist News', published_at: publishedAt,
      }]);
      expect(res.inserted).toBe(1);
      const db = new DatabaseSync(dbPath);
      try {
        const row = db.prepare('SELECT * FROM news WHERE id = ?').get(res.items[0].id) as Record<string, unknown>;
        expect(row.source).toBe('agent');
        expect(row.title).toBe('持久化：标题甲');
        expect(row.url).toBe(url);
        expect(row.summary).toBe('持久化：摘要甲。');
        expect(row.published_date).toBe(beijingDateOf(publishedAt));
        expect(row.published_at).toBe(publishedAt);
        expect(String(row.fetched_at ?? '').length).toBeGreaterThanOrEqual(19); // 本地时间戳已写入
        expect(row.dedup_key).toBe(newsDedupKey('generic', url, ''));
        expect(row.task_id).toBe(task.id);
        expect(row.source_name).toBe('Persist News');
        expect(row.is_read).toBe(0);
        expect(row.is_starred).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      cleanup();
    }
  });

  it('缺省认领取最早的待执行任务；任务列表按状态过滤', () => {
    const { core, cleanup } = mkCore();
    try {
      core.news.createTask({ title: '第一个' });
      core.news.createTask({ title: '第二个' });
      const claim = core.news.claimTask(undefined, 'agent-a');
      expect(claim.task.title).toBe('第一个');
      expect(core.news.listTasks({ status: 'pending' }).map((t) => t.title)).toEqual(['第二个']);
    } finally {
      cleanup();
    }
  });
});

describe('认领租约与并发/重启边界', () => {
  it('重复认领被拒；错误令牌提交被拒；过期后可被重新认领接力（attempts 累计）', () => {
    const { core, dbPath, cleanup } = mkCore();
    try {
      const task = core.news.createTask({ title: '接力任务' });
      const a = core.news.claimTask(task.id, 'agent-a');
      expect(() => core.news.claimTask(task.id, 'agent-b')).toThrow('已被「agent-a」认领');
      expect(() => core.news.submitItems(task.id, 'wrong-token', [item()])).toThrow('令牌不匹配');

      // 模拟租约过期（直接改库，等价于执行方失联 30 分钟）
      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE news_tasks SET claim_expires_at = '2000-01-01T00:00:00.000' WHERE id = ?").run(task.id);
      db.close();
      expect(() => core.news.submitItems(task.id, a.claim_token, [item()])).toThrow('认领已过期');

      const b = core.news.claimTask(task.id, 'agent-b');
      expect(b.task.attempts).toBe(2);
      expect(b.task.claimed_by).toBe('agent-b');
      expect(() => core.news.submitItems(task.id, a.claim_token, [item()])).toThrow('令牌不匹配');
      expect(core.news.submitItems(task.id, b.claim_token, [item()]).inserted).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('重启边界：认领与预算状态跨进程重启持久；关库重开后旧 token 仍可继续提交', () => {
    const { core, dbPath, cleanup } = mkCore();
    const taskId = core.news.createTask({ title: '跨重启任务', max_items: 4 }).id;
    const token = core.news.claimTask(taskId, 'session-1').claim_token;
    core.news.submitItems(taskId, token, [item()]);
    core.db.close();

    const db2 = openNodeSqliteDb(dbPath);
    const core2 = createCore(db2, { dbPath });
    try {
      const t = core2.news.getTask(taskId);
      expect(t.status).toBe('claimed');
      expect(t.inserted_count).toBe(1);
      // 同一认领（未过期）在新进程继续提交
      core2.news.submitItems(taskId, token, [item({ title: '重启后提交', source_url: 'https://example.com/after-restart' })]);
      expect(core2.news.getTask(taskId).inserted_count).toBe(2);
    } finally {
      db2.close();
      cleanup();
    }
  });

  it('release 释放回待执行并保留入库计数；释放原因展示；释放后可取消', () => {
    const { core, cleanup } = mkCore();
    try {
      const task = core.news.createTask({ title: '释放任务', max_items: 5 });
      const c = core.news.claimTask(task.id);
      core.news.submitItems(task.id, c.claim_token, [item()]);
      const released = core.news.releaseTask(task.id, c.claim_token, '本会话检索受限');
      expect(released.status).toBe('pending');
      expect(released.inserted_count).toBe(1);
      expect(released.last_error).toBe('本会话检索受限');
      expect(() => core.news.submitItems(task.id, c.claim_token, [item({ source_url: 'https://example.com/z' })])).toThrow('无有效认领');
      // 有效认领存在时不可取消
      const c2 = core.news.claimTask(task.id);
      expect(() => core.news.cancelTask(task.id)).toThrow('不可取消');
      core.news.releaseTask(task.id, c2.claim_token);
      expect(core.news.cancelTask(task.id).status).toBe('cancelled');
      expect(() => core.news.claimTask(task.id)).toThrow('不可认领');
    } finally {
      cleanup();
    }
  });
});

describe('提交硬校验：参数 / 来源 / 时间窗（整批原子）', () => {
  const countNews = (core: ReturnType<typeof createCore>): number =>
    (core.db.prepare('SELECT COUNT(*) AS n FROM news').get() as { n: number }).n;

  const expectBatchRejected = (core: ReturnType<typeof createCore>, taskId: number, token: string, items: NewsSubmissionItem[], msg: RegExp | string) => {
    const before = countNews(core);
    expect(() => core.news.submitItems(taskId, token, items)).toThrow(msg);
    expect(countNews(core)).toBe(before); // 整批拒绝：一条都不入库
  };

  it('非法来源链接 / 时间 / 字段全部拒绝', () => {
    const { core, cleanup } = mkCore();
    try {
      const task = core.news.createTask({ title: '校验任务' });
      const t = core.news.claimTask(task.id).claim_token;
      expectBatchRejected(core, task.id, t, [item({ source_url: 'javascript:alert(1)' })], /来源链接/);
      expectBatchRejected(core, task.id, t, [item({ source_url: 'http://localhost/a' })], /本地\/内网|主机名无效/);
      expectBatchRejected(core, task.id, t, [item({ source_url: 'http://192.168.1.5/a' })], /本地\/内网/);
      expectBatchRejected(core, task.id, t, [item({ source_url: 'http://no-host' })], /主机名无效/);
      expectBatchRejected(core, task.id, t, [item({ source_url: 'https://example.com/a b' })], /空白/);
      expectBatchRejected(core, task.id, t, [item({ published_at: iso(60 * H) })], /未来/);
      expectBatchRejected(core, task.id, t, [item({ published_at: iso(-25 * H) })], /时间窗/); // 默认 24h
      expectBatchRejected(core, task.id, t, [item({ published_at: 'not-a-date' })], /发布时间无效/);
      expectBatchRejected(core, task.id, t, [item({ published_at: '' })], /发布时间无效|缺少发布时间/);
      expectBatchRejected(core, task.id, t, [item({ summary: '' })], /摘要不能为空/);
      expectBatchRejected(core, task.id, t, [item({ title: ' '.repeat(10) })], /标题不能为空/);
      expectBatchRejected(core, task.id, t, [item({ title: 'x'.repeat(301) })], /过长/);
      expectBatchRejected(core, task.id, t, [item({ summary: 'x'.repeat(2001) })], /过长/);
      // 控制字符被清洗为空格（不报错，标题仍有效）
      const ok = core.news.submitItems(task.id, t, [item({ title: '带\x01控制符的标题' })]);
      expect(ok.items[0].title).toBe('带 控制符的标题');
      // 超窗条目与合法条目混批：整批拒绝（合法条目也未入库）
      expectBatchRejected(core, task.id, t, [item({ source_url: 'https://example.com/mix' }), item({ source_url: 'https://example.com/old', published_at: iso(-30 * H) })], /时间窗/);
    } finally {
      cleanup();
    }
  });

  it('时间窗按任务配置生效（window_hours=168 允许 5 天前）', () => {
    const { core, cleanup } = mkCore();
    try {
      const task = core.news.createTask({ title: '周盘点', window_hours: 168 });
      const t = core.news.claimTask(task.id).claim_token;
      expect(core.news.submitItems(task.id, t, [item({ published_at: iso(-5 * 24 * H), source_url: 'https://example.com/week' })]).inserted).toBe(1);
      expect(() => core.news.submitItems(task.id, t, [item({ published_at: iso(-8 * 24 * H), source_url: 'https://example.com/week2' })])).toThrow(/时间窗/);
    } finally {
      cleanup();
    }
  });
});

describe('事件去重：同链接 / 同事件 / 批内 / 与历史行', () => {
  it('同 URL、同规范化标题（跨大小写标点）、批内重复、与 legacy 同事件 均拒绝', () => {
    const { core, dbPath, cleanup } = mkCore();
    try {
      insertLegacy(dbPath, 900, '开源社区 发布 里程碑版本', 'https://old.example.com/milestone', '2026-09-20');
      const task = core.news.createTask({ title: '去重任务' });
      const t = core.news.claimTask(task.id).claim_token;
      core.news.submitItems(task.id, t, [
        item({ title: '某公司发布新一代开源模型', source_url: 'https://example.com/a' }),
        item({ title: '完全不同的新闻', source_url: 'https://example.com/b' }),
      ]);
      // 同 URL 再提交（带跟踪参数 → 规范化后相同）
      expect(() => core.news.submitItems(task.id, t, [item({ source_url: 'https://example.com/a?utm_source=x' })])).toThrow(/已在库中/);
      // 同事件不同 URL：标题归一化后一致（大小写/标点差异）
      expect(() => core.news.submitItems(task.id, t, [item({ title: '某公司发布新一代开源模型！', source_url: 'https://other.example.com/c' })])).toThrow(/同事件/);
      // 与 legacy 行同事件
      expect(() => core.news.submitItems(task.id, t, [item({ title: '开源社区发布里程碑版本', source_url: 'https://new.example.com/m2' })])).toThrow(/同事件/);
      // 批内两条同 URL（跟踪参数/fragment 差异在规范化后相同；语义 query 不同视为不同文章，不误并）
      expect(() => core.news.submitItems(task.id, t, [
        item({ source_url: 'https://example.com/d1', title: '批内一' }),
        item({ source_url: 'https://example.com/d1?utm_source=x#frag', title: '批内二' }),
      ])).toThrow(/重复/);
      // 批内两条同事件不同 URL
      expect(() => core.news.submitItems(task.id, t, [
        item({ source_url: 'https://example.com/e1', title: '独特事件甲' }),
        item({ source_url: 'https://example.com/e2', title: '独特事件，甲' }),
      ])).toThrow(/重复/);
      // 不同事件正常入库
      expect(core.news.submitItems(task.id, t, [item({ source_url: 'https://example.com/f', title: '真正不同的新闻' })]).inserted).toBe(1);
    } finally {
      cleanup();
    }
  });
});

describe('预算：跨批次与重试累计，重复提交不能绕过', () => {
  it('多批提交至 max_items 后整批拒绝；release+reclaim 后仍计入累计', () => {
    const { core, cleanup } = mkCore();
    try {
      const task = core.news.createTask({ title: '预算任务', max_items: 5 });
      const t1 = core.news.claimTask(task.id, 'a').claim_token;
      core.news.submitItems(task.id, t1, [1, 2, 3].map((i) => item({ source_url: `https://example.com/b1-${i}`, title: `新闻 ${i}` })));
      core.news.submitItems(task.id, t1, [4, 5].map((i) => item({ source_url: `https://example.com/b2-${i}`, title: `新闻 ${i}0` })));
      expect(core.news.getTask(task.id).inserted_count).toBe(5);
      expect(core.news.getTask(task.id).remaining).toBe(0);
      // 超预算：整批拒绝
      expect(() => core.news.submitItems(task.id, t1, [item({ source_url: 'https://example.com/over', title: '超额新闻' })])).toThrow(/超出任务预算/);
      // 释放 → 重新认领（重试）→ 预算不重置
      core.news.releaseTask(task.id, t1);
      const t2 = core.news.claimTask(task.id, 'b').claim_token;
      expect(core.news.getTask(task.id).inserted_count).toBe(5);
      expect(() => core.news.submitItems(task.id, t2, [item({ source_url: 'https://example.com/over2', title: '重试超额' })])).toThrow(/超出任务预算/);
      core.news.completeTask(task.id, t2, '预算用满');
      expect(core.news.getTask(task.id).status).toBe('completed');
    } finally {
      cleanup();
    }
  });

  it('单批超过剩余预算 → 整批拒绝且不入库；恰好填满允许', () => {
    const { core, cleanup } = mkCore();
    try {
      const task = core.news.createTask({ title: '恰好填满', max_items: 3 });
      const t = core.news.claimTask(task.id).claim_token;
      expect(() => core.news.submitItems(task.id, t, [1, 2, 3, 4].map((i) => item({ source_url: `https://example.com/c-${i}`, title: `恰好 ${i}` })))).toThrow(/超出任务预算/);
      expect(core.news.getTask(task.id).inserted_count).toBe(0);
      expect(core.news.submitItems(task.id, t, [1, 2, 3].map((i) => item({ source_url: `https://example.com/c-${i}`, title: `恰好 ${i}` }))).inserted).toBe(3);
      expect(core.news.getTask(task.id).inserted_count).toBe(3);
    } finally {
      cleanup();
    }
  });
});

describe('24 小时窗口 / 历史视图 / 收藏保护', () => {
  it('近 24h 只见窗口内条目；历史视图不受预算限制；旧收藏与旧新闻保留', () => {
    const { core, dbPath, cleanup } = mkCore();
    try {
      insertLegacy(dbPath, 901, '昨天的旧闻', 'https://old.example.com/yesterday', '2026-10-01', true);
      insertLegacy(dbPath, 902, '更早的旧闻', 'https://old.example.com/older', '2026-09-01');
      const task = core.news.createTask({ title: '窗口任务', max_items: 10 });
      const t = core.news.claimTask(task.id).claim_token;
      core.news.submitItems(task.id, t, [item({ title: '窗口内新闻', source_url: 'https://example.com/in-window', published_at: iso(-2 * H) })]);

      const since24 = new Date(Date.now() - 24 * H).toISOString();
      const recent = core.news.list({ since: since24, limit: 100 });
      expect(recent.map((n) => n.title)).toContain('窗口内新闻');
      expect(recent.map((n) => n.title)).not.toContain('更早的旧闻');

      const history = core.news.list({ limit: 100 });
      expect(history.length).toBe(3); // 历史展示不受任务 10 条预算限制
      expect(history.map((n) => n.title)).toEqual(expect.arrayContaining(['昨天的旧闻', '更早的旧闻', '窗口内新闻']));
      expect(history.map((n) => n.title)).toEqual(['窗口内新闻', '昨天的旧闻', '更早的旧闻']);
      const firstPage = core.news.list({ limit: 2, offset: 0 });
      const secondPage = core.news.list({ limit: 2, offset: 2 });
      expect(firstPage.map((n) => n.id)).toEqual(history.slice(0, 2).map((n) => n.id));
      expect(secondPage.map((n) => n.id)).toEqual(history.slice(2).map((n) => n.id));

      // 旧收藏可见且未被任何任务操作改动
      const starred = core.news.list({ filter: 'starred', limit: 100 });
      expect(starred.map((n) => n.id)).toEqual([901]);
      expect(starred[0].task_id).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('24h 窗口先筛选再限量：排序靠前的窗外行不挤占名额（LIMIT 后过滤会漏新闻的回归）', () => {
    const { core, dbPath, cleanup } = mkCore();
    try {
      // A：23 小时前发布（窗口内），经服务真实提交（其 published_date 为今天或昨天，排序必然在噪声之后）
      const task = core.news.createTask({ title: '窗口挤压任务' });
      const t = core.news.claimTask(task.id).claim_token;
      const a = core.news.submitItems(task.id, t, [{
        title: '窗口内但排序靠后', summary: '应被时间窗保留。',
        source_url: 'https://example.com/late-window', published_at: new Date(Date.now() - 23 * H).toISOString(),
      }]).items[0];
      // 噪声：3 条 published_date=今天（排序在 A 之前：日期更新，或同日但 id 更大）但 published_at=48 小时前（窗外）
      const db = new DatabaseSync(dbPath);
      try {
        const ins = db.prepare(
          "INSERT INTO news (source, title, url, summary, published_date, published_at, fetched_at, dedup_key) VALUES ('hacker_news', ?, ?, '', ?, ?, '2026-10-01T00:00:00.000', ?)",
        );
        for (let i = 0; i < 3; i++) {
          ins.run(`噪声新闻 ${i}`, `https://noise.example.com/${i}`, todayStr(), new Date(Date.now() - 48 * H).toISOString(), `noise:${i}`);
        }
      } finally {
        db.close();
      }
      const since = new Date(Date.now() - 24 * H).toISOString();
      // 名额恰好等于噪声数：旧实现（SQL 先 LIMIT、JS 后过滤）只会拿到 3 条窗外噪声再全滤掉，漏掉 A
      const got = core.news.list({ since, limit: 3 });
      expect(got.map((n) => n.id)).toContain(a.id);
      expect(got.map((n) => n.title)).toEqual(['窗口内但排序靠后']); // 窗外噪声全部不在结果中
      // 放大名额同样只剩窗口内行
      expect(core.news.list({ since, limit: 100 }).map((n) => n.id)).toEqual([a.id]);
    } finally {
      cleanup();
    }
  });

  it('阅读状态：已读/收藏/按任务全部已读', () => {
    const { core, cleanup } = mkCore();
    try {
      const task = core.news.createTask({ title: '阅读任务' });
      const t = core.news.claimTask(task.id).claim_token;
      const res = core.news.submitItems(task.id, t, [item(), item({ title: '第二条', source_url: 'https://example.com/r2' })]);
      const first = res.items[0];
      expect(core.news.markRead(first.id, true).is_read).toBe(true);
      expect(core.news.markStarred(first.id, true).is_starred).toBe(true);
      expect(core.news.list({ filter: 'unread', task_id: task.id }).length).toBe(1);
      expect(core.news.list({ filter: 'starred', task_id: task.id }).length).toBe(1);
      const n = core.news.markAllRead({ task_id: task.id });
      expect(n).toBe(1);
      expect(core.news.list({ filter: 'unread', task_id: task.id }).length).toBe(0);
      expect(() => core.news.markRead(99999, true)).toThrow('不存在');
    } finally {
      cleanup();
    }
  });

  it('list 按任务过滤与来源过滤', () => {
    const { core, cleanup } = mkCore();
    try {
      const a = core.news.createTask({ title: '任务 A' });
      const ta = core.news.claimTask(a.id).claim_token;
      core.news.submitItems(a.id, ta, [item({ title: 'A 的新闻', source_url: 'https://example.com/ta' })]);
      const b = core.news.createTask({ title: '任务 B' });
      const tb = core.news.claimTask(b.id).claim_token;
      core.news.submitItems(b.id, tb, [item({ title: 'B 的新闻', source_url: 'https://example.com/tb' })]);
      expect(core.news.list({ task_id: a.id }).map((n) => n.title)).toEqual(['A 的新闻']);
      expect(core.news.list({ source: 'agent' }).length).toBe(2);
      expect(core.news.countBySource().agent).toBe(2);
      expect(core.news.lastFetchedAt()).toBeTruthy();
    } finally {
      cleanup();
    }
  });
});

// ---------- 删除新闻（v11）：事务边界 / 共享引用 / 指纹防回流 / 预算不返还 / 幂等与回滚 ----------

describe('删除新闻：事务边界、共享引用与指纹防回流', () => {
  /** 经真实提交路径造一条 agent 新闻 */
  const submitOne = (core: ReturnType<typeof createCore>, url: string, title: string) => {
    const task = core.news.createTask({ title: `采集：${title}` });
    const claim = core.news.claimTask(task.id, 'del-tester');
    const res = core.news.submitItems(task.id, claim.claim_token, [item({ title, source_url: url })]);
    return { newsId: res.items[0].id, taskId: task.id, claimToken: claim.claim_token };
  };

  it('单条删除：正文与收藏状态移除；话题链接随行删除；自媒体引用置空且来源快照保留；指纹为纯哈希', () => {
    const { core, dbPath, cleanup } = mkCore();
    try {
      const { newsId } = submitOne(core, 'https://example.com/del-1', '待删除的新闻甲');
      expect(core.news.markStarred(newsId, true).is_starred).toBe(true);

      const setup = new DatabaseSync(dbPath);
      try {
        // 共享引用：旧版话题链接 + 自媒体选题 + 自媒体素材（三者均指向同一新闻）
        setup.prepare("INSERT INTO news_topics (source_id, name, query) VALUES ('x', '话题A', 'kw')").run();
        setup.prepare('INSERT INTO news_topic_links (news_id, topic_id) VALUES (?, 1)').run(newsId);
      } finally {
        setup.close();
      }
      const topic = core.media.addTopic({ title: '基于新闻甲的选题', source: 'news', source_news_id: newsId });
      const material = core.media.addMaterial({ title: '新闻甲素材', content: '素材正文', source: 'news', source_news_id: newsId });

      const res = core.news.deleteItem(newsId);
      expect(res).toMatchObject({ deleted: true, id: newsId, topic_links_removed: 1, media_refs_cleared: 2, fingerprints_kept: 2 });

      // 正文与收藏状态随行消失：列表与收藏视图都不再出现
      expect(core.news.list({ limit: 100 }).some((n) => n.id === newsId)).toBe(false);
      expect(core.news.list({ filter: 'starred' }).some((n) => n.id === newsId)).toBe(false);

      const after = new DatabaseSync(dbPath);
      try {
        expect(after.prepare('SELECT COUNT(*) AS n FROM news WHERE id = ?').get(newsId)).toEqual({ n: 0 });
        expect(after.prepare('SELECT COUNT(*) AS n FROM news_topic_links WHERE news_id = ?').get(newsId)).toEqual({ n: 0 });
        // 自媒体成果保留：source_news_id 置空，来源快照（标题+链接）仍在
        const t = after.prepare('SELECT source_news_id, source_desc FROM media_topics WHERE id = ?').get(topic.id) as Record<string, unknown>;
        expect(t.source_news_id).toBeNull();
        expect(String(t.source_desc)).toContain('待删除的新闻甲');
        expect(String(t.source_desc)).toContain('https://example.com/del-1');
        const m = after.prepare('SELECT source_news_id, source_desc FROM media_materials WHERE id = ?').get(material.id) as Record<string, unknown>;
        expect(m.source_news_id).toBeNull();
        expect(String(m.source_desc)).toContain('待删除的新闻甲');
        // 指纹为 前缀+sha256：不含 URL / 标题明文，不可反推内容
        const fps = after.prepare('SELECT fingerprint FROM news_deleted_fingerprints').all() as Array<{ fingerprint: string }>;
        expect(fps.length).toBe(2);
        for (const f of fps) {
          expect(f.fingerprint).toMatch(/^(link|event):[0-9a-f]{64}$/);
          expect(f.fingerprint.includes('example.com')).toBe(false);
          expect(f.fingerprint.includes('待删除')).toBe(false);
        }
      } finally {
        after.close();
      }
    } finally {
      cleanup();
    }
  });

  it('幂等与跨连接删除：重复请求 / 第二实例删同条 → deleted:false，不报错不重复计指纹', () => {
    const { core, dbPath, cleanup } = mkCore();
    try {
      const { newsId } = submitOne(core, 'https://example.com/del-2', '只删一次的新闻乙');
      expect(core.news.deleteItem(newsId).deleted).toBe(true);
      expect(core.news.deleteItem(newsId).deleted).toBe(false);
      // 另一连接（App 与 MCP 双进程并发场景）删同一条：同样安全
      const db2 = openNodeSqliteDb(dbPath);
      const core2 = createCore(db2, { dbPath });
      expect(core2.news.deleteItem(newsId).deleted).toBe(false);
      db2.close();
      const check = new DatabaseSync(dbPath);
      try {
        expect(check.prepare('SELECT COUNT(*) AS n FROM news_deleted_fingerprints').get()).toEqual({ n: 2 });
      } finally {
        check.close();
      }
    } finally {
      cleanup();
    }
  });

  it('删除后同链接（含跟踪参数）与同事件提交被指纹拒绝；已删项 markRead 报错不复活；跨任务重复提交仍被库内去重拦截', () => {
    const { core, cleanup } = mkCore();
    try {
      const { newsId } = submitOne(core, 'https://example.com/del-3', '会被指纹拦住的新闻丙');
      expect(core.news.deleteItem(newsId).deleted).toBe(true);

      const task = core.news.createTask({ title: '删除后的新任务' });
      const claim = core.news.claimTask(task.id, 'tester2');
      // 同链接：跟踪参数剥离后命中 link 指纹
      expect(() => core.news.submitItems(task.id, claim.claim_token, [item({ source_url: 'https://example.com/del-3?utm_source=x' })])).toThrow('已被用户删除');
      // 同事件：换了链接但归一化标题一致 → 命中 event 指纹
      expect(() => core.news.submitItems(task.id, claim.claim_token, [item({ title: '会被指纹拦住的新闻丙', source_url: 'https://example.com/different-link' })])).toThrow('同一事件');
      // 已删项的异步已读/收藏写回：报错且不复活
      expect(() => core.news.markRead(newsId, true)).toThrow('不存在');
      expect(() => core.news.markStarred(newsId, true)).toThrow('不存在');
      // 库内去重（未删除路径）不受影响：另一任务提交库里已有链接仍被拒
      const { newsId: aliveId } = submitOne(core, 'https://example.com/alive-1', '仍存活的新闻丁');
      const task3 = core.news.createTask({ title: '第三个任务' });
      const claim3 = core.news.claimTask(task3.id, 'tester3');
      expect(() => core.news.submitItems(task3.id, claim3.claim_token, [item({ title: '仍存活的新闻丁', source_url: 'https://example.com/alive-1' })])).toThrow('已在库中');
      expect(core.news.list({ limit: 10 }).some((n) => n.id === aliveId)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('预算不返还：删空后 inserted_count 归零但 accepted_count/remaining 不变，再提交仍被历史累计拒绝', () => {
    const { core, cleanup } = mkCore();
    try {
      const task = core.news.createTask({ title: '预算任务', max_items: 2 });
      const claim = core.news.claimTask(task.id);
      const res = core.news.submitItems(task.id, claim.claim_token, [
        item({ title: '预算新闻一', source_url: 'https://example.com/b1' }),
        item({ title: '预算新闻二', source_url: 'https://example.com/b2' }),
      ]);
      expect(res.task.remaining).toBe(0);
      core.news.deleteItem(res.items[0].id);
      core.news.deleteItem(res.items[1].id);
      const t = core.news.getTask(task.id);
      expect(t.inserted_count).toBe(0);
      expect(t.accepted_count).toBe(2);
      expect(t.remaining).toBe(0);
      expect(() => core.news.submitItems(task.id, claim.claim_token, [item({ title: '预算新闻三', source_url: 'https://example.com/b3' })])).toThrow('超出任务预算');
    } finally {
      cleanup();
    }
  });

  it('事务失败回滚：DELETE 被触发器中止时，指纹 / 关联清理 / 正文行全部回滚；解除触发后可正常删除', () => {
    const { core, dbPath, cleanup } = mkCore();
    try {
      const { newsId } = submitOne(core, 'https://example.com/del-4', '回滚保护下的新闻戊');
      const topic = core.media.addTopic({ title: '引用新闻戊的选题', source: 'news', source_news_id: newsId });
      const armed = new DatabaseSync(dbPath);
      try {
        armed.exec("CREATE TRIGGER news_del_boom BEFORE DELETE ON news BEGIN SELECT RAISE(ABORT, 'boom'); END;");
      } finally {
        armed.close();
      }
      expect(() => core.news.deleteItem(newsId)).toThrow();
      const mid = new DatabaseSync(dbPath);
      try {
        expect(mid.prepare('SELECT COUNT(*) AS n FROM news WHERE id = ?').get(newsId)).toEqual({ n: 1 });
        expect(mid.prepare('SELECT COUNT(*) AS n FROM news_deleted_fingerprints').get()).toEqual({ n: 0 });
        expect(mid.prepare('SELECT source_news_id FROM media_topics WHERE id = ?').get(topic.id)).toEqual({ source_news_id: newsId });
        mid.exec('DROP TRIGGER news_del_boom');
      } finally {
        mid.close();
      }
      expect(core.news.deleteItem(newsId).deleted).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('筛选与空列表：收藏视图删除、删除最后一条、搜索视图删除后为空', () => {
    const { core, dbPath, cleanup } = mkCore();
    try {
      insertLegacy(dbPath, 9001, '旧收藏新闻', 'https://old.example.com/star', '2026-10-01', true);
      const { newsId } = submitOne(core, 'https://example.com/last-1', '最后一条agent新闻');
      expect(core.news.list({ filter: 'starred', limit: 10 }).map((n) => n.id)).toEqual([9001]);
      expect(core.news.deleteItem(9001).deleted).toBe(true);
      expect(core.news.list({ filter: 'starred', limit: 10 })).toEqual([]);
      expect(core.news.list({ search: '最后一条', limit: 10 }).map((n) => n.id)).toEqual([newsId]);
      expect(core.news.deleteItem(newsId).deleted).toBe(true);
      expect(core.news.list({ search: '最后一条', limit: 10 })).toEqual([]);
      expect(core.news.list({ limit: 10 })).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe('v10 → v11 迁移：news_deleted_fingerprints + accepted_count 回填', () => {
  it('v10 结构副本升级：指纹表重建、accepted_count 按存量回填、存量行零丢失、完整性检查通过', () => {
    const { db: down, dbPath, cleanup } = mkLegacyDb(10);
    try {
      // 真实执行到 v10 的合成库；不能把当前新库只改版本号冒充旧结构。
      try {
        // initDb 的基础建表已包含当前新闻列；显式还原本项要验证的 v10 新闻形态。
        down.exec('DROP TABLE news_deleted_fingerprints; ALTER TABLE news_tasks DROP COLUMN accepted_count;');
        expect(down.prepare('PRAGMA table_info(news_tasks)').all().some(column => column.name === 'accepted_count')).toBe(false);
        down.prepare(
          "INSERT INTO news_tasks (title, instructions, max_items, window_hours, status, created_by, created_at, updated_at) VALUES ('v10 老任务', '', 5, 24, 'completed', 'mcp', '2026-10-01T00:00:00.000', '2026-10-01T00:00:00.000')",
        ).run();
        down.prepare(
          "INSERT INTO news (source, title, url, summary, published_date, fetched_at, dedup_key, task_id) VALUES ('agent', 'v10 存量一', 'https://example.com/v10-1', 's', '2026-10-01', '2026-10-01T00:00:00.000', 'url:example.com/v10-1', 1)",
        ).run();
        down.prepare(
          "INSERT INTO news (source, title, url, summary, published_date, fetched_at, dedup_key, task_id) VALUES ('agent', 'v10 存量二', 'https://example.com/v10-2', 's', '2026-10-01', '2026-10-01T00:00:00.000', 'url:example.com/v10-2', 1)",
        ).run();
      } finally {
        down.close();
      }

      const db = openNodeSqliteDb(dbPath);
      const core = createCore(db, { dbPath }); // 打开即迁移
      try {
        const ver = db.prepare('PRAGMA user_version').get() as { user_version: number };
        expect(ver.user_version).toBe(MIGRATIONS.length);
        expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='news_deleted_fingerprints'").get()).toBeTruthy();
        expect(core.news.getTask(1).accepted_count).toBe(2); // 按存量回填
        expect(core.news.getTask(1).inserted_count).toBe(2);
        expect(core.news.list({ limit: 10 }).filter((n) => n.task_id === 1).length).toBe(2); // 存量零丢失
        // v12：内容形态列补齐，历史行默认 url / 无快照，行为不变
        expect(core.news.list({ limit: 10 }).every((n) => n.content_kind === 'url' && n.html_rel === null)).toBe(true);
        expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
        expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally {
        db.close();
      }
    } finally {
      cleanup();
    }
  });
});

describe('本地 HTML 快照（content_kind=html）：提交 / 消毒 / 读取 / 删除', () => {
  const snapHtml = `
    <article>
      <h3>某公司发布新一代开源模型</h3>
      <p>作者 @someone · 2026-10-13</p>
      <p>正文段落：性能提升 40%。</p>
      <img src="https://pbs.twimg.com/media/abc.jpg" alt="配图">
      <a href="https://x.com/someone/status/123">原帖链接</a>
      <script>alert('x')</script>
      <img src="javascript:alert(1)" onerror="steal()">
      <a href="data:text/html,boom">危险链接</a>
    </article>`;

  it('提交带 html：入库 content_kind=html，文件落在 dirname(db)/news，脚本与危险协议被剥离、https 图床保留', () => {
    const { core, dbPath, cleanup } = mkCore();
    try {
      const task = core.news.createTask({ title: 'X 快照任务' });
      const claim = core.news.claimTask(task.id, 'zcode');
      const res = core.news.submitItems(task.id, claim.claim_token, [
        item({ title: 'X 推文快照', source_url: 'https://x.com/someone/status/123', html: snapHtml }),
        item({ title: '普通网页新闻', source_url: 'https://example.com/plain' }),
      ]);
      expect(res.items[0].content_kind).toBe('html');
      expect(res.items[0].html_rel).toMatch(/^[0-9a-f-]{36}\.html$/);
      expect(res.items[1].content_kind).toBe('url');
      expect(res.items[1].html_rel).toBeNull();

      const root = newsRootForDb(dbPath);
      const abs = join(root, res.items[0].html_rel!);
      expect(existsSync(abs)).toBe(true);
      const saved = readFileSync(abs, 'utf8');
      // 片段被包成完整文档并注入 charset；标题进入 <title>
      expect(saved).toContain('<!doctype html>');
      expect(saved).toMatch(/<meta charset="utf-8">/);
      expect(saved).toContain('X 推文快照');
      // 消毒：脚本/事件属性/危险协议剥离；https 图床与原帖链接保留
      expect(saved).not.toContain('<script');
      expect(saved).not.toContain('onerror');
      expect(saved).not.toContain('javascript:');
      expect(saved).not.toContain('data:text/html');
      expect(saved).toContain('https://pbs.twimg.com/media/abc.jpg');
      expect(saved).toContain('https://x.com/someone/status/123');
      // 完整文档（自带 <html>）只补 charset，不重写结构
      const fullDoc = '<html><head><title>x</title></head><body><p>整页文档</p></body></html>';
      const res2 = core.news.submitItems(task.id, claim.claim_token, [
        item({ title: '整页快照', source_url: 'https://x.com/someone/status/456', html: fullDoc }),
      ]);
      const saved2 = readFileSync(join(root, res2.items[0].html_rel!), 'utf8');
      expect(saved2).toContain('<html><head><meta charset="utf-8">');
    } finally {
      cleanup();
    }
  });

  it('非法 html（空串/超长）整批拒绝且不留文件；无 html 字段行为不变', () => {
    const { core, dbPath, cleanup } = mkCore();
    try {
      const task = core.news.createTask({ title: '校验任务' });
      const claim = core.news.claimTask(task.id, 'zcode');
      expect(() => core.news.submitItems(task.id, claim.claim_token, [
        item({ title: '空快照', source_url: 'https://x.com/a/1', html: '   ' }),
      ])).toThrow(/html 快照不能为空/);
      expect(() => core.news.submitItems(task.id, claim.claim_token, [
        item({ title: '超快照', source_url: 'https://x.com/a/2', html: 'x'.repeat(NEWS_HTML_MAX_CHARS + 1) }),
      ])).toThrow(/html 快照过长/);
      // 整批原子：合法条目与非法条目同批 → 全部拒绝
      expect(() => core.news.submitItems(task.id, claim.claim_token, [
        item({ title: '合法条目', source_url: 'https://example.com/ok' }),
        item({ title: '非法条目', source_url: 'https://x.com/a/3', html: '' }),
      ])).toThrow(/不能为空/);
      expect(core.news.list({ limit: 10 })).toEqual([]);
      expect(existsSync(newsRootForDb(dbPath))).toBe(false); // 没有任何文件被写出
    } finally {
      cleanup();
    }
  });

  it('readHtml：快照回读原文；url 条目返回 null；文件缺失 missing=true', () => {
    const { core, dbPath, cleanup } = mkCore();
    try {
      const task = core.news.createTask({ title: '回读任务' });
      const claim = core.news.claimTask(task.id, 'zcode');
      const res = core.news.submitItems(task.id, claim.claim_token, [
        item({ title: 'X 快照', source_url: 'https://x.com/b/1', html: '<p>回读内容</p>' }),
        item({ title: '普通新闻', source_url: 'https://example.com/nosnap' }),
      ]);
      const back = core.news.readHtml(res.items[0].id);
      expect(back.content_kind).toBe('html');
      expect(back.missing).toBe(false);
      expect(back.html).toContain('回读内容');

      const plain = core.news.readHtml(res.items[1].id);
      expect(plain).toMatchObject({ content_kind: 'url', html: null, missing: false });

      // 文件被外部移走 → missing=true（不抛错，调用方降级）
      unlinkSync(join(newsRootForDb(dbPath), res.items[0].html_rel!));
      const gone = core.news.readHtml(res.items[0].id);
      expect(gone.missing).toBe(true);
      expect(gone.html).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('删除快照新闻：文件随行清理（html_removed=1），重复删除幂等', () => {
    const { core, dbPath, cleanup } = mkCore();
    try {
      const task = core.news.createTask({ title: '删除任务' });
      const claim = core.news.claimTask(task.id, 'zcode');
      const res = core.news.submitItems(task.id, claim.claim_token, [
        item({ title: '待删快照', source_url: 'https://x.com/c/1', html: '<p>将被删除</p>' }),
      ]);
      const abs = join(newsRootForDb(dbPath), res.items[0].html_rel!);
      expect(existsSync(abs)).toBe(true);
      const del = core.news.deleteItem(res.items[0].id);
      expect(del.deleted).toBe(true);
      expect(del.html_removed).toBe(1);
      expect(existsSync(abs)).toBe(false);
      expect(core.news.deleteItem(res.items[0].id)).toMatchObject({ deleted: false, html_removed: 0 });
      // 同链接防回流（含快照条目）：租约仍持有，用原令牌再提交即触发指纹拒绝
      expect(() => core.news.submitItems(task.id, claim.claim_token, [
        item({ title: '同链接再来', source_url: 'https://x.com/c/1', html: '<p>回流</p>' }),
      ])).toThrow(/已被用户删除/);
    } finally {
      cleanup();
    }
  });
});
