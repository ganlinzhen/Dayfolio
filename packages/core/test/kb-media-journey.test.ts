// 第一轮模拟用户迭代：核心闭环旅程（模拟用户场景，非真人测试）。
// 以「用户第一天使用 TodoDesk 知识库与自媒体」的视角顺序走完两个模块的主链路，
// 断言每一步的可见结果；配套记录见 claude_doc/TodoDesk知识库与自媒体交付记录.md。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openNodeSqliteDb } from '../src/adapters/node-sqlite';
import { createCore, type TodoDeskCore } from '../src/index';

let dir: string;
let core: TodoDeskCore;
let vaultDir: string;

const writeNote = (rel: string, text: string) => {
  const abs = join(vaultDir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, text, 'utf8');
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'td-journey1-'));
  vaultDir = join(dir, 'kb');
  // 用户把自己的 Obsidian 库接进来（夹具模拟真实结构）
  writeNote('knowledge/moc/首页.md', '---\ntitle: 首页\n---\n入口：[[知识库价值公式]]、[[后端与存储]]。');
  writeNote('knowledge/resources/fa/知识库价值公式.md', '---\nstatus: active\ntags: [方法论]\n---\n核心：价值 = 沉淀 × 复用。\n\n## 边界\n不适用于流水记录。见 [[首页]]。');
  writeNote('knowledge/resources/shu/Obsidian链接规范.md', '---\nstatus: active\n---\nwikilink 规范。');
  writeNote('knowledge/inbox-cards/待审.md', '---\nstatus: draft\n---\n草稿。');
  const db = openNodeSqliteDb(join(dir, 'user.db'));
  core = createCore(db, { dbPath: join(dir, 'user.db') });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('第一轮·知识库核心闭环（模拟用户）', () => {
  it('注册我的库 → 首次扫描 → 看到卡片清单', () => {
    const v = core.vaults.register({ root_path: vaultDir, name: '我的知识库' });
    expect(v.name).toBe('我的知识库');
    const s = core.vaults.scan(v.id);
    expect(s.discovered).toBe(4);
    expect(s.invalid_dirs).toHaveLength(0);
    const notes = core.vaults.listNotes({ vault_id: v.id });
    expect(notes.map((n) => n.title).sort()).toEqual(['Obsidian链接规范', '待审', '首页', '知识库价值公式'].sort());
  });

  it('搜索「复用」找到价值公式卡并阅读', () => {
    const [v] = core.vaults.list();
    const hits = core.vaults.listNotes({ vault_id: v.id, search: '复用' });
    expect(hits).toHaveLength(1);
    const d = core.vaults.getNote(v.id, hits[0].rel_path);
    expect(d.markdown).toContain('沉淀 × 复用');
    expect(d.links.find((l) => l.raw_target === '首页')?.resolved?.rel_path).toBe('knowledge/moc/首页.md');
    expect(d.backlinks.map((b) => b.title)).toContain('首页');
  });

  it('把学习概念关联到卡片，复习时能找到', () => {
    const [v] = core.vaults.list();
    core.vaults.linkConcept({ vault_id: v.id, rel_path: 'knowledge/resources/fa/知识库价值公式.md', knowledge_key: 'kb/value' });
    const links = core.vaults.listConceptLinks({ knowledge_key: 'kb/value' });
    expect(links).toHaveLength(1);
    // 概念另一头接学习计划（闭环：复习任务→卡片）
    const plan = core.plans.create({
      title: '知识库方法论', start_date: '2026-10-11', items: [
        { date: '2026-10-11', content: '理解价值公式', item_type: 'learn', knowledge_key: 'kb/value' },
      ],
    });
    expect(plan.items[0].knowledge_key).toBe('kb/value');
  });
});

describe('第一轮·自媒体核心闭环（模拟用户）', () => {
  it('选题（关联新闻）→ 母稿 → 双平台版本 → 提交审核', () => {
    core.db
      .prepare("INSERT INTO news (source, title, url, summary, published_date, fetched_at, dedup_key) VALUES ('rss/x', '知识库工具测评', 'https://example.com/review', '', '2026-10-11', '2026-10-11T00:00:00Z', 'j1')")
      .run();
    const topic = core.media.addTopic({ title: '我的知识库工作流', angle: '实操向', source: 'news', source_news_id: 1 });
    expect(topic.source_desc).toContain('知识库工具测评');

    const content = core.media.addContent({ topic_id: topic.id, title: '我的知识库工作流', master_content: '母稿：三个习惯。' });
    core.media.updateTopic(topic.id, { status: 'selected' });
    const xhs = core.media.addVersion(content.id, { platform: 'xiaohongshu', body: '小红书版：3 图文' });
    const wx = core.media.addVersion(content.id, { platform: 'weixin', body: '公众号版：长文' });
    core.media.reviewVersion(xhs.id, 'submit');
    core.media.reviewVersion(wx.id, 'submit');
    const ov = core.media.getOverview();
    expect(ov.versions.in_review).toBe(2);
    expect(ov.pending_review.map((p) => p.platform).sort()).toEqual(['weixin', 'xiaohongshu'].sort());
    return { content, xhs, wx };
  });

  it('概览逐条人工审核：通过小红书、拒绝公众号（拒绝原因可见）', () => {
    const ov = core.media.getOverview();
    for (const p of ov.pending_review) {
      if (p.platform === 'xiaohongshu') core.media.reviewVersion(p.id, 'approve', '首发可发');
      else core.media.reviewVersion(p.id, 'reject', '开头太长，压缩到 50 字内');
    }
    const after = core.media.getOverview();
    expect(after.versions.approved).toBe(1);
    expect(after.versions.rejected).toBe(1);
    const c = core.media.listContents({ search: '我的知识库工作流' })[0];
    const wx = core.media.getContent(c.id).versions.find((v) => v.platform === 'weixin')!;
    expect(wx.review_note).toContain('50 字');
  });

  it('排期 → 到期手动发布 → 回填链接 → 录两次指标（次日增量覆盖当日）', () => {
    const c = core.media.listContents({ search: '我的知识库工作流' })[0];
    const xhs = core.media.getContent(c.id).versions.find((v) => v.platform === 'xiaohongshu')!;
    const cal = core.media.schedule({ content_version_id: xhs.id, planned_date: '2026-10-12' });
    expect(core.media.getOverview().upcoming.map((u) => u.id)).toContain(cal.id);

    core.media.markPublished(cal.id, { publish_url: 'https://xhs.example.com/p/1' });
    core.media.addMetric({ calendar_id: cal.id, date: '2026-10-12', views: 800, likes: 40 });
    core.media.addMetric({ calendar_id: cal.id, date: '2026-10-13', views: 2000, likes: 130 });
    const stats = core.media.getStats({});
    expect(stats[0].platform).toBe('xiaohongshu');
    expect(stats[0].views).toBe(2800);
    expect(stats[0].published).toBe(1);
  });

  it('挂素材 → 导出素材包（vault 外）→ 文件可读', () => {
    const m = core.media.addMaterial({ title: '核心金句', kind: 'text', content: '价值 = 沉淀 × 复用', tags: ['金句'] });
    const c = core.media.listContents({ search: '我的知识库工作流' })[0];
    core.media.attachMaterial(c.id, m.id);
    const out = core.media.exportPackage(c.id, join(dir, 'pkg-out'));
    // 返回真实落点（realpath 形式，macOS /var → /private/var）：用包含关系断言
    expect(out.dir).toContain('pkg-out');
    const master = readFileSync(join(out.dir, 'master.md'), 'utf8');
    expect(master).toContain('三个习惯');
    const mats = readFileSync(join(out.dir, 'materials.md'), 'utf8');
    expect(mats).toContain('核心金句');
  });

  it('复盘笔记回填到内容', () => {
    const c = core.media.listContents({ search: '我的知识库工作流' })[0];
    core.media.updateContent(c.id, { retro_note: '封面用公式手绘图效果好；发布时间 12:00 优于 21:00。' });
    expect(core.media.getContent(c.id).content.retro_note).toContain('12:00');
  });
});
