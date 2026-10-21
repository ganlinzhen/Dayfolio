// 真实 Codex 采集验证：只写临时数据库，读取本机已有 Codex 登录，不更改长期配置。
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
if (!process.argv.includes('--live')) throw new Error('真实采集需显式指定 --live，会使用当前 Codex 账户额度');
const repo = resolve(new URL('../../../', import.meta.url).pathname);
const dir = mkdtempSync(join(tmpdir(), 'dayfolio-live-news-'));
const source = join(dir, 'verify.ts'), outfile = join(dir, 'verify.cjs');
writeFileSync(source, `
import { createCore, openNodeSqliteDb } from ${JSON.stringify(join(repo, 'packages/core/src'))};
import { createNewsAgentRunner } from ${JSON.stringify(join(repo, 'apps/desktop/src/main/news-agent-runner'))};
const dbPath = ${JSON.stringify(join(dir, 'news.db'))};
const core = createCore(openNodeSqliteDb(dbPath), { dbPath });
core.news.updateCollectionSettings({prompt:'收集最近24小时内的新闻：1条国际重要新闻、1条中国国内重要新闻、1份AI专题简报（含1到2则子消息）。国际和国内分别入库，AI用brief保存。只收录你亲自打开原始来源并核实真实发布时间的消息，不能用采集时间代替发布时间。不足时如实说明，不编造。',max_items:3,window_hours:24,expected_revision:0});
core.agentSettings.update({provider:'codex',binary:process.env.DAYFOLIO_CODEX_BIN||'',model:process.env.DAYFOLIO_CODEX_MODEL||'',expected_revision:0});
const worker=createNewsAgentRunner({core,dbPath,nodeBinary:process.execPath,mcpServer:${JSON.stringify(join(repo, 'apps/mcp/dist/mcp-server.cjs'))}});
const run=core.newsRuns.enqueue();
console.log(JSON.stringify({dir:${JSON.stringify(dir)},run}));
worker.start();
let last='';
const timer=setInterval(async()=>{
  const next=core.newsRuns.get(run.id);
  const sig=JSON.stringify(next);
  if(sig!==last){last=sig;console.log(sig);}
  if(!['queued','running','cancelling'].includes(next.status)){
    clearInterval(timer);await worker.stop();
    const data={run:next,task:core.news.getTask(run.task_id),news:core.news.list({task_id:run.task_id})};
    console.log(JSON.stringify(data,null,2));
    core.db.close();process.exit(next.status==='succeeded'&&data.news.length>0?0:1);
  }
},1500);
process.once('SIGINT',async()=>{clearInterval(timer);await worker.stop();core.db.close();process.exit(1);});
`);
await build({entryPoints:[source],outfile,bundle:true,platform:'node',format:'cjs',external:['node:*']});
await import(pathToFileURL(outfile).href);
