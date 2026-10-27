#!/usr/bin/env node
// 仅用于临时数据库的新闻工作台验收：模拟推理，真实调用当前任务的受限 MCP。
if (process.argv.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('--output-format --strict-mcp-config'); process.exit(0); }
if (process.argv.includes('login') || process.argv.includes('auth')) process.exit(0);
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
const config = Object.fromEntries(process.argv.flatMap((arg, index, args) => { if (arg !== '-c') return []; const cut = args[index + 1].indexOf('='); return [[args[index + 1].slice(0, cut), JSON.parse(args[index + 1].slice(cut + 1))]]; }));
const prefix = 'mcp_servers.dayfolio_news.';
const env = Object.fromEntries(Object.entries(config).filter(([key]) => key.startsWith(prefix + 'env.')).map(([key, value]) => [key.slice((prefix + 'env.').length), value]));
const client = new Client({ name: '新闻工作台隔离验收', version: '1' });
await client.connect(new StdioClientTransport({ command: config[prefix + 'command'], args: config[prefix + 'args'], env: { ...process.env, ...env } }));
const call = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); if (result.isError) throw new Error(result.content[0].text); return JSON.parse(result.content[0].text).data; };
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'news-feed-fixture' }));
try {
  const { task, context } = await call('get_news_task');
  if (!context?.module_id) throw new Error('隔离fixture只允许模块任务');
  const candidate = context.module_id === 'for_you' && !context.candidate_topic ? {
    key: '便携端侧编程工具', name: '便携端侧编程工具', scope: '在个人笔记本离线运行的开源编程与模型量化工具',
    reason: context.interest_evidence?.length ? '根据你明确收藏的开源工具报道探索相邻方向' : '探索推荐：从已配置的 AI 模块试读具体方向，尚无长期兴趣证据',
    basis_news_ids: context.interest_evidence?.slice(0, 2).map(item => item.news_id) || [],
    ...(context.interest_evidence?.length ? {} : { basis_module_id: context.exploration_seed?.basis_module_id || 'ai' }),
  } : null;
  const count = Math.min(context.remaining, task.max_items, candidate ? 2 : 10);
  const items = Array.from({ length: count }, (_, index) => ({
    title: `新增核实 ${context.module_id} ${task.id}-${index + 1}`,
    summary: `这是隔离采集的第 ${index + 1} 则独立报道。测试数据说明主体、行动与结果，验证真实任务预算和图文摘要保存；不代表真实世界新闻。`,
    source_url: `https://example.com/feed-live/${task.id}/${index + 1}`,
    source_name: '隔离核实来源', published_at: new Date(Date.parse(context.window_end) - (index + 1) * 1000).toISOString(),
    module_id: context.module_id, topic_keys: candidate ? [candidate.key] : context.module_id === 'for_you' && context.interests?.length ? [context.interests[0].key] : ['开源工具'],
    ...(Object.keys(context.event_revisions || {}).length ? { event_id: Object.keys(context.event_revisions)[index % Object.keys(context.event_revisions).length] } : {}),
    background: '这是一段隔离验收背景，验证本地阅读无需加载原始页面。', impact: '此段为测试分析，用于验证事实和分析的展示层次。', uncertainty: '这不是线上内容，不作真实消息判断。',
    image_url: 'https://example.com/feed-image-ok.png', image_source_url: `https://example.com/feed-live/${task.id}/${index + 1}`, image_caption: '隔离验收图片，不代表新闻现场',
    ...(candidate ? { candidate_topic: candidate } : {}),
  }));
  await new Promise(resolve => setTimeout(resolve, 450));
  if (items.length) await call('submit_news_items', { items });
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', tool: 'submit_news_items' } }));
  const latest = await call('get_news_task');
  const daily = latest.context?.daily_edition;
  if (!daily) throw new Error('日报任务缺少当天模块上下文');
  if (daily.news.length) await call('submit_news_daily_summary', {
    summary: `本期${daily.edition.module_name}重点：相关机构发布了新一阶段行动与结果，已收录报道分别交代关键进展、理解背景和需要继续观察的影响。本次更新将新增事实纳入当天总结，保留独立新闻及其原始来源。此段是隔离验收的综合总结，不代表真实新闻。`,
    news_ids: daily.news.slice(0, 5).map(item => item.id), expected_revision: daily.edition.revision,
  });
  await call('complete_news_task', { note: `隔离验收：实际提交 ${items.length} 则，未访问真实新闻网站` });
  console.log(JSON.stringify({ type: 'turn.completed' }));
} finally { await client.close(); }
