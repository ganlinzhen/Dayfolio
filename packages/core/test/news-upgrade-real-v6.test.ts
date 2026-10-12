// 真实 v6 库升级验证（定向、按需）：TODODESK_VERIFY_REAL_DB=<真实库绝对路径> 时运行，否则跳过。
// 红线：
// - 真库只读——快照用 SQLite 官方 backup API（sqlite3 -readonly + .backup）取得**页级一致副本**，
//   逐文件 cp 主库/WAL/SHM 不是原子快照（活库期间可能撕裂），已弃用；
// - 若无法安全取得一致副本，本用例直接失败并如实说明，绝不退回 cp 方式宣称验证通过；
// - 迁移与全部写操作只发生在临时副本上。
// 断言：关键表计数逐项比对（news 46/收藏 0/已读 0、plans 2/items 19 等）、46 条新闻逐行一致、
// v7+v8 迁移后零丢失、integrity_check/foreign_key_check 通过、agent 任务链在升级副本上可用。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openNodeSqliteDb } from '../src/adapters/node-sqlite';
import { createCore } from '../src/index';

const REAL_DB = process.env.TODODESK_VERIFY_REAL_DB?.trim() || '';

/** 关键表清单（真实库 v6 实测基线；若用户日常使用后计数变化，按提示更新 EXPECTED 即可） */
const COUNTED_TABLES = [
  'todos', 'study_plans', 'plan_items', 'checkins', 'study_plan_drafts', 'plan_adjustments',
  'study_sessions', 'study_assessments', 'card_exports', 'courses', 'course_lessons', 'course_requests',
  'news_sources', 'news_topics', 'news_sync_runs',
] as const;

/** 2026-10-11 实测基线（WAL 一致快照上读取） */
const EXPECTED_COUNTS: Record<string, number> = {
  todos: 20, study_plans: 2, plan_items: 19, checkins: 4, study_plan_drafts: 0, plan_adjustments: 0,
  study_sessions: 0, study_assessments: 0, card_exports: 0, courses: 1, course_lessons: 1, course_requests: 0,
  news_sources: 3, news_topics: 0, news_sync_runs: 0,
};
const EXPECTED_NEWS = { total: 46, starred: 0, read: 0 };

interface Snapshot {
  version: number;
  news: number;
  starred: number;
  read: number;
  tableCounts: Record<string, number>;
  rows: Array<{ id: number; title: string; url: string; is_starred: number; is_read: number; dedup_key: string }>;
}

const snapshotOf = (dbPath: string): Snapshot => {
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db
      .prepare('SELECT id, title, url, is_starred, is_read, dedup_key FROM news ORDER BY id')
      .all() as Array<{ id: number; title: string; url: string; is_starred: number; is_read: number; dedup_key: string }>;
    const tableCounts: Record<string, number> = {};
    for (const t of COUNTED_TABLES) {
      tableCounts[t] = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
    }
    return {
      version: Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version),
      news: rows.length,
      starred: rows.filter((r) => r.is_starred === 1).length,
      read: rows.filter((r) => r.is_read === 1).length,
      tableCounts,
      rows,
    };
  } finally {
    db.close();
  }
};

describe('真实 v6 库 → v8 升级（SQLite backup API 一致快照；未设 TODODESK_VERIFY_REAL_DB 时跳过）', () => {
  it.skipIf(!REAL_DB || !existsSync(REAL_DB))('官方 backup 快照：关键表计数逐项比对零丢失；迁移后完整性通过；任务链可用', () => {
    // 防呆：目标必须是明确指定的真实库路径（拒绝临时区/默认误填）
    expect(REAL_DB.endsWith('tododesk.db')).toBe(true);
    expect(REAL_DB.includes(tmpdir())).toBe(false);

    const dir = mkdtempSync(join(tmpdir(), 'tododesk-upgrade-verify-'));
    const copy = join(dir, 'snapshot.db');
    try {
      // ---------- 取一致快照：SQLite 官方 backup API（源连接只读；页级一致，含 WAL 内容折叠） ----------
      try {
        execFileSync('sqlite3', ['-readonly', REAL_DB, `.backup '${copy}'`], { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        throw new Error(
          `无法安全取得一致副本（sqlite3 -readonly .backup 失败：${e instanceof Error ? e.message : String(e)}）——本次升级验证未完成，不宣称验证通过；不得退回逐文件 cp 方式`,
        );
      }
      expect(existsSync(copy)).toBe(true);
      const before = snapshotOf(copy);
      // eslint-disable-next-line no-console
      console.info('[news-upgrade-real-v6] 快照基线：', JSON.stringify({ version: before.version, news: before.news, starred: before.starred, read: before.read, ...before.tableCounts }));

      // 基线断言（漂移即失败并提示更新，而不是静默放过）
      expect(before.version).toBe(6);
      expect(before.news).toBe(EXPECTED_NEWS.total);
      expect(before.starred).toBe(EXPECTED_NEWS.starred);
      expect(before.read).toBe(EXPECTED_NEWS.read);
      for (const [table, n] of Object.entries(EXPECTED_COUNTS)) {
        expect(before.tableCounts[table], `基线漂移：${table} 预期 ${n} 实得 ${before.tableCounts[table]}（用户日常使用会改变计数，请按最新只读快照更新 EXPECTED_COUNTS 后重跑）`).toBe(n);
      }

      // ---------- 在快照副本上组装 core：v6 → v7（vault/media）→ v8（news_tasks + news 列） ----------
      const db = openNodeSqliteDb(copy);
      const core = createCore(db, { dbPath: copy });
      try {
        const after = snapshotOf(copy);
        expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBeGreaterThanOrEqual(8);
        // 关键表计数逐项零丢失
        expect(after.news).toBe(before.news);
        expect(after.starred).toBe(before.starred);
        expect(after.read).toBe(before.read);
        for (const t of COUNTED_TABLES) {
          expect(after.tableCounts[t], `${t} 计数变化`).toBe(before.tableCounts[t]);
        }
        // 新闻逐行比对（标题/链接/去重键/收藏/已读）
        expect(after.rows).toEqual(before.rows);
        // 旧行未被补写 agent 字段
        expect(core.news.list({ limit: 500 }).every((n) => n.task_id === null && n.source_name === null)).toBe(true);

        // agent 任务链在升级副本上完整可用
        const task = core.news.createTask({ title: '升级验证：近 24 小时新闻', instructions: '验证用', max_items: 5 });
        const claim = core.news.claimTask(task.id, 'upgrade-verify');
        const res = core.news.submitItems(task.id, claim.claim_token, [
          { title: `升级验证新闻甲 ${Date.now()}`, summary: '升级副本上的验证条目甲。', source_url: 'https://example.com/upgrade-verify-1', published_at: new Date(Date.now() - 3600_000).toISOString() },
          { title: `升级验证新闻乙 ${Date.now()}`, summary: '升级副本上的验证条目乙。', source_url: 'https://example.com/upgrade-verify-2', published_at: new Date(Date.now() - 7200_000).toISOString() },
        ]);
        expect(res.inserted).toBe(2);
        // 24h 视图：新条目可见；历史视图：46 旧 + 2 新，不受任务 10 条预算限制
        expect(core.news.list({ since: new Date(Date.now() - 24 * 3600_000).toISOString(), limit: 500 }).length).toBeGreaterThanOrEqual(2);
        expect(core.news.list({ limit: 500 }).length).toBe(before.news + 2);
        expect(core.news.completeTask(task.id, claim.claim_token, '升级验证完成').status).toBe('completed');
        // 旧收藏依旧可查
        expect(core.news.list({ filter: 'starred', limit: 500 }).length).toBe(before.starred);
        // SQLite 完整性：迁移与任务链写完后，库级完整性/外键一致
        expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
        expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// 自检提示：未设置环境变量时打印一次说明（避免误以为已验证）
if (!REAL_DB) {
  // eslint-disable-next-line no-console
  console.info('[news-upgrade-real-v6] 未设置 TODODESK_VERIFY_REAL_DB，跳过真实库升级验证（定向运行：TODODESK_VERIFY_REAL_DB=<真实库路径> vitest run 本文件）');
}
