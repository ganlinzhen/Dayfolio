// 统一查询规模验证：仅新建临时数据库，绝不读取或覆盖真实用户数据。
import { buildSync } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, cpus, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const work = mkdtempSync(join(tmpdir(), 'dayfolio-query-benchmark-'));
if (!resolve(work).startsWith(resolve(tmpdir())) || work.includes('Application Support')) throw new Error('临时路径校验失败');
const require = createRequire(import.meta.url);
let db;
try {
  const modulePath = join(work, 'core.cjs');
  buildSync({ entryPoints: [new URL('../packages/core/src/index.ts', import.meta.url).pathname], outfile: modulePath, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { createCore } = require(modulePath);
  const queryPath = join(work, 'query.cjs');
  buildSync({ entryPoints: [new URL('../packages/core/src/ontology/query.ts', import.meta.url).pathname], outfile: queryPath, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { createQueryService } = require(queryPath);
  const driver = process.argv.includes('--driver=better-sqlite3') ? 'better-sqlite3' : 'node:sqlite';
  const native = driver === 'better-sqlite3'
    ? new (require('better-sqlite3'))(join(work, 'benchmark.db'))
    : new (require('node:sqlite').DatabaseSync)(join(work, 'benchmark.db'));
  db = { exec: sql => { native.exec(sql); }, prepare: sql => native.prepare(sql), close: () => native.close() };
  const core = createCore(db, { dbPath: join(work, 'benchmark.db') });
  for (const [apiName, properties] of [
    ['bench_parent', [{ apiName: 'title', dataType: 'string' }, { apiName: 'status', dataType: 'enum', enumValues: ['open', 'done'] }, { apiName: 'amount', dataType: 'integer' }]],
    ['bench_tag', [{ apiName: 'title', dataType: 'string' }]],
    ['bench_edge', [{ apiName: 'parent_id', dataType: 'string' }, { apiName: 'tag_id', dataType: 'string' }]],
  ]) core.ontology.createObjectType({ apiName, title: apiName, properties });
  core.ontology.createLinkType({ apiName: 'bench_tags', title: '规模验证关联', leftType: 'bench_parent', rightType: 'bench_tag', cardinality: 'many_to_many', linkTable: 'bench_edge', backingLeftProperty: 'parent_id', backingRightProperty: 'tag_id' });
  const insertParent = db.prepare('INSERT INTO ont_obj_bench_parent(id,title,status,amount,created_at,updated_at) VALUES(?,?,?,?,?,?)');
  const insertTag = db.prepare('INSERT INTO ont_obj_bench_tag(id,title,created_at,updated_at) VALUES(?,?,?,?)');
  const insertEdge = db.prepare('INSERT INTO ont_obj_bench_edge(id,parent_id,tag_id,created_at,updated_at) VALUES(?,?,?,?,?)');
  // 批量 SQL 只用于隔离性能夹具；业务写入的正确性由 core/MCP/真实 UI 测试验证。
  db.exec('BEGIN IMMEDIATE');
  const stamp = '2026-10-16T00:00:00.000';
  for (let i = 0; i < 5; i++) insertTag.run(`t${i}`, `标签 ${i}`, stamp, stamp);
  for (let i = 0; i < 10000; i++) {
    const id = `p${String(i).padStart(5, '0')}`;
    insertParent.run(id, `对象 ${i}`, i % 2 ? 'open' : 'done', i, stamp, stamp);
    for (let tag = 0; tag < 5; tag++) insertEdge.run(`${id}_t${tag}`, id, `t${tag}`, stamp, stamp);
  }
  db.exec('COMMIT');
  let lastStatement;
  const queries = createQueryService({ ...db, prepare: sql => {
    const statement = db.prepare(sql);
    return { run: (...params) => statement.run(...params), get: (...params) => statement.get(...params), all: (...params) => {
      if (sql.startsWith('SELECT') && sql.includes('FROM "ont_obj_bench_parent" r')) lastStatement = { sql, params };
      return statement.all(...params);
    } };
  } }, core.ontology);
  const base = { version: 1, objectType: 'bench_parent' };
  const cursor = queries.list({ ...base, page: { mode: 'cursor', limit: 50 } }).page.nextCursor;
  const scenarios = {
    ordinary: () => queries.list({ ...base, includeTotal: true, page: { limit: 50 } }),
    singleHop: () => queries.list({ ...base, where: { related: { linkType: 'bench_tags', side: 'left', where: { property: 'id', op: 'eq', value: 't1' } } }, includeTotal: true, page: { limit: 50 } }),
    aggregate: () => queries.aggregate({ ...base, groupBy: ['status'], metrics: [{ op: 'count', as: 'n' }, { op: 'sum', property: 'amount', as: 'amount' }] }),
    cursor: () => queries.list({ ...base, page: { mode: 'cursor', limit: 50, cursor } }),
  };
  const timings = {};
  for (const [name, execute] of Object.entries(scenarios)) {
    for (let warmup = 0; warmup < 3; warmup++) execute();
    const values = [];
    for (let run = 0; run < 30; run++) { const start = performance.now(); execute(); values.push(performance.now() - start); }
    values.sort((a, b) => a - b);
    timings[name] = { runs: values.length, medianMs: Number(values[14].toFixed(2)), p95Ms: Number(values[28].toFixed(2)), maxMs: Number(values[29].toFixed(2)) };
  }
  scenarios.cursor();
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${lastStatement.sql}`).all(...lastStatement.params).map(row => row.detail);
  const related = scenarios.singleHop();
  if (related.total !== 10000 || related.rows.length !== 50) throw new Error('规模夹具查询结果不完整');
  const aggregate = scenarios.aggregate();
  if (aggregate.objectCount !== 10000 || aggregate.rows.reduce((n, row) => n + row.metrics.n, 0) !== 10000) throw new Error('规模夹具聚合计数错误');
  console.log(JSON.stringify({ driver, runtime: process.versions.node, electron: process.versions.electron, hardware: { cpu: cpus()[0]?.model, cores: cpus().length, memoryGiB: Math.round(totalmem() / 1024 ** 3) }, fixture: { rootObjects: 10000, tagObjects: 5, relationBackingObjects: 50000 }, timings, cursorQueryPlan: plan, targetP95Ms: 300, targetPassed: Object.values(timings).every(result => result.p95Ms < 300), isolation: '临时库已关闭并清理' }, null, 2));
} finally {
  try { db?.close(); } finally { rmSync(work, { recursive: true, force: true }); }
}
