// 真实 v8 快照 → v9（无日期专题草案）升级验收（定向、按需）：
// 源 = sqlite3 -readonly .backup 取得并经 integrity_check=ok 验证的自包含 v8 快照，
// 缺省取 linkage-20261011-172532；TODODESK_VERIFY_REAL_V8=<快照绝对路径> 可覆盖，未找到时跳过。
// 红线：
// - 原快照与真实库全程只读（本文件只 copyFileSync 读源；结束前比对源 mtime+sha256 不变）；
// - 迁移与全部写操作只发生在显式临时目录的副本上；
// - 不打印任何笔记/配置内容：断言只输出计数、列元数据与行级 sha256 摘要（失配时泄漏的也只是哈希）。
// 本文件是「真实 v8 数据副本」的唯一验收入口；合成夹具（study-topic-draft.test.ts）只覆盖一般兼容性，
// 二者不得混称。
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openNodeSqliteDb } from '../src/adapters/node-sqlite';
import { MIGRATIONS } from '../src/migrations';
import { createCore } from '../src/index';
import { addDays, todayStr } from '../src/utils/date';

// 真实 v8 快照路径只经环境变量提供（未设置即跳过本文件，不内置任何机器相关默认值）
const SOURCE = process.env.TODODESK_VERIFY_REAL_V8?.trim() || '';

const sha256 = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');

/** 草案表结构性摘要：计数 + 逐行 sha256（含 id/预算/日期/知识点/条目/假设/状态），内容不出内存 */
const draftDigests = (db: DatabaseSync): { count: number; digests: string[] } => {
  const rows = db
    .prepare(
      `SELECT id, daily_minutes, start_date, end_date, knowledge_points, items, assumptions, status, plan_id, notes, created_at, updated_at, confirmed_at, cancelled_at
       FROM study_plan_drafts ORDER BY id`,
    )
    .all() as Array<Record<string, unknown>>;
  return {
    count: rows.length,
    digests: rows.map((r) => createHash('sha256').update(JSON.stringify(r)).digest('hex')),
  };
};

const draftColumns = (db: DatabaseSync): Array<{ name: string; notnull: number }> =>
  db.prepare('PRAGMA table_info(study_plan_drafts)').all() as Array<{ name: string; notnull: number }>;

describe('真实 v8 快照 → v9 升级（自包含副本上迁移；未找到快照时跳过）', () => {
  it.skipIf(!existsSync(SOURCE))('v8 快照副本迁 v9：结构/数据零漂移、完整性通过、无日期草案链路可用、源只读未动', () => {
    // 防呆：源不得在临时区（避免拿副本当快照验收）
    expect(SOURCE.includes(tmpdir())).toBe(false);
    expect(SOURCE.endsWith('.db')).toBe(true);
    // 源必须是自包含快照：旁边不得有 -wal（有则说明并非页级一致的自包含文件，如实失败，不宣称验证通过）
    expect(existsSync(`${SOURCE}-wal`)).toBe(false);

    const sourceMtimeBefore = statSync(SOURCE).mtimeMs;
    const sourceShaBefore = sha256(SOURCE);

    const dir = mkdtempSync(join(tmpdir(), 'tododesk-v8-real-migrate-'));
    const copy = join(dir, 'tododesk-v8-copy.db');
    const before = (() => {
      copyFileSync(SOURCE, copy); // 静态自包含文件的整体拷贝（源只读）
      const db = new DatabaseSync(copy);
      try {
        // ---------- 副本基线：v8 结构与完整性 ----------
        expect(Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)).toBe(8);
        expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
        const colsBefore = draftColumns(db);
        expect(colsBefore.find((c) => c.name === 'start_date')?.notnull).toBe(1);
        expect(colsBefore.find((c) => c.name === 'daily_minutes')?.notnull).toBe(1);
        expect(colsBefore.find((c) => c.name === 'end_date')?.notnull).toBe(1);
        expect(colsBefore.some((c) => c.name === 'course_id')).toBe(false);
        return draftDigests(db);
      } finally {
        db.close();
      }
    })();
    // eslint-disable-next-line no-console
    console.info('[drafts-upgrade-real-v8] 副本基线：', JSON.stringify({ version: 8, drafts: before.count }));
    try {
      // ---------- 在副本上组装 core：执行至最新迁移 + 本体层重新校验（漂移会直接抛错） ----------
      const core = createCore(openNodeSqliteDb(copy), { dbPath: copy });
      try {
        const raw = new DatabaseSync(copy);
        try {
          expect(Number((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)).toBe(MIGRATIONS.length);
          expect(raw.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
          expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
          const colsAfter = draftColumns(raw);
          expect(colsAfter.find((c) => c.name === 'start_date')?.notnull).toBe(0);
          expect(colsAfter.find((c) => c.name === 'daily_minutes')?.notnull).toBe(0);
          expect(colsAfter.find((c) => c.name === 'end_date')?.notnull).toBe(0);
          expect(colsAfter.find((c) => c.name === 'course_id')).toBeDefined();
          // 存量草案：计数与逐行摘要零漂移；新列对旧行全为 NULL
          const after = draftDigests(raw);
          expect(after.count).toBe(before.count);
          expect(after.digests).toEqual(before.digests);
          expect(
            Number((raw.prepare('SELECT COUNT(*) AS n FROM study_plan_drafts WHERE course_id IS NOT NULL').get() as { n: number }).n),
          ).toBe(0);
        } finally {
          raw.close();
        }

        // 旧数据读取路径不受影响（只断言可读，不打印内容）
        core.study.listDrafts();
        core.plans.list();

        // ---------- 无日期草案全链路在升级副本上可用（写只发生在副本） ----------
        const plansBefore = core.plans.list().length;
        const todosBefore = core.todos.list().length;
        const draft = core.study.draftDateless({
          title: '升级验证：无日期专题',
          knowledge_points: [
            { key: 'upgrade-kp-a', name: '验证点A', est_minutes: 60, outcome: '成果A' },
            { key: 'upgrade-kp-b', name: '验证点B', est_minutes: 90, outcome: '成果B', depends_on: ['upgrade-kp-a'] },
          ],
        });
        expect(draft.start_date).toBeNull();
        expect(core.plans.list()).toHaveLength(plansBefore); // 零副作用
        expect(core.todos.list()).toHaveLength(todosBefore);

        const D0 = addDays(todayStr(), 45); // 远离库内既有计划/复习条目的干净区间
        const preview = core.study.previewDraftSchedule(draft.id, D0, 120);
        expect(preview.items).toHaveLength(2);
        // 排期/确认按当下库状态携带确认集（冲突硬校验：与重算精确一致才放行）
        const scheduled = core.study.scheduleDraft(draft.id, D0, 120, { confirmed_over_dates: preview.over_budget_dates });
        expect(scheduled.items).toHaveLength(2);
        const { plan } = core.study.confirmDraft(draft.id, {
          confirmed_over_dates: core.study.previewDraftSchedule(draft.id, D0, 120).over_budget_dates,
        });
        expect(plan.items).toHaveLength(2);
        expect(core.plans.list()).toHaveLength(plansBefore + 1);
        expect(core.todos.list().filter((t) => t.source === 'plan').length).toBeGreaterThanOrEqual(2);

        // 迁移+链路写完后库级完整性仍通过
        const chk = new DatabaseSync(copy);
        try {
          expect(chk.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
        } finally {
          chk.close();
        }
      } finally {
        core.db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      // ---------- 源只读证据：快照 mtime 与 sha256 全程不变 ----------
      expect(statSync(SOURCE).mtimeMs).toBe(sourceMtimeBefore);
      expect(sha256(SOURCE)).toBe(sourceShaBefore);
    }
  });
});

if (!existsSync(SOURCE)) {
  // eslint-disable-next-line no-console
  console.info('[drafts-upgrade-real-v8] 未找到真实 v8 快照，跳过（定向运行：TODODESK_VERIFY_REAL_V8=<快照路径> vitest run 本文件）');
}
