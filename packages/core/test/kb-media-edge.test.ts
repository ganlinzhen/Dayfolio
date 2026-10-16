// 第三轮模拟用户迭代：异常 / 重启 / 重复 / 长内容（模拟用户场景，非真人测试）。
// 覆盖：App 重启后数据持久、vault 根不可达/文件消失/超大文件、重复操作幂等或明确拒绝、
// 超长文本的索引与导出。配套记录见 claude_doc/TodoDesk知识库与自媒体交付记录.md。
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openNodeSqliteDb } from '../src/adapters/node-sqlite';
import { createCore, type TodoDeskCore } from '../src/index';

let dir: string;
let core: TodoDeskCore;
let vaultDir: string;
let dbPath: string;

const writeNote = (rel: string, text: string) => {
  const abs = join(vaultDir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, text, 'utf8');
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'td-edge3-'));
  vaultDir = join(dir, 'kb');
  writeNote('knowledge/resources/fa/稳定卡.md', '---\nstatus: active\n---\n稳定内容，链接 [[首页]]。');
  writeNote('knowledge/moc/首页.md', '---\n---\n入口。');
  dbPath = join(dir, 'edge.db');
  core = createCore(openNodeSqliteDb(dbPath), { dbPath });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('第三轮·重启持久化（模拟 App 退出重开）', () => {
  it('写入全部数据 → 关库重开 → 数据完整', () => {
    const v = core.vaults.register({ root_path: vaultDir });
    core.vaults.scan(v.id);
    const link = core.vaults.linkConcept({ vault_id: v.id, rel_path: 'knowledge/resources/fa/稳定卡.md', knowledge_key: 'edge/k1' });
    const topic = core.media.addTopic({ title: '重启选题' });
    const content = core.media.addContent({ topic_id: topic.id, title: '重启内容', master_content: 'm'.repeat(1024) });
    const ver = core.media.addVersion(content.id, { platform: 'weixin', body: 'v' });
    core.commands.human.reviewMediaVersion(ver.id, 'submit');
    core.commands.human.reviewMediaVersion(ver.id, 'approve');
    const cal = core.media.schedule({ content_version_id: ver.id, planned_date: '2026-10-12' });
    core.media.markPublished(cal.id, { publish_url: 'https://example.com/p/1' });
    core.media.addMetric({ calendar_id: cal.id, views: 99 });
    const mat = core.media.addMaterial({ title: '重启素材' });
    core.media.attachMaterial(content.id, mat.id);
    // “重启”：关库重开同一文件
    core.db.close();
    core = createCore(openNodeSqliteDb(dbPath), { dbPath });

    const v2 = core.vaults.list()[0];
    expect(v2.root_path).toBe(realpathSync(vaultDir));
    expect(core.vaults.listNotes({ vault_id: v2.id })).toHaveLength(2);
    expect(core.vaults.listConceptLinks({ note_id: link.note_id })).toHaveLength(1);
    const d = core.media.getContent(content.id);
    expect(d.versions[0].status).toBe('approved');
    expect(d.calendar[0].status).toBe('published');
    expect(core.media.listMetrics({})[0].views).toBe(99);
    expect(d.materials[0].title).toBe('重启素材');
    // 迁移不重复执行（user_version 稳定）
    expect(Number((core.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)).toBeGreaterThanOrEqual(7);
  });
});

describe('第三轮·vault 异常', () => {
  it('vault 根目录被移走后扫描给出明确错误（不炸库）', () => {
    const away = join(dir, 'kb-away');
    mkdirSync(join(away, 'knowledge/moc'), { recursive: true });
    writeFileSync(join(away, 'knowledge/moc/x.md'), 'x'); // 结构占位
    const v = core.vaults.register({ root_path: away });
    rmSync(away, { recursive: true, force: true });
    let msg = '';
    try {
      core.vaults.scan(v.id);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('不可访问');
    expect(msg).toContain('已保留'); // F4 修复复测：明确指引而非系统 ENOENT
  });

  it('文件消失 → missing；原路径恢复 → 重扫归位且概念关联不丢', () => {
    const [v] = core.vaults.list().filter((x) => x.root_path === realpathSync(vaultDir));
    rmSync(join(vaultDir, 'knowledge/resources/fa/稳定卡.md'));
    core.vaults.scan(v.id);
    const gone = core.vaults.listNotes({ vault_id: v.id, missing: true })[0];
    expect(gone.rel_path).toBe('knowledge/resources/fa/稳定卡.md');
    // 关联历史仍在
    expect(core.vaults.listConceptLinks({})).toHaveLength(1);
    // 恢复文件（同路径）
    writeNote('knowledge/resources/fa/稳定卡.md', '---\nstatus: active\n---\n稳定内容（恢复）。');
    core.vaults.scan(v.id);
    const back = core.vaults.listNotes({ vault_id: v.id, search: '稳定' })[0];
    expect(back.missing).toBe(false);
    expect(back.id).toBe(gone.id); // 行复用：关联无需重建
    expect(core.vaults.listConceptLinks({ note_id: gone.id })).toHaveLength(1);
  });

  it('超大文件（>2MB）跳过不入索引', () => {
    const [v] = core.vaults.list().filter((x) => x.root_path === realpathSync(vaultDir));
    writeNote('knowledge/resources/fa/巨卡.md', `${'巨'.repeat(2 * 1024 * 1024 + 10)}`);
    const s = core.vaults.scan(v.id);
    expect(s.skipped).toBeGreaterThanOrEqual(1);
    expect(core.vaults.listNotes({ vault_id: v.id, search: '巨卡' })).toHaveLength(0);
  });
});

describe('第三轮·重复操作（幂等或明确拒绝）', () => {
  it('重复注册/同卡同键关联/同平台版本/重复导出均明确拒绝；重复挂载/排期/指标幂等', () => {
    expect(() => core.vaults.register({ root_path: vaultDir })).toThrow('已注册');
    const [v] = core.vaults.list().filter((x) => x.root_path === realpathSync(vaultDir));
    // 同卡同键 → 拒绝（同键不同卡是允许的：一概念多卡，见 journey 用例）
    expect(() =>
      core.vaults.linkConcept({ vault_id: v.id, rel_path: 'knowledge/resources/fa/稳定卡.md', knowledge_key: 'edge/k1' }),
    ).toThrow('请勿重复关联');
    const c = core.media.addContent({ title: '重复语义' });
    const ver = core.media.addVersion(c.id, { platform: 'x' });
    expect(() => core.media.addVersion(c.id, { platform: 'x' })).toThrow('已存在');
    core.commands.human.reviewMediaVersion(ver.id, 'submit');
    core.commands.human.reviewMediaVersion(ver.id, 'approve');
    const e1 = core.media.schedule({ content_version_id: ver.id, planned_date: '2026-10-13' });
    const e2 = core.media.schedule({ content_version_id: ver.id, planned_date: '2026-10-14' });
    expect(e2.id).toBe(e1.id); // 改期复用
    const m1 = core.media.addMaterial({ title: '幂等素材' });
    core.media.attachMaterial(c.id, m1.id);
    core.media.attachMaterial(c.id, m1.id);
    expect(core.media.getContent(c.id).materials).toHaveLength(1);
    core.media.markPublished(e1.id);
    core.media.addMetric({ calendar_id: e1.id, date: '2026-10-14', views: 1 });
    core.media.addMetric({ calendar_id: e1.id, date: '2026-10-14', views: 2 });
    expect(core.media.listMetrics({ calendar_id: e1.id })[0].views).toBe(2);
    const out = core.media.exportPackage(c.id, join(dir, 'dup-export'));
    expect(() => core.media.exportPackage(c.id, join(dir, 'dup-export'))).toThrow('防覆盖');
  });
});

describe('第三轮·长内容', () => {
  it('500KB 卡片：索引搜索文本截断、阅读全文、渲染耗时可接受', () => {
    const [v] = core.vaults.list().filter((x) => x.root_path === realpathSync(vaultDir));
    const longBody = `${'长'.repeat(500 * 1024)}\n尾部标记唯一token`;
    writeNote('knowledge/resources/fa/长文卡.md', `---\nstatus: active\n---\n${longBody}`);
    const s = core.vaults.scan(v.id);
    expect(s.updated).toBeGreaterThanOrEqual(1);
    const row = core.vaults.listNotes({ vault_id: v.id, search: '长文卡' })[0];
    // 正文超长关键词不在截断后的 search_text 里（100k 截断）
    expect(core.vaults.listNotes({ vault_id: v.id, search: '尾部标记唯一token' })).toHaveLength(0);
    const t0 = Date.now();
    const d = core.vaults.getNote(v.id, row.rel_path);
    const readMs = Date.now() - t0;
    expect(d.markdown).toContain('尾部标记唯一token'); // 阅读读全文
    expect(readMs).toBeLessThan(3000); // 渲染 500KB 在 3s 内
  });

  it('超长标题与超长母稿导出', () => {
    const longTitle = `${'题'.repeat(200)}`;
    const c = core.media.addContent({ title: longTitle, master_content: 'm'.repeat(1024 * 1024) });
    const out = core.media.exportPackage(c.id, join(dir, 'long-export'));
    const master = readFileSync(join(out.dir, 'master.md'), 'utf8');
    expect(master.length).toBeGreaterThan(1024 * 1024);
    expect(out.dir.split('/').pop()!.length).toBeLessThan(80); // 目录名有截断
  });

  it('CRLF 与无闭合 frontmatter 不炸（整文为正文）', () => {
    const [v] = core.vaults.list().filter((x) => x.root_path === realpathSync(vaultDir));
    writeNote('knowledge/moc/crlf卡.md', '---\r\nstatus: active\r\n---\r\n\r\nCRLF 内容 [[首页]]。\r\n');
    core.vaults.scan(v.id);
    const d = core.vaults.getNote(v.id, 'knowledge/moc/crlf卡.md');
    expect(d.note.status).toBe('active');
    expect(d.links[0]?.raw_target).toBe('首页');
    writeNote('knowledge/moc/无闭合.md', '---\n未闭合 frontmatter 直接跟正文');
    core.vaults.scan(v.id);
    const d2 = core.vaults.getNote(v.id, 'knowledge/moc/无闭合.md');
    expect(d2.markdown).toContain('未闭合');
  });
});
