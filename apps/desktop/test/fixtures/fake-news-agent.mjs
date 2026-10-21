#!/usr/bin/env node
// 仅用于隔离界面验收：模拟推理引擎，但使用真实 stdio MCP 与业务校验。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const provider = process.env.DAYFOLIO_TEST_PROVIDER || 'codex';
if (process.argv.includes('--version')) { console.log(provider === 'codex' ? 'codex-cli 0.163.0' : provider + ' 9.0.0'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('--strict-mcp-config --bare --tools --output-format --allowed-mcp-server-names --extensions'); process.exit(0); }
if (process.argv.includes('login') || process.argv.includes('auth')) process.exit(0);
let command, args, env;
if (provider === 'codex') {
  const cfg = Object.fromEntries(process.argv.flatMap((arg, i, all) => {
    if (arg !== '-c') return [];
    const cut = all[i + 1].indexOf('='); return [[all[i + 1].slice(0, cut), JSON.parse(all[i + 1].slice(cut + 1))]];
  }));
  const prefix = 'mcp_servers.dayfolio_news.';
  env = Object.fromEntries(Object.entries(cfg).filter(([k]) => k.startsWith(prefix + 'env.')).map(([k,v])=>[k.slice((prefix+'env.').length),v]));
  command = cfg[prefix+'command']; args = cfg[prefix+'args'];
} else {
  const config = provider === 'claude' ? JSON.parse(process.argv[process.argv.indexOf('--mcp-config') + 1]) : JSON.parse((await import('node:fs')).readFileSync(process.env.GEMINI_CLI_HOME + '/.gemini/settings.json', 'utf8'));
  ({ command, args, env } = config.mcpServers.dayfolio_news);
}
const client = new Client({ name: '隔离验证引擎', version: '1' });
await client.connect(new StdioClientTransport({ command, args, env: { ...process.env, ...env } }));
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text).data;
};
console.log(JSON.stringify(provider === 'codex' ? {type:'thread.started',thread_id:'fixture-thread'} : {type:provider === 'claude' ? 'system' : 'init',session_id:'fixture-thread'}));
await call('get_news_task');
await new Promise(resolve => setTimeout(resolve, 800));
await call('submit_news_items', { items: [{ title: '后台采集界面验证新闻', summary: '此内容仅用于临时数据库，验证按钮触发、真实 MCP 入库和界面自动刷新。', source_url: 'https://example.com/ui-news-agent', published_at: new Date(Date.now() - 60000).toISOString() }] });
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', tool: 'submit_news_items' } }));
const mode = process.env.DAYFOLIO_NEWS_FIXTURE_MODE || 'success';
if (mode === 'wait') await new Promise(resolve => setTimeout(resolve, 30000));
if (mode === 'success') await call('complete_news_task', { note: '隔离界面验证完成' });
await client.close();
console.log(JSON.stringify(provider === 'codex' ? {type:'turn.completed'} : provider === 'claude' ? {type:'result',is_error:false} : {type:'result',status:'success'}));
