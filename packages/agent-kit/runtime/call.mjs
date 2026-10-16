#!/usr/bin/env node
// 共用 MCP 调用器：能力包内定位优先，兼容源码开发和 TODODESK_MCP 覆盖。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const bundled = resolve(root, '../mcp/mcp-server.cjs');
const source = resolve(root, '../../../apps/mcp/dist/mcp-server.cjs');
const serverPath = process.env.TODODESK_MCP ?? (existsSync(bundled) ? bundled : source);
const [command, name, rawArgs] = process.argv.slice(2);
if (!['list', 'call'].includes(command) || (command === 'call' && !name)) {
  console.error('用法：node call.mjs list | call <工具名> [JSON参数]'); process.exit(2);
}
let args = {};
try { if (rawArgs !== undefined) args = JSON.parse(rawArgs); }
catch { console.error('参数不是合法 JSON'); process.exit(2); }
if (!existsSync(serverPath)) { console.error('MCP 构建产物不存在；运行 npm run build:mcp，或设置 TODODESK_MCP。'); process.exit(3); }

const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'inherit'] });
let buffer = '', nextId = 1;
const pending = new Map();
const rejectAll = error => { for (const item of pending.values()) item.reject(error); pending.clear(); };
const timer = setTimeout(() => { rejectAll(new Error('MCP 调用超时')); child.kill(); }, 60_000);
child.on('error', rejectAll);
child.on('exit', code => rejectAll(new Error(`MCP 提前退出：${code}`)));
child.stdin.on('error', rejectAll);
child.stdout.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
    let message; try { message = JSON.parse(line); } catch { continue; }
    const item = pending.get(message.id);
    if (item) { pending.delete(message.id); message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result); }
  }
});
const send = (method, params, id) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, params }) + '\n');
const request = (method, params) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); send(method, params, id); });
try {
  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'tododesk-skill', version: '1.0.0' } });
  send('notifications/initialized', {});
  if (command === 'list') {
    let cursor;
    do {
      const result = await request('tools/list', cursor ? { cursor } : {});
      for (const tool of result.tools) console.log(`${tool.name}\t${tool.description ?? ''}`);
      cursor = result.nextCursor;
    } while (cursor);
  } else {
    const result = await request('tools/call', { name, arguments: args });
    console.log((result.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n'));
    if (result.isError) process.exitCode = 1;
  }
} catch (error) { console.error('[tododesk] ' + error.message); process.exitCode = 1; }
finally { clearTimeout(timer); child.kill(); }
