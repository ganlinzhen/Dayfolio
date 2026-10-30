#!/usr/bin/env node
// 仅用于隔离界面验收：模拟推理引擎，但使用真实 stdio MCP 与业务校验。
const provider = process.env.DAYFOLIO_TEST_PROVIDER || 'codex';
if (process.argv.includes('--version')) { console.log(provider === 'codex' ? 'codex-cli 0.163.0' : provider + ' 9.0.0'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('--strict-mcp-config --bare --tools --output-format --allowed-mcp-server-names --extensions'); process.exit(0); }
if (process.argv.includes('login') || process.argv.includes('auth')) process.exit(0);
// 连接检查无需加载 MCP SDK，避免并行测试时不必要的启动开销。
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
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
  const payload = JSON.parse(result.content[0].text);
  if (!payload.ok) throw new Error(JSON.stringify(payload.error));
  return payload.data;
};
console.log(JSON.stringify(provider === 'codex' ? {type:'thread.started',thread_id:'fixture-thread'} : {type:provider === 'claude' ? 'system' : 'init',session_id:'fixture-thread'}));
const initial = await call('get_news_task');
if (process.env.DAYFOLIO_NEWS_FIXTURE_MODE === 'batch' || (initial.context?.batch_id && (process.env.DAYFOLIO_NEWS_FIXTURE_MODE || 'success') === 'success')) {
  const tasks = await call('get_news_batch');
  for (const { task_id, context } of tasks) {
    if (context.module_id === 'events') continue;
    await call('submit_batch_news', { task_id, items: [{ title: `批次隔离新闻 ${task_id}`, summary: '仅用于验证批次独立任务和受限写入。', source_url: `https://example.com/batch-${task_id}`, published_at: new Date(Date.now() - 60000).toISOString() }] });
  }
  for (const { task_id } of tasks) await call('complete_batch_task', { task_id, note: '隔离批次验证' });
  await client.close();
  console.log(JSON.stringify(provider === 'codex' ? {type:'turn.completed'} : provider === 'claude' ? {type:'result',is_error:false} : {type:'result',status:'success'}));
  process.exit(0);
}
await new Promise(resolve => setTimeout(resolve, 800));
await call('submit_news_items', { items: [{ title: '后台采集界面验证新闻', summary: '此内容仅用于临时数据库，验证按钮触发、真实 MCP 入库和界面自动刷新。', source_url: 'https://example.com/ui-news-agent', published_at: new Date(Date.now() - 60000).toISOString() }] });
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', tool: 'submit_news_items' } }));
const mode = process.env.DAYFOLIO_NEWS_FIXTURE_MODE || 'success';
if (mode === 'wait') await new Promise(resolve => setTimeout(resolve, 30000));
if (mode === 'success') await call('complete_news_task', { note: '隔离界面验证完成' });
await client.close();
console.log(JSON.stringify(provider === 'codex' ? {type:'turn.completed'} : provider === 'claude' ? {type:'result',is_error:false} : {type:'result',status:'success'}));
