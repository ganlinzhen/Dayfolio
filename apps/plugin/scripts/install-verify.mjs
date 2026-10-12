#!/usr/bin/env node
// 插件安装验收：把 apps/plugin 复制到临时安装目录，逐一验证
//   迁移（全新位置全量验收，证明无硬编码路径；MCP 按宿主约定解析 ${CLAUDE_PLUGIN_ROOT} 从异地 cwd 实际读写）、
//   冲突（不安全文件名/相对路径 MCP 声明/缺上游 LICENSE/双宿主清单漂移）、缺组件（任一组件缺失）、
//   版本（非语义化版本）、schema（非法 JSON）、bundle 陈旧（插件内 mcp-server.cjs 与 apps/mcp 最新构建不一致）。
// 红线：只在临时目录/临时库运行；绝不写 ~/.agents、~/.zcode 或真实 TodoDesk 数据；
//       任何子进程启动前显式断言环境中不存在指向非临时路径的 TODODESK_DB。
// 用法：node apps/plugin/scripts/install-verify.mjs
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const pluginSrc = resolve(new URL('..', import.meta.url).pathname);
const validator = join(pluginSrc, 'scripts', 'validate-package.mjs');

// 红线硬断言：本进程环境若带真实库路径则拒绝启动（防误把真实库传给任何子进程）
if (process.env.TODODESK_DB && !resolve(process.env.TODODESK_DB).startsWith(resolve(tmpdir()))) {
  console.error(`[install-verify] TODODESK_DB=${process.env.TODODESK_DB} 指向非临时路径，拒绝启动（真实库禁写）`);
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), 'td-plugin-install-'));
const results = [];

/** 隔离红线：每次验收子进程独立 HOME + 显式临时 TODODESK_DB（绝不携带真实路径），启动前硬校验 */
const createdHomes = [];
const isolatedEnvFor = () => {
  const home = mkdtempSync(join(tmpdir(), 'td-plugin-home-'));
  createdHomes.push(home);
  const db = join(work, `guard-${results.length}.db`);
  if (!resolve(db).startsWith(resolve(work)) || resolve(db).includes('Application Support')) {
    throw new Error('隔离环境硬校验失败：临时库路径异常');
  }
  return { env: { PATH: process.env.PATH, HOME: home, TODODESK_DB: db }, home };
};

/** 跑一次验收器：expectPass 声明预期结果；skipSpawn 用于负面用例（无需 MCP 探针，更快更聚焦） */
const run = (name, dir, { expectPass = true, skipSpawn = !expectPass } = {}) => {
  const { env } = isolatedEnvFor();
  const args = [validator, dir];
  if (skipSpawn) args.push('--skip-mcp-spawn');
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 120000, env });
  const passed = r.status === 0;
  const ok = passed === expectPass;
  results.push(ok);
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  if (!ok) console.log((r.stdout || '') + (r.stderr || ''));
  return ok;
};

const copy = (name) => {
  const d = join(work, name);
  cpSync(pluginSrc, d, { recursive: true });
  return d;
};

console.log(`[tododesk-plugin-install-verify]`);
console.log(`  插件源: ${pluginSrc}`);
console.log(`  临时安装目录: ${work}\n`);

let failedCount = -1;
try {
  // 0. bundle 陈旧检查：插件内 MCP bundle 必须与 apps/mcp 最新构建一致（忘了重拷=插件带着旧核心行为）
  console.log('0. bundle 新鲜度');
  const distBundle = join(pluginSrc, '..', 'mcp', 'dist', 'mcp-server.cjs');
  if (!existsSync(distBundle)) {
    console.log('  ⚠ apps/mcp/dist/mcp-server.cjs 不存在（先 npm run build:mcp），跳过对比');
  } else {
    const same = readFileSync(join(pluginSrc, 'mcp', 'mcp-server.cjs')).equals(readFileSync(distBundle));
    results.push(same);
    console.log(`  ${same ? '✓' : '✗'} 插件 bundle 与 apps/mcp 最新构建一致${same ? '' : '（陈旧！运行 npm run plugin:build 重拷）'}`);
  }

  // 1. 迁移 + MCP 异地 cwd 隔离读写：整包复制到全新位置全量验收（含 spawn 探针：临时库写→读→关闭）
  console.log('\n1. 迁移（全新安装位置全量验收，含 MCP 异地 cwd 读写探针）');
  const install = copy('install');
  run('复制到临时安装目录后全量验收通过（无硬编码路径，MCP 异地 cwd 读写 OK）', install);

  // 2. 冲突：包内混入不安全文件名 / 相对路径 MCP 声明 / 缺上游 LICENSE / 双宿主清单漂移
  console.log('\n2. 冲突');
  const conflict = copy('conflict');
  writeFileSync(join(conflict, 'bad name#.md'), 'conflict probe\n');
  run('不安全文件名（空格/#）→ 验收拒绝', conflict, { expectPass: false });

  for (const f of ['mcp.json', '.mcp.json']) {
    const rel = copy(`rel-args-${f.replaceAll(/[./]/g, '_')}`);
    const m = JSON.parse(readFileSync(join(rel, f), 'utf8'));
    m.mcpServers.tododesk.args = ['./mcp/mcp-server.cjs'];
    writeFileSync(join(rel, f), JSON.stringify(m, null, 2));
    run(`${f} 用相对路径 ./mcp/mcp-server.cjs（异地 cwd 必失败）→ 验收拒绝`, rel, { expectPass: false });
  }

  // Codex 官方规范：根 mcp.json 必须带 Agent Plugins MCP schema（ZCode 宿主的 .mcp.json 不要求）
  const noSchema = copy('mcp-no-schema');
  const ns = JSON.parse(readFileSync(join(noSchema, 'mcp.json'), 'utf8'));
  delete ns.$schema;
  writeFileSync(join(noSchema, 'mcp.json'), JSON.stringify(ns, null, 2));
  run('mcp.json 缺 $schema（Codex 官方插件规范）→ 验收拒绝', noSchema, { expectPass: false });

  const noLic = copy('no-license');
  rmSync(join(noLic, 'skills', 'tododesk-teach', 'LICENSE'), { force: true });
  run('缺上游 MIT LICENSE（版权须随包保留）→ 验收拒绝', noLic, { expectPass: false });

  const drift = copy('host-drift');
  const dz = JSON.parse(readFileSync(join(drift, '.zcode-plugin', 'plugin.json'), 'utf8'));
  dz.version = '0.2.0';
  writeFileSync(join(drift, '.zcode-plugin', 'plugin.json'), JSON.stringify(dz, null, 2));
  run('双宿主 version 漂移（Codex 0.1.0 / ZCode 0.2.0）→ 验收拒绝', drift, { expectPass: false });

  // 3. 缺组件
  console.log('\n3. 缺组件');
  const missing = [
    ['Codex manifest（plugin.json）', 'plugin.json'],
    ['ZCode manifest（.zcode-plugin/plugin.json）', join('.zcode-plugin', 'plugin.json')],
    ['技能（skills/tododesk-teach/SKILL.md）', join('skills', 'tododesk-teach', 'SKILL.md')],
    ['MCP 服务器（mcp/mcp-server.cjs）', join('mcp', 'mcp-server.cjs')],
    ['MCP 声明（mcp.json）', 'mcp.json'],
  ];
  for (const [label, rel] of missing) {
    const d = copy(`miss-${rel.replaceAll(/[/.]/g, '_')}`);
    rmSync(join(d, rel), { recursive: true, force: true });
    run(`缺 ${label} → 验收拒绝`, d, { expectPass: false });
  }

  // 4. 版本：非语义化版本号
  console.log('\n4. 版本');
  const ver = copy('bad-version');
  const vm = JSON.parse(readFileSync(join(ver, 'plugin.json'), 'utf8'));
  vm.version = '0.1';
  writeFileSync(join(ver, 'plugin.json'), JSON.stringify(vm, null, 2));
  run('version 非语义化（"0.1"）→ 验收拒绝', ver, { expectPass: false });

  // 5. schema：manifest 非法 JSON
  console.log('\n5. schema');
  const schema = copy('bad-json');
  writeFileSync(join(schema, 'plugin.json'), '{ not valid json !!');
  run('plugin.json 非法 JSON → 验收拒绝', schema, { expectPass: false });

  const failed = results.filter((x) => !x).length;
  console.log(`\n[tododesk-plugin-install-verify] ${failed === 0 ? 'PASS' : 'FAIL'}：${results.length - failed}/${results.length} 项通过`);
  failedCount = failed;
} finally {
  // 先清理再退出：绝不 process.exit（会跳过 finally，残留临时 HOME/安装目录）
  rmSync(work, { recursive: true, force: true });
  for (const h of createdHomes) rmSync(h, { recursive: true, force: true });
}
process.exitCode = failedCount === 0 ? 0 : 1;
