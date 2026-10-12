// 双进程确定性对撞回归（真实独立进程 + 同一临时 SQLite 文件；agent-only 语义）：
// 1. 并发认领对撞：两个进程同时认领同一任务 → 恰好一个成功（CAS + BEGIN IMMEDIATE）；
// 2. 提交与预算跨进程一致：胜者提交，败者令牌无效；
// 3. 崩溃恢复：认领后进程消失 → 租约过期 → 另一进程重新认领接力（attempts 累计），预算不重置。
// 每个子进程显式三件套 HOME+TODODESK_DB+TODODESK_USER_DATA（夹具内置路径断言，缺失/不符即退出码 3）。
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import { openNodeSqliteDb } from '../src/adapters/node-sqlite';
import { createCore } from '../src/index';

const here = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE = join(here, 'fixtures/news-agent-harness.ts');

let dir = '';
let harness = '';
let dbPath = '';
const children: ChildProcess[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tododesk-collision-'));
  harness = join(dir, 'harness.cjs');
  await build({
    entryPoints: [FIXTURE],
    outfile: harness,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['node:*'],
    logLevel: 'silent',
  });
  dbPath = join(dir, 'collision.db');
  // 初始化库（schema + 迁移），随后关闭，只留给子进程使用；dbPath 必传（资产根随临时 DB）
  const core = createCore(openNodeSqliteDb(dbPath), { dbPath });
  core.news.createTask({ title: '对撞任务', max_items: 10 }); // id=1：并发认领对撞用
  core.news.createTask({ title: '崩溃恢复任务', max_items: 10 }); // id=2：认领后进程消失用
  core.db.close();
}, 60_000);

afterAll(() => {
  for (const c of children) {
    if (!c.killed) c.kill('SIGKILL');
  }
  rmSync(dir, { recursive: true, force: true });
});

/** 三件套显式隔离 + 硬断言（隔离缺失即拒绝启动） */
const env = (): NodeJS.ProcessEnv => {
  const e = { PATH: process.env.PATH, HOME: dir, TODODESK_DB: dbPath, TODODESK_USER_DATA: join(dir, 'userData') };
  if (e.TODODESK_DB !== dbPath || !e.HOME?.startsWith(tmpdir()) || !e.TODODESK_USER_DATA?.startsWith(tmpdir())) {
    throw new Error('子进程环境断言失败（隔离缺失即拒绝启动）');
  }
  return e as NodeJS.ProcessEnv;
};

const run = (args: string[]): Promise<{ code: number; json: any }> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [harness, ...args], { env: env() });
    children.push(child);
    let text = '';
    let err = '';
    child.stdout.on('data', (d) => (text += String(d)));
    child.stderr.on('data', (d) => (err += String(d)));
    child.on('close', (code) => {
      try {
        resolve({ code: Number(code), json: JSON.parse(text.trim().split('\n').pop() ?? '{}') });
      } catch {
        resolve({ code: Number(code), json: { ok: false, error: `无法解析子进程输出：${text.slice(0, 200)}｜stderr：${err.slice(0, 300)}` } });
      }
    });
  });

const newsCount = (): number => {
  const db = new DatabaseSync(dbPath);
  try {
    return Number((db.prepare('SELECT COUNT(*) AS n FROM news').get() as { n: number }).n);
  } finally {
    db.close();
  }
};

const expireLease = (taskId: number): void => {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("UPDATE news_tasks SET claim_expires_at = '2000-01-01T00:00:00.000' WHERE id = ?").run(taskId);
  } finally {
    db.close();
  }
};

it('并发认领对撞：两个真实进程同时认领，恰好一个成功；败者令牌提交被拒', async () => {
  const [r1, r2] = await Promise.all([run(['claim', dbPath, '1', 'agent-1']), run(['claim', dbPath, '1', 'agent-2'])]);
  const codes = [r1.code, r2.code].sort();
  expect(codes).toEqual([0, 1]); // 恰好一个成功
  const winner = r1.code === 0 ? r1 : r2;
  const loser = r1.code === 0 ? r2 : r1;
  expect(winner.json.ok).toBe(true);
  expect(winner.json.attempts).toBe(1);
  expect(loser.json.ok).toBe(false);
  expect(String(loser.json.error)).toContain('认领');

  // 胜者提交 3 条成功；败者（并发窗口内拿不到令牌）用胜者之外的任何 token 都会被拒
  const submit = await run(['submit', dbPath, String(winner.json.task_id), String(winner.json.claim_token), '3']);
  expect(submit.code).toBe(0);
  expect(submit.json.inserted).toBe(3);
  expect(newsCount()).toBe(3);
  const badToken = await run(['submit', dbPath, String(winner.json.task_id), '00000000-0000-0000-0000-000000000000', '1']);
  expect(badToken.code).toBe(1);
  expect(String(badToken.json.error)).toContain('令牌');
  expect(newsCount()).toBe(3);
}, 60_000);

it('崩溃恢复：认领进程消失 → 租约过期 → 另一进程接力（attempts 累计，预算不重置）', async () => {
  const crash = await run(['claim-and-exit', dbPath, '2', 'crashed-agent']);
  expect(crash.code).toBe(0);
  // 崩溃后任务卡在 claimed：立即认领会被拒
  const tooSoon = await run(['claim', dbPath, '2', 'next-agent']);
  expect(tooSoon.code).toBe(1);
  expect(String(tooSoon.json.error)).toContain('已被');
  // 租约过期（等价于 30 分钟无人提交）→ 接力成功，预算沿用（任务 2 全新，从 0 计）
  expireLease(2);
  const next = await run(['claim', dbPath, '2', 'next-agent']);
  expect(next.code).toBe(0);
  expect(next.json.attempts).toBe(2);
  const submit = await run(['submit', dbPath, '2', String(next.json.claim_token), '4']);
  expect(submit.code).toBe(0);
  expect(submit.json.inserted_count).toBe(4);
  // 释放 → 再接力：已入库 4 条计入累计预算
  const release = await run(['release', dbPath, '2', String(next.json.claim_token), '接力中断']);
  expect(release.code).toBe(0);
  const again = await run(['claim', dbPath, '2', 'third-agent']);
  expect(again.code).toBe(0);
  expect(again.json.attempts).toBe(3);
  const over = await run(['submit', dbPath, '2', String(again.json.claim_token), '7']);
  expect(over.code).toBe(1); // 4 + 7 > 10：整批拒绝，重复提交无法绕过预算
  expect(String(over.json.error)).toContain('预算');
  const fill = await run(['submit', dbPath, '2', String(again.json.claim_token), '6']);
  expect(fill.code).toBe(0);
  expect(fill.json.inserted_count).toBe(10);
}, 60_000);
