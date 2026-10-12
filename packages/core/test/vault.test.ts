// 知识库 vault 服务测试：注册/扫描/增量/缺失/搜索/阅读/链接解析/概念关联/安全边界
// 全程使用临时 vault 夹具（复制进临时目录），绝不触碰 ~/Desktop/knowledge-base。
import { mkdirSync, mkdtempSync, rmSync, renameSync, symlinkSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openNodeSqliteDb } from '../src/adapters/node-sqlite';
import { createCore, renderMarkdownHtml, type TodoDeskCore } from '../src/index';
import { todayStr } from '../src/utils/date';

let dir: string;
let core: TodoDeskCore;
let vaultDir: string;

const writeNote = (rel: string, text: string) => {
  const abs = join(vaultDir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, text, 'utf8');
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tododesk-vault-test-'));
  vaultDir = join(dir, 'vault');
  // 夹具 vault：MOC + 三级资源卡 + 待审卡 + raw
  writeNote(
    'knowledge/moc/首页.md',
    `---
title: 首页
type: moc
---
导航首页，见 [[知识库价值公式]] 与 [[后端与存储]]。`,
  );
  writeNote(
    'knowledge/resources/fa/知识库价值公式.md',
    `---
type: 知识卡片
level: fa
direction: 后端
status: active
created: 2026-09-18
tags: [知识库, 方法论]
---
一句话核心：知识库的价值 = 沉淀 × 复用。

## 适用场景
- 项目复盘
- [[首页]]

## 边界
不适用于纯流水记录。`,
  );
  writeNote('knowledge/resources/dao/显式意图优先.md', '---\nstatus: active\n---\n道：显式意图优先于自动分类。');
  writeNote('knowledge/inbox-cards/AI三角色学习系统.md', '---\nstatus: draft\n---\n待审草稿，关联 [[首页]]。');
  writeNote('raw/某原料.md', '原始原料，不该被默认索引。');
  const db = openNodeSqliteDb(join(dir, 'test.db'));
  core = createCore(db, { dbPath: join(dir, 'test.db') });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('vault 注册与扫描', () => {
  it('注册不存在的目录报错', () => {
    expect(() => core.vaults.register({ root_path: join(dir, 'nope') })).toThrow('目录不存在');
  });

  it('注册 → 默认不索引 raw → 扫描入库', () => {
    const v = core.vaults.register({ root_path: vaultDir, name: '测试库' });
    expect(v.include_dirs).toEqual(['knowledge/moc', 'knowledge/resources', 'knowledge/inbox-cards']);
    expect(v.include_raw).toBe(false);
    const stats = core.vaults.scan(v.id);
    expect(stats.discovered).toBe(4); // moc1 + resources2 + inbox1（raw 不含）
    expect(stats.updated).toBe(4);
    expect(stats.missing).toBe(0);
    const notes = core.vaults.listNotes({ vault_id: v.id });
    expect(notes).toHaveLength(4);
    expect(notes.every((n) => !n.missing)).toBe(true);
  });

  it('重复注册同一根报错（幂等保护）', () => {
    expect(() => core.vaults.register({ root_path: vaultDir })).toThrow('已注册');
  });

  it('kind/level/status/标题/frontmatter 正确推导', () => {
    const [v] = core.vaults.list();
    const card = core.vaults.listNotes({ vault_id: v.id, kind: 'card', search: '价值公式' })[0];
    expect(card.level).toBe('fa');
    expect(card.status).toBe('active');
    expect(card.title).toBe('知识库价值公式');
    expect(card.frontmatter.tags).toEqual(['知识库', '方法论']);
    const draft = core.vaults.listNotes({ vault_id: v.id, kind: 'draft' })[0];
    expect(draft.status).toBe('draft');
    const moc = core.vaults.listNotes({ vault_id: v.id, kind: 'moc' })[0];
    expect(moc.title).toBe('首页');
  });

  it('增量扫描：同内容重扫 unchanged；改动后 updated；删除后 missing 且不删记录', () => {
    const [v] = core.vaults.list();
    const again = core.vaults.scan(v.id);
    expect(again.updated).toBe(0);
    expect(again.unchanged).toBe(4);

    writeNote('knowledge/resources/fa/知识库价值公式.md', '---\nstatus: active\n---内容已改，链接 [[首页]]。');
    const afterEdit = core.vaults.scan(v.id);
    expect(afterEdit.updated).toBe(1);

    rmSync(join(vaultDir, 'knowledge/resources/dao/显式意图优先.md'));
    const afterDelete = core.vaults.scan(v.id);
    expect(afterDelete.missing).toBe(1);
    const gone = core.vaults.listNotes({ vault_id: v.id, search: '显式意图' })[0];
    expect(gone.missing).toBe(true);
    // 记录保留：关联历史不丢
    expect(core.vaults.listNotes({ vault_id: v.id, missing: true })).toHaveLength(1);
  });

  it('touch（mtime 变内容不变）不产生 updated', () => {
    const [v] = core.vaults.list();
    const p = join(vaultDir, 'knowledge/moc/首页.md');
    const t = new Date(Date.now() + 5000);
    utimesSync(p, t, t);
    const s = core.vaults.scan(v.id);
    expect(s.updated).toBe(0);
  });

  it('include_raw 开启后 raw 入索引', () => {
    const [v] = core.vaults.list();
    core.vaults.update(v.id, { include_raw: true });
    const s = core.vaults.scan(v.id);
    expect(s.discovered).toBe(4); // 剩余3 + raw1（显式意图已删）
    const raws = core.vaults.listNotes({ vault_id: v.id, kind: 'raw' });
    expect(raws).toHaveLength(1);
    core.vaults.update(v.id, { include_raw: false });
    core.vaults.scan(v.id);
  });
});

describe('vault 阅读与链接', () => {
  it('阅读正文 + 渲染 HTML + 解析 wikilink 与反向链接', () => {
    const [v] = core.vaults.list();
    const detail = core.vaults.getNote(v.id, 'knowledge/moc/首页.md');
    expect(detail.markdown).toContain('导航首页');
    expect(detail.html).toContain('<span class="wl" data-wikilink="知识库价值公式"');
    expect(detail.html).not.toContain('<script');
    // [[知识库价值公式]] 解析成功
    const resolved = detail.links.find((l) => l.raw_target.includes('知识库价值公式'));
    expect(resolved?.resolved?.rel_path).toBe('knowledge/resources/fa/知识库价值公式.md');
    // 断链：后端与存储 不存在
    const broken = detail.links.find((l) => l.raw_target === '后端与存储');
    expect(broken?.resolved).toBeNull();
    expect(broken?.candidates).toHaveLength(0);
    // 反链：价值公式卡（改动后仍链 [[首页]]）→ 首页 backlinks
    expect(detail.backlinks.map((b) => b.rel_path)).toContain('knowledge/resources/fa/知识库价值公式.md');
  });

  it('内容手改未重扫时 stale=true', () => {
    const [v] = core.vaults.list();
    writeNote('knowledge/moc/首页.md', '---\ntitle: 首页\n---手改未重扫。');
    const detail = core.vaults.getNote(v.id, 'knowledge/moc/首页.md');
    expect(detail.stale).toBe(true);
    expect(detail.markdown).toContain('手改未重扫');
    core.vaults.scan(v.id); // 恢复索引一致性
    expect(core.vaults.getNote(v.id, 'knowledge/moc/首页.md').stale).toBe(false);
  });

  it('路径安全：越界/绝对路径/符号链接拒绝', () => {
    const [v] = core.vaults.list();
    expect(() => core.vaults.getNote(v.id, '../outside.md')).toThrow('不安全');
    expect(() => core.vaults.getNote(v.id, '/etc/passwd')).toThrow('不安全');
    // 符号链接文件：拒绝读取
    writeNote('knowledge/resources/qi/真卡.md', '真卡。');
    symlinkSync(join(vaultDir, 'knowledge/resources/fa/知识库价值公式.md'), join(vaultDir, 'knowledge/resources/qi/链接卡.md'));
    core.vaults.scan(v.id);
    expect(() => core.vaults.getNote(v.id, 'knowledge/resources/qi/链接卡.md')).toThrow('符号链接');
    // 目录符号链接同样在 walk 中被跳过
    const s = core.vaults.scan(v.id);
    expect(s.skipped).toBeGreaterThanOrEqual(1);
  });
});

describe('概念关联（knowledge_key ↔ 卡片）', () => {
  it('关联/查询/去重/解除，只写 TodoDesk 库', () => {
    const [v] = core.vaults.list();
    const link = core.vaults.linkConcept({
      vault_id: v.id,
      rel_path: 'knowledge/resources/fa/知识库价值公式.md',
      knowledge_key: 'kb/value-formula',
    });
    expect(link.knowledge_key).toBe('kb/value-formula');
    expect(() =>
      core.vaults.linkConcept({
        vault_id: v.id,
        rel_path: 'knowledge/resources/fa/知识库价值公式.md',
        knowledge_key: 'kb/value-formula',
      }),
    ).toThrow('请勿重复关联');
    // 同概念可关联第二张卡
    core.vaults.linkConcept({ vault_id: v.id, rel_path: 'knowledge/resources/qi/真卡.md', knowledge_key: 'x' });
    expect(core.vaults.listConceptLinks({ knowledge_key: 'kb/value-formula' })).toHaveLength(1);
    const byNote = core.vaults.listConceptLinks({});
    expect(byNote.length).toBeGreaterThanOrEqual(2);
    core.vaults.unlinkConcept(link.id);
    expect(core.vaults.listConceptLinks({ knowledge_key: 'kb/value-formula' })).toHaveLength(0);
    // vault 文件未被写入（正文依旧无 knowledge_key 痕迹）
    const detail = core.vaults.getNote(v.id, 'knowledge/resources/fa/知识库价值公式.md');
    expect(detail.markdown).not.toContain('kb/value-formula');
  });
});

describe('Markdown 渲染安全', () => {
  it('脚本/事件属性/危险协议不可能出现在输出中', () => {
    const html = renderMarkdownHtml(
      '<script>alert(1)</script>\n\n<img src="javascript:alert(2)">\n\n[点我](javascript:alert(3))\n\n<button onclick="x()">按钮</button>',
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onclick="');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<a ');
    expect(html).toContain('&lt;script&gt;');
  });

  it('表格/代码块/图片占位', () => {
    const html = renderMarkdownHtml('| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n\n![封面](attachments/a.png)');
    expect(html).toContain('<table>');
    expect(html).toContain('<pre');
    expect(html).toContain('[图片未加载]');
  });
});

// 同一临时 vault 的演进回归：新增、改名，以及 vault 变动与学习复习数据的组合隔离。
// 行为约定（与实现一致，不承诺未实现的能力）：改名后旧索引标缺失并保留记录与概念关联，
// 新路径作为新笔记；关联不自动转移，需在新路径上重新手动关联。
describe('vault 演进：新增 / 改名 / 学习数据隔离', () => {
  it('同一 vault 新增笔记：重扫恰入一条新索引；未扫描前关联明确指引先扫描（不静默入索引）', () => {
    const [v] = core.vaults.list();
    const base = core.vaults.scan(v.id); // 基线归一：此前各 describe 的增量变化全部落定
    expect(base.updated).toBe(0);
    expect(base.missing).toBe(0);

    writeNote('knowledge/resources/shu/增量卡.md', '---\nstatus: active\n---\n新增卡片，链接 [[首页]]。');
    // 文件已在盘上但未入索引：关联被明确拒绝并指引先扫描（不会替用户悄悄建索引）
    expect(() =>
      core.vaults.linkConcept({
        vault_id: v.id,
        rel_path: 'knowledge/resources/shu/增量卡.md',
        knowledge_key: 'kb/incremental',
      }),
    ).toThrow('请先扫描');

    const s = core.vaults.scan(v.id);
    expect(s.discovered).toBe(base.discovered + 1);
    expect(s.updated).toBe(1);
    expect(s.missing).toBe(0);
    const note = core.vaults.listNotes({ vault_id: v.id, search: '增量卡' })[0];
    expect(note.missing).toBe(false);
    expect(note.level).toBe('shu');
    expect(core.vaults.getNote(v.id, note.rel_path).markdown).toContain('新增卡片');

    // 入索引后关联成功；再次重扫全量 unchanged（索引稳定）
    const link = core.vaults.linkConcept({
      vault_id: v.id,
      rel_path: 'knowledge/resources/shu/增量卡.md',
      knowledge_key: 'kb/incremental',
    });
    expect(link.note_id).toBe(note.id);
    const again = core.vaults.scan(v.id);
    expect(again.updated).toBe(0);
    expect(again.missing).toBe(0);
  });

  it('改名：旧索引标缺失并保留概念关联，新路径作为新笔记、关联不自动转移', () => {
    const [v] = core.vaults.list();
    renameSync(
      join(vaultDir, 'knowledge/resources/shu/增量卡.md'),
      join(vaultDir, 'knowledge/resources/shu/改名后.md'),
    );
    const s = core.vaults.scan(v.id);
    expect(s.updated).toBe(1); // 新路径 = 新笔记
    expect(s.missing).toBe(1); // 旧路径 = 标缺失

    const old = core.vaults.listNotes({ vault_id: v.id, missing: true, search: '增量卡' })[0];
    expect(old.rel_path).toBe('knowledge/resources/shu/增量卡.md');
    const fresh = core.vaults.listNotes({ vault_id: v.id, search: '改名后' })[0];
    expect(fresh.missing).toBe(false);
    expect(fresh.id).not.toBe(old.id); // 新行，不顶替旧记录

    // 概念关联保留在旧（缺失）笔记上，不自动转移到新路径
    const links = core.vaults.listConceptLinks({ knowledge_key: 'kb/incremental' });
    expect(links).toHaveLength(1);
    expect(links[0].note_id).toBe(old.id);
    expect(core.vaults.getNote(v.id, fresh.rel_path).concept_links).toHaveLength(0);

    // 磁盘上文件已不在旧路径：阅读明确报错，但库内记录与关联仍可查
    expect(() => core.vaults.getNote(v.id, old.rel_path)).toThrow('笔记不存在');
  });

  it('组合回归：vault 新增/缺失不改写学习计划、复习待办、会话与掌握度；关联随缺失保留', () => {
    const [v] = core.vaults.list();
    // 以同一 knowledge_key 串起学习侧数据与 vault 概念关联
    const key = 'kb/value-formula';
    const link = core.vaults.linkConcept({
      vault_id: v.id,
      rel_path: 'knowledge/resources/fa/知识库价值公式.md',
      knowledge_key: key,
    });
    const today = todayStr();
    const plan = core.plans.create({
      title: '价值公式复习',
      start_date: today,
      items: [{ date: today, content: '复述价值公式', item_type: 'review', duration_min: 15, knowledge_key: key }],
    });
    const session = core.study.recordSession({
      id: 'sess-kb-regression',
      plan_id: plan.id,
      plan_item_id: plan.items[0].id,
      knowledge_key: key,
      actual_minutes: 15,
      explanation: '复述：价值 = 沉淀 × 复用',
    });
    const planBefore = JSON.stringify(core.plans.get(plan.id));
    const masteryBefore = JSON.stringify(core.study.getMastery({ knowledge_keys: [key] }));
    const todosBefore = core.todos.list({ status: 'all' }).length;

    // vault 侧演进：删除已关联的卡 + 新增导航页 + 重扫（索引/缺失状态发生变化）
    rmSync(join(vaultDir, 'knowledge/resources/fa/知识库价值公式.md'));
    writeNote('knowledge/moc/新导航.md', '新导航页。');
    const s = core.vaults.scan(v.id);
    expect(s.updated).toBe(1);
    expect(s.missing).toBe(1);

    // 学习复习历史一字未动：计划条目、复习待办、会话、掌握度全部原样
    expect(JSON.stringify(core.plans.get(plan.id))).toBe(planBefore);
    expect(JSON.stringify(core.study.getMastery({ knowledge_keys: [key] }))).toBe(masteryBefore);
    const sessions = core.study.listSessions({ knowledge_key: key });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(session.id);
    expect(sessions[0].explanation).toBe('复述：价值 = 沉淀 × 复用');
    expect(core.todos.list({ status: 'all' })).toHaveLength(todosBefore);
    // 概念关联随缺失保留（记录不删，恢复同路径时行复用见 kb-media-edge）
    const links = core.vaults.listConceptLinks({ knowledge_key: key });
    expect(links).toHaveLength(1);
    expect(links[0].id).toBe(link.id);
    const gone = core.vaults.listNotes({ vault_id: v.id, missing: true, search: '知识库价值公式' })[0];
    expect(gone.missing).toBe(true);
    expect(gone.id).toBe(link.note_id);
  });
});
