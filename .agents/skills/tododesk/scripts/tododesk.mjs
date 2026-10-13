#!/usr/bin/env node
// TodoDesk MCP 直连调用器：不经客户端注册，直接通过 stdio JSON-RPC 与 MCP 服务对话。
// 用法：
//   node tododesk.mjs list
//   node tododesk.mjs call <tool_name> ['{"参数":"值"}']
// 环境变量：TODODESK_MCP 覆盖服务路径（默认查找 skill 所在仓库，再兼容本机安装位置）；
//           TODODESK_DB 透传给服务，覆盖数据库路径。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoServer = resolve(scriptDir, '../../../../apps/mcp/dist/mcp-server.cjs');
const DEFAULT_SERVER = existsSync(repoServer) ? repoServer : join(homedir(), 'Desktop/todo/apps/mcp/dist/mcp-server.cjs');
const serverPath = process.env.TODODESK_MCP ?? DEFAULT_SERVER;

if (!existsSync(serverPath)) {
  console.error(
    `[tododesk] MCP 服务不存在：${serverPath}\n` +
      '请设置 TODODESK_MCP 指向 mcp-server.cjs，或在 TodoDesk 仓库根目录执行 npm run build:mcp。',
  );
  process.exit(3);
}

const command = process.argv[2];
const tool = process.argv[3];
const rawArgs = process.argv[4];
if (command !== 'list' && (command !== 'call' || !tool)) {
  console.error(`用法: node ${dirname(fileURLToPath(import.meta.url))}/tododesk.mjs list | call <tool> ['{"k":"v"}']`);
  process.exit(2);
}
let args = {};
if (rawArgs !== undefined) {
  try {
    args = JSON.parse(rawArgs);
  } catch {
    console.error(`[tododesk] 参数不是合法 JSON：${rawArgs}`);
    process.exit(2);
  }
}

const proc = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'inherit'] });
const timer = setTimeout(() => {
  console.error('[tododesk] 调用超时（60s），已终止服务进程');
  proc.kill();
  process.exit(4);
}, 60_000);

let buffer = '';
let nextId = 1;
const pending = new Map();
proc.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // 忽略非 JSON-RPC 输出
    }
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
proc.stdin.on('error', () => {}); // 进程退出时的 EPIPE 不当致命错误

function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message ?? JSON.stringify(msg.error))) : resolve(msg.result)));
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const notify = (method, params) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

try {
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'tododesk-skill', version: '1.0.0' },
  });
  notify('notifications/initialized', {});

  if (command === 'list') {
    const res = await request('tools/list', {});
    for (const t of res.tools) {
      const brief = (t.description ?? '').split('。')[0];
      console.log(`${t.name}\t${brief}`);
    }
  } else {
    const res = await request('tools/call', { name: tool, arguments: args });
    const text = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    console.log(text);
    if (res.isError) {
      clearTimeout(timer);
      proc.kill();
      process.exit(1);
    }
  }
  clearTimeout(timer);
  proc.kill();
} catch (e) {
  console.error(`[tododesk] ${e instanceof Error ? e.message : String(e)}`);
  clearTimeout(timer);
  proc.kill();
  process.exit(1);
}
