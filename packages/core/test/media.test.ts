// 自媒体服务测试：选题→内容→平台版本（人工审核红线）→素材→排期→发布回填→指标→复盘→素材包导出
// 全程临时库 + 临时 vault 夹具，绝不触碰真实数据。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openNodeSqliteDb } from '../src/adapters/node-sqlite';
import { createCore, type TodoDeskCore } from '../src/index';

let dir: string;
let core: TodoDeskCore;
let exportRoot: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tododesk-media-test-'));
  const vaultDir = join(dir, 'vault');
  mkdirSync(join(vaultDir, 'knowledge/resources/fa'), { recursive: true });
  writeFileSync(
    join(vaultDir, 'knowledge/resources/fa/知识库价值公式.md'),
    '---\nstatus: active\n---一句话核心。',
  );
  const db = openNodeSqliteDb(join(dir, 'test.db'));
  core = createCore(db, { dbPath: join(dir, 'test.db') });
  exportRoot = join(dir, 'exports');
  mkdirSync(exportRoot, { recursive: true });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('选题与来源追溯', () => {
  it('手工选题', () => {
    const t = core.media.addTopic({ title: '知识库联动实践', angle: '以只读索引切入', tags: ['知识库'] });
    expect(t.status).toBe('idea');
    expect(t.source).toBe('manual');
  });

  it('新闻来源：必须真实存在并快照标题/URL', () => {
    core.db
      .prepare("INSERT INTO news (source, title, url, summary, published_date, fetched_at, dedup_key) VALUES ('rss/x', 'RSS 标题', 'https://example.com/a', '', '2026-10-11', '2026-10-11T00:00:00Z', 'k1')")
      .run();
    const t = core.media.addTopic({ title: '来自新闻的选题', source: 'news', source_news_id: 1 });
    expect(t.source_desc).toContain('RSS 标题');
    expect(t.source_desc).toContain('https://example.com/a');
    expect(() => core.media.addTopic({ title: 'x', source: 'news', source_news_id: 999 })).toThrow('新闻不存在');
  });

  it('知识来源：卡片必须已入索引', () => {
    const v = core.vaults.register({ root_path: join(dir, 'vault') });
    expect(() =>
      core.media.addTopic({ title: 'x', source: 'knowledge', source_note: { vault_id: v.id, rel_path: 'knowledge/resources/fa/不存在.md' } }),
    ).toThrow('未入索引');
    core.vaults.scan(v.id);
    const t = core.media.addTopic({
      title: '来自知识卡片的选题',
      source: 'knowledge',
      source_note: { vault_id: v.id, rel_path: 'knowledge/resources/fa/知识库价值公式.md' },
    });
    expect(t.source_desc).toContain('知识库价值公式');
  });

  it('状态流转与删除保护', () => {
    const t = core.media.listTopics()[0];
    core.media.updateTopic(t.id, { status: 'selected' });
    expect(core.media.listTopics({ status: 'selected' })[0].id).toBe(t.id);
    expect(() => core.media.updateTopic(t.id, { status: 'bad' })).toThrow('选题状态不合法');
    const used = core.media.listTopics({ search: '来自新闻' })[0];
    core.media.addContent({ topic_id: used.id, title: '占位' });
    expect(() => core.media.deleteTopic(used.id)).toThrow('已有内容');
    core.media.deleteContent(core.media.listContents({ search: '占位' })[0].id);
    core.media.deleteTopic(used.id);
  });
});

describe('一母稿多平台版本与人工审核', () => {
  it('母稿 + 版本 + 审核流转全链路', () => {
    const c = core.media.addContent({ title: '只读知识库联动', master_content: '母稿第一段。' });
    expect(c.status).toBe('drafting');
    const v1 = core.media.addVersion(c.id, { platform: 'XiaohongShu', body: '小红书版本' });
    expect(v1.platform).toBe('xiaohongshu'); // 归一化小写
    expect(() => core.media.addVersion(c.id, { platform: 'xiaohongshu' })).toThrow('已存在');
    expect(() => core.media.addVersion(c.id, { platform: 'Bad Platform!' })).toThrow('平台标识不合法');
    const v2 = core.media.addVersion(c.id, { platform: 'weixin', body: '公众号长文版' });

    // draft 不能直接排期
    expect(() => core.media.schedule({ content_version_id: v1.id, planned_date: '2026-10-12' })).toThrow('approved');

    // 提交审核 → 通过
    core.commands.human.reviewMediaVersion(v1.id, 'submit');
    expect(core.commands.human.reviewMediaVersion(v1.id, 'approve', '可以发').status).toBe('approved');
    // approved 不可直接改
    expect(() => core.media.updateVersion(v1.id, { body: '偷改' })).toThrow('不可直接编辑');
    // 撤回重编
    core.commands.human.reviewMediaVersion(v1.id, 'revoke');
    expect(core.media.getContent(c.id).versions.find((v) => v.id === v1.id)?.status).toBe('draft');

    // 第二版走拒绝
    core.commands.human.reviewMediaVersion(v2.id, 'submit');
    core.commands.human.reviewMediaVersion(v2.id, 'reject', '开头太闷');
    const rej = core.media.getContent(c.id).versions.find((v) => v.id === v2.id);
    expect(rej?.status).toBe('rejected');
    expect(rej?.review_note).toBe('开头太闷');
    // rejected 修改后可重新提交，再次审核通过
    core.media.updateVersion(v2.id, { body: '改好了' });
    core.commands.human.reviewMediaVersion(v2.id, 'submit');
    expect(core.commands.human.reviewMediaVersion(v2.id, 'approve').status).toBe('approved');
  });

  it('母稿定稿与复盘笔记', () => {
    const c = core.media.listContents({ search: '只读知识库联动' })[0];
    core.media.updateContent(c.id, { status: 'master_done', retro_note: '首发复盘：标题决定打开率。' });
    const got = core.media.getContent(c.id);
    expect(got.content.status).toBe('master_done');
    expect(got.content.retro_note).toContain('打开率');
  });
});

describe('素材与关联', () => {
  it('素材 CRUD + 挂载/卸载', () => {
    const m = core.media.addMaterial({ title: '金句截图', kind: 'image', content: '封面备选：价值公式手绘图', tags: ['封面'] });
    const c = core.media.listContents({ search: '只读知识库联动' })[0];
    core.media.attachMaterial(c.id, m.id);
    core.media.attachMaterial(c.id, m.id); // 幂等
    expect(core.media.getContent(c.id).materials).toHaveLength(1);
    core.media.detachMaterial(c.id, m.id);
    expect(core.media.getContent(c.id).materials).toHaveLength(0);
    core.media.attachMaterial(c.id, m.id);
    expect(() => core.media.addMaterial({ title: 'x', kind: 'video' as 'text' })).toThrow('素材类型不合法');
  });
});

describe('日历：排期与人工发布回填', () => {
  it('审核通过才可排期；改期复用条目；发布回填链接；取消限 planned', () => {
    const c = core.media.listContents({ search: '只读知识库联动' })[0];
    const wx = core.media.getContent(c.id).versions.find((v) => v.platform === 'weixin')!;
    expect(wx.status).toBe('approved'); // 上一测试已走完拒绝→改稿→复审通过
    const e1 = core.media.schedule({ content_version_id: wx.id, planned_date: '2026-10-12', note: '首发' });
    expect(e1.status).toBe('planned');
    // 同版本再排期 = 改期（不重复建条目）
    const e2 = core.media.schedule({ content_version_id: wx.id, planned_date: '2026-10-13' });
    expect(e2.id).toBe(e1.id);
    expect(core.media.listCalendar({ content_id: c.id })).toHaveLength(1);
    expect(() => core.media.schedule({ content_version_id: wx.id, planned_date: 'bad-date' })).toThrow();
    // 回填发布
    expect(() => core.media.markPublished(e1.id, { publish_url: 'notaurl' })).toThrow('http(s)');
    const pub = core.media.markPublished(e1.id, { publish_url: 'https://mp.weixin.qq.com/s/abc', note: '已手动群发' });
    expect(pub.status).toBe('published');
    expect(pub.published_at).toBeTruthy();
    // 已发布不能取消、不能再改期
    expect(() => core.media.cancelSchedule(e1.id)).toThrow('planned');
    expect(() => core.media.schedule({ content_version_id: wx.id, planned_date: '2026-10-20' })).toThrow('已发布');
  });

  it('概览与平台统计', () => {
    const ov = core.media.getOverview();
    expect(ov.calendar.published).toBeGreaterThanOrEqual(1);
    expect(ov.versions.approved).toBeGreaterThanOrEqual(1);
    const c = core.media.listContents({ search: '只读知识库联动' })[0];
    const entry = core.media.listCalendar({ content_id: c.id }).find((e) => e.status === 'published')!;
    core.media.addMetric({ calendar_id: entry.id, date: '2026-10-13', views: 1200, likes: 88, custom: { 完读率: 0.62 } });
    // 同日重复录入 = 整行覆盖（custom 一并覆盖）
    core.media.addMetric({ calendar_id: entry.id, date: '2026-10-13', views: 1500, likes: 100, custom: { 完读率: 0.71 } });
    const ms = core.media.listMetrics({ calendar_id: entry.id });
    expect(ms).toHaveLength(1);
    expect(ms[0].views).toBe(1500);
    expect(ms[0].custom).toEqual({ 完读率: 0.71 });
    const stats = core.media.getStats({});
    expect(stats[0].platform).toBe('weixin');
    expect(stats[0].views).toBe(1500);
    // 未发布排期不可录指标
    const wx2 = core.media.addVersion(c.id, { platform: 'douyin', body: '口播稿' });
    core.commands.human.reviewMediaVersion(wx2.id, 'submit');
    core.commands.human.reviewMediaVersion(wx2.id, 'approve');
    const plan = core.media.schedule({ content_version_id: wx2.id, planned_date: '2026-10-15' });
    expect(() => core.media.addMetric({ calendar_id: plan.id, views: 1 })).toThrow('published');
  });
});

describe('素材包导出', () => {
  it('导出到 vault 外目录，含全部文件；vault 内目录拒绝；重复导出防覆盖', () => {
    const c = core.media.listContents({ search: '只读知识库联动' })[0];
    const out = core.media.exportPackage(c.id, exportRoot);
    expect(out.versions).toBeGreaterThanOrEqual(2);
    expect(out.files).toContain('master.md');
    expect(out.files).toContain('versions/xiaohongshu.md');
    expect(out.files).toContain('materials.md');
    expect(out.files).toContain('README.txt');
    // 重复导出同目录：防覆盖
    expect(() => core.media.exportPackage(c.id, exportRoot)).toThrow('防覆盖');
    // vault 内拒绝
    const v = core.vaults.list()[0];
    expect(() => core.media.exportPackage(c.id, v.root_path)).toThrow('vault');
  });
});
