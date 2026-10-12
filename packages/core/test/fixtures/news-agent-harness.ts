// 跨进程新闻任务测试夹具（真实独立进程 + 同一临时 SQLite 文件）：
// roles:
//   claim <dbPath> <taskId|-> <by>          认领任务（- 表示取最早待执行），输出 JSON
//   submit <dbPath> <taskId> <token> <n>    向任务提交 n 条（各不相同的合法条目），输出 JSON
//   release <dbPath> <taskId> <token> <reason>  释放认领回待执行，输出 JSON
//   claim-and-exit <dbPath> <taskId> <by>   认领后即退出（模拟执行进程崩溃，认领留在库中）
// 注意：不用 process.exit 立即退出（会截断管道 stdout 且跳过 finally 的关库），
// 一律设 process.exitCode 让进程自然退出；成功 0 / 业务失败 1 / 参数失败 2 / 隔离断言失败 3。
import { openNodeSqliteDb } from '../../src/adapters/node-sqlite';
import { createCore } from '../../src/index';
import type { NewsSubmissionItem } from '../../src/types';

const [role, dbPath, a1, a2, a3] = process.argv.slice(2);

// 夹具内置隔离断言：dbPath 必须位于临时碰撞区（缺失/不符即退出码 3，拒绝碰真实库）
if (!dbPath || !dbPath.includes('tododesk-collision-')) {
  console.error(JSON.stringify({ ok: false, error: `夹具断言失败：dbPath 不在临时碰撞区（${dbPath ?? '缺失'}）` }));
  process.exit(3);
}

const H = 3600_000;
// 进程级随机段：不同子进程/不同轮次的条目互不重样（避免跨用例撞去重）
const RUN = Math.random().toString(36).slice(2, 8);
const item = (i: number): NewsSubmissionItem => ({
  title: `跨进程新闻 ${RUN}-${i}`,
  summary: `第 ${i} 条摘要，发布于一小时前。`,
  source_url: `https://example.com/cross/${a1}/${RUN}/${i}`,
  source_name: 'Example',
  published_at: new Date(Date.now() - H).toISOString(),
});

const core = createCore(openNodeSqliteDb(dbPath), { dbPath });
let code = 0;
let payload: unknown;
if (role !== 'claim' && role !== 'submit' && role !== 'release' && role !== 'claim-and-exit') {
  payload = { ok: false, error: `未知角色 ${role}` };
  code = 2;
} else {
  try {
    if (role === 'claim') {
      const id = a1 === '-' ? undefined : Number(a1);
      const res = core.news.claimTask(id, a2 ?? 'cross-agent');
      payload = { ok: true, task_id: res.task.id, claim_token: res.claim_token, attempts: res.task.attempts };
    } else if (role === 'submit') {
      const n = Math.max(1, Math.min(10, Number(a3 ?? 1)));
      const res = core.news.submitItems(Number(a1), String(a2), Array.from({ length: n }, (_, i) => item(i)));
      payload = { ok: true, inserted: res.inserted, inserted_count: res.task.inserted_count };
    } else if (role === 'release') {
      core.news.releaseTask(Number(a1), String(a2), a3);
      payload = { ok: true, released: true };
    } else {
      // 认领成功即结束（不释放）——模拟执行方崩溃：租约留在库里等待过期
      core.news.claimTask(Number(a1), a2 ?? 'crashed-agent');
      payload = { ok: true, crashed: true };
    }
  } catch (e) {
    payload = { ok: false, error: e instanceof Error ? e.message : String(e) };
    code = 1;
  }
}
core.db.close();
console.log(JSON.stringify(payload));
process.exitCode = code;
