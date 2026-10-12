#!/usr/bin/env node
// TodoDesk 教学插件安装验收器：只在临时目录验收包内容，绝不改 ~/.agents、~/.zcode 或连接权限配置。
// 用法：node validate-package.mjs <插件包目录> [--skip-mcp-spawn]
// 检查：schema、组件齐全（双宿主 manifest/skill/MCP/LICENSE）、双宿主 name/version 一致、
//       可迁移路径（无绝对路径/无 ~/Desktop 硬编码；MCP 启动命令须用 ${CLAUDE_PLUGIN_ROOT} 官方约定，
//       相对路径在异地 cwd 必然启动失败）、版本兼容（node >= 20）、冲突（文件名安全）、
//       上游来源许可（MIT, Matt Pocock, 49dd158；拒绝 curated 变体）、
//       MCP 隔离读写（按宿主约定解析 ${CLAUDE_PLUGIN_ROOT}，从异地 cwd 实际 spawn：临时库写→读）。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const pkgDir = process.argv[2];
const skipSpawn = process.argv.includes('--skip-mcp-spawn');
if (!pkgDir) {
  console.error('用法: node validate-package.mjs <插件包目录> [--skip-mcp-spawn]');
  process.exit(2);
}
const root = resolve(pkgDir);
const failures = [];
const warns = [];
const pass = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => { failures.push(msg); console.error(`  ✗ ${msg}`); };
const warn = (msg) => { warns.push(msg); console.warn(`  ⚠ ${msg}`); };

const readJson = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));
const exists = (p) => { try { statSync(join(root, p)); return true; } catch { return false; } };

console.log(`[tododesk-plugin-validate] 包目录: ${root}\n`);

// ---- 1. manifest schema 与组件 ----
console.log('1. manifest schema 与组件');
const manifests = {};
for (const [file, host] of [['plugin.json', 'Codex'], ['.zcode-plugin/plugin.json', 'ZCode']]) {
  if (!exists(file)) { fail(`${host} manifest 缺失: ${file}`); continue; }
  try {
    const m = readJson(file);
    manifests[host] = m;
    if (host === 'Codex') {
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(m.name ?? '')) fail(`Codex name "${m.name}" 非 kebab-case`);
      else pass(`Codex manifest（name=${m.name}, version=${m.version}）`);
      if (!/^\d+\.\d+\.\d+$/.test(m.version ?? '')) fail('Codex version 非语义化 x.y.z');
    } else {
      if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(m.name ?? '')) fail(`ZCode name "${m.name}" 不匹配 ^[a-z0-9][a-z0-9._-]{0,127}$`);
      else pass(`ZCode manifest（name=${m.name}）`);
    }
  } catch (e) { fail(`${file} JSON 解析失败: ${e.message}`); }
}
// 双宿主一致性：两份 manifest 的 name/version 必须一致（漂移=插件市场里同一插件两个身份）
if (manifests.Codex && manifests.ZCode) {
  if (manifests.Codex.name !== manifests.ZCode.name) fail(`双宿主 name 不一致: Codex=${manifests.Codex.name} ZCode=${manifests.ZCode.name}`);
  else if (manifests.Codex.version !== manifests.ZCode.version) fail(`双宿主 version 不一致: Codex=${manifests.Codex.version} ZCode=${manifests.ZCode.version}`);
  else pass(`双宿主清单一致（${manifests.Codex.name}@${manifests.Codex.version}）`);
}
if (!exists('skills/tododesk-teach/SKILL.md')) fail('技能缺失: skills/tododesk-teach/SKILL.md');
else {
  const md = readFileSync(join(root, 'skills/tododesk-teach/SKILL.md'), 'utf8');
  if (!/^---\n[\s\S]*?name:\s*tododesk-teach[\s\S]*?---/m.test(md)) fail('SKILL.md frontmatter 缺 name');
  else pass('技能 SKILL.md frontmatter 合规');
  // 上游来源与许可为硬校验：MIT 改编必须保留来源/许可/commit 溯源，且不得引入 curated 变体
  if (!md.includes('mattpocock/skills') || !md.includes('MIT') || !md.includes('49dd158')) {
    fail('SKILL.md 未声明上游来源/许可/commit（须含 mattpocock/skills + MIT + 49dd158）');
  } else pass('上游来源/许可（MIT, Matt Pocock, 49dd158）已在 SKILL.md 声明');
  if (/curated/i.test(md)) fail('SKILL.md 引用了 curated 变体（来源必须是原仓库 commit，非 curated 分发）');
  if (/自动调用|自动触发(?!——不)/.test(md) && !md.includes('显式')) warn('SKILL.md 须明确「显式调用，不冒称自动调用」');
}
if (!exists('skills/tododesk-teach/LICENSE')) fail('上游 LICENSE 缺失: skills/tododesk-teach/LICENSE（MIT 版权声明须随包保留）');
else {
  const lic = readFileSync(join(root, 'skills/tododesk-teach/LICENSE'), 'utf8');
  if (!lic.includes('MIT License') || !lic.includes('Copyright (c) 2026 Matt Pocock') || !lic.includes('49dd158')) {
    fail('上游 LICENSE 内容不完整（须含 MIT License + Copyright (c) 2026 Matt Pocock + commit 49dd158 溯源）');
  } else pass('上游 MIT LICENSE（Copyright (c) 2026 Matt Pocock）随包保留');
}
if (!exists('mcp/mcp-server.cjs')) fail('MCP 服务器缺失: mcp/mcp-server.cjs');
else pass(`MCP 服务器存在（${Math.round(statSync(join(root, 'mcp/mcp-server.cjs')).size / 1024)}KB）`);

// MCP 声明（双宿主）：启动命令必须用 ${CLAUDE_PLUGIN_ROOT} 官方约定解析为包内绝对路径——
// 相对路径（./mcp/...）取决于宿主 spawn 时的工作目录，异地 cwd 必然 ENOENT
const mcpEntries = [];
for (const f of ['mcp.json', '.mcp.json']) {
  if (!exists(f)) { fail(`MCP 声明缺失: ${f}`); continue; }
  try {
    const m = readJson(f);
    if (f === 'mcp.json') {
      // Codex 官方插件规范：根 mcp.json 必须带 Agent Plugins MCP schema（宿主可据此校验/补全）
      if (m.$schema !== 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json') {
        fail('mcp.json 缺 $schema=https://agent-plugins.org/schemas/1.0.0/mcp.schema.json（Codex 官方插件规范，见 developers.openai.com/plugins/build/plugins）');
        continue;
      }
    }
    const srv = m.mcpServers?.tododesk;
    if (!srv) { fail(`${f} 缺 mcpServers.tododesk`); continue; }
    if (srv.type !== 'stdio') { fail(`${f} tododesk.type 须为 "stdio"`); continue; }
    if (srv.command !== 'node') { fail(`${f} tododesk.command 须为 "node"`); continue; }
    const arg0 = Array.isArray(srv.args) ? srv.args[0] : undefined;
    if (arg0 !== '${CLAUDE_PLUGIN_ROOT}/mcp/mcp-server.cjs') {
      fail(`${f} args[0] 须为 "\${CLAUDE_PLUGIN_ROOT}/mcp/mcp-server.cjs"（当前: ${JSON.stringify(arg0)}；相对路径在异地 cwd 无法启动）`);
      continue;
    }
    if (srv.env && JSON.stringify(srv.env).includes('${')) {
      fail(`${f} env 含未展开占位符（宿主不展开时会以字面量传给子进程）`);
      continue;
    }
    pass(`${f}: stdio tododesk 声明合规（\${CLAUDE_PLUGIN_ROOT} 官方约定）`);
    mcpEntries.push(f);
  } catch (e) { fail(`${f} JSON 解析失败: ${e.message}`); }
}
if (mcpEntries.length === 2) pass('双宿主 MCP 声明一致（同一 tododesk 服务器，两宿主均可解析）');

// ---- 2. 可迁移路径（无绝对路径/硬编码） ----
console.log('\n2. 可迁移路径检查');
const scanDir = (d, rel) => {
  for (const name of readdirSync(d)) {
    const abs = join(d, name);
    const relPath = rel ? `${rel}/${name}` : name;
    if (statSync(abs).isDirectory()) { scanDir(abs, relPath); continue; }
    if (/(json|md|mjs|js|cjs)$/i.test(name) && !relPath.includes('validate-package')) {
      const txt = readFileSync(abs, 'utf8');
      if (/\/Users\/[a-z]+\/Desktop\/todo/i.test(txt) || /~\/Desktop\/todo/.test(txt)) {
        fail(`${relPath} 含 ~/Desktop/todo 硬编码路径（不可迁移）`);
      }
      if (/\/Users\/[a-z]+\//.test(txt) && !/example|示例|示意/.test(txt)) {
        warn(`${relPath} 含用户绝对路径（检查是否可迁移）`);
      }
    }
    if (/[^A-Za-z0-9._\/-]/.test(relPath) || relPath.includes('..')) fail(`不安全文件名: ${relPath}`);
  }
};
scanDir(root, '');
if (failures.filter((f) => f.includes('硬编码')).length === 0) pass('无 ~/Desktop/todo 硬编码');

// ---- 3. 版本兼容 ----
console.log('\n3. 版本兼容');
const [major] = process.versions.node.split('.').map(Number);
if (major < 20) fail(`node ${process.versions.node} < 20（MCP 服务器要求 node >= 20）`);
else pass(`node ${process.versions.node} ≥ 20`);

// ---- 4. MCP 隔离读写（按宿主约定解析 ${CLAUDE_PLUGIN_ROOT}，从异地 cwd 实际 spawn） ----
console.log('\n4. MCP 隔离读写（异地 cwd 启动）');
if (skipSpawn) {
  warn('--skip-mcp-spawn：跳过实测（CI 环境可用）');
} else if (mcpEntries.length === 0) {
  fail('MCP 声明均不合规，无法实测');
} else {
  const tmp = mkdtempSync(join(tmpdir(), 'td-plugin-validate-'));
  const db = join(tmp, 'validate.db');
  const home = join(tmp, 'home');
  // 红线硬校验：探针各级子进程只用临时库与临时 HOME，绝不携带真实路径
  if (!resolve(db).startsWith(resolve(tmp)) || resolve(home).includes('Application Support') || resolve(home) === resolve(process.env.HOME ?? '')) {
    fail(`隔离环境硬校验失败：db=${db} home=${home}`);
  }
  mkdirSync(home, { recursive: true });
  // 异地 cwd：既不是包目录、也不是仓库目录——宿主（如 ZCode）常以项目目录为 cwd 启动 MCP，
  // 相对路径声明在真实安装中就是这样失败的
  const foreignCwd = join(tmp, 'foreign-cwd');
  mkdirSync(foreignCwd, { recursive: true });
  try {
    for (const f of mcpEntries) {
      // 模拟宿主行为：把 ${CLAUDE_PLUGIN_ROOT} 替换为插件根，得到启动命令
      const srv = readJson(f).mcpServers.tododesk;
      const resolvedArgs = srv.args.map((a) => a.replaceAll('${CLAUDE_PLUGIN_ROOT}', root));
      const serverScript = resolvedArgs[0];
      if (!serverScript.startsWith(root + '/') || serverScript.includes('${')) {
        fail(`${f} 解析后仍不可用: ${serverScript}`);
        continue;
      }
      if (!existsSync(serverScript)) { fail(`${f} 解析出的服务器文件不存在: ${serverScript}`); continue; }
      // 零依赖探针：stdio JSON-RPC 握手（initialize → tools/call add_todo → tools/call list_todos）
      const script = `
        const { spawn } = require('node:child_process');
        const child = spawn(${JSON.stringify(srv.command)}, ${JSON.stringify(resolvedArgs)}, {
          cwd: ${JSON.stringify(foreignCwd)},
          env: { PATH: process.env.PATH, HOME: ${JSON.stringify(home)}, TODODESK_DB: ${JSON.stringify(db)} },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let buf = '';
        const send = (o) => child.stdin.write(JSON.stringify(o) + '\\n');
        const results = {};
        child.stdout.on('data', (d) => {
          buf += d;
          let idx;
          while ((idx = buf.indexOf('\\n')) >= 0) {
            const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
            if (!line.trim()) continue;
            try { const m = JSON.parse(line); if (m.id != null) results[m.id] = m; } catch {}
          }
        });
        const waitId = (id, ms) => new Promise((res, rej) => {
          const t0 = Date.now();
          const iv = setInterval(() => {
            if (results[id]) { clearInterval(iv); res(results[id]); }
            else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout ' + id)); }
          }, 50);
        });
        (async () => {
          send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'validate', version: '1' } } });
          await waitId(1, 15000);
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'add_todo', arguments: { title: '插件验收探针' } } });
          const add = await waitId(2, 15000);
          send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_todos', arguments: {} } });
          const list = await waitId(3, 15000);
          const addOk = add.result && !add.result.isError;
          const cnt = JSON.parse(list.result.content[0].text).data.count;
          if (!addOk || cnt < 1) { console.error('probe failed', JSON.stringify({ addOk, cnt })); process.exit(1); }
          console.log('MCP_ISOLATION_OK');
          child.kill();
          process.exit(0);
        })().catch((e) => { console.error(e.message); child.kill(); process.exit(1); });
      `;
      writeFileSync(join(tmp, 'mcp-probe.cjs'), script);
      const r = spawnSync(process.execPath, [join(tmp, 'mcp-probe.cjs')], {
        encoding: 'utf8',
        timeout: 30000,
        cwd: foreignCwd,
        env: { PATH: process.env.PATH, HOME: home, TODODESK_DB: db },
      });
      if (r.status === 0 && r.stdout.includes('MCP_ISOLATION_OK')) pass(`${f} 异地 cwd 启动读写通过（临时库写→读→关闭）`);
      else fail(`${f} 异地 cwd 启动失败: ${r.stderr || r.stdout || `exit ${r.status}`}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- 汇总 ----
console.log(`\n[tododesk-plugin-validate] ${failures.length === 0 ? 'PASS' : 'FAIL'}：${failures.length} 失败 / ${warns.length} 警告`);
if (failures.length > 0) process.exit(1);
