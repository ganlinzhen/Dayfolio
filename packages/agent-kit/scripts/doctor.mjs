// 接入诊断只读取清单和配置，不打开用户数据库，不改变客户端设置。
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyAgentKit } from './package.mjs';
const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

export function diagnoseAgentKit({ source = join(repoRoot, 'dist/agent-kit'), target, config, nodeVersion = process.versions.node } = {}) {
  const [major, minor] = nodeVersion.split('.').map(Number);
  const report = { ok: true, node: nodeVersion, bundledVersion: null, installedVersion: null, database: process.env.TODODESK_DB ?? join(homedir(), 'Library/Application Support/tododesk/tododesk.db'), issues: [], configuration: null };
  if (!((major === 22 && minor >= 13) || major === 24)) report.issues.push('Node 版本不受支持：需要 22.13+ 的 22.x 或 24.x');
  for (const [label, root] of [['bundledVersion', source], ['installedVersion', target]]) {
    if (!root) continue;
    try { report[label] = verifyAgentKit(root).version; } catch (error) { report.issues.push(`${label}：${error.message}`); }
  }
  if (report.installedVersion && report.installedVersion !== report.bundledVersion) report.issues.push('已安装能力包与候选包版本不同');
  if (config) {
    try {
      const entries = JSON.parse(readFileSync(config, 'utf8')).mcpServers ?? {};
      const matches = Object.entries(entries).filter(([name, entry]) => name === 'tododesk' || /(?:tododesk|dayfolio|mcp-server\.cjs)/i.test(JSON.stringify(entry)));
      report.configuration = { path: resolve(config), entries: matches.map(([name]) => name), registered: matches.length > 0, reachable: '未探测' };
      if (matches.length > 1) report.issues.push('指定配置中可能存在重复的 Dayfolio MCP 入口，请核对后保留一个');
    } catch (error) { report.issues.push('配置读取失败（--config 仅支持 JSON）：' + error.message); }
  }
  report.ok = report.issues.length === 0;
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const report = diagnoseAgentKit({ source: value('--source'), target: value('--target'), config: value('--config') });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
