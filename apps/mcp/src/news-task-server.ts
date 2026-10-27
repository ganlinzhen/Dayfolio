// 后台 Agent 仅获得当前新闻任务的工具；不暴露其他业务、通用动作或数据库接口。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { version } from '../../../package.json';
import { inTx, type TodoDeskCore } from '../../../packages/core/src';
import { newsItemsSchema } from './tools/news';
import { wrap } from './shared/response';

export function createNewsTaskMcpServer(core: TodoDeskCore, runId: string, owner: string): McpServer {
  const server = new McpServer({ name: 'dayfolio-news-task', version });
  const shownPriorIds = new Set<number>();
  const priorItems = (taskId: number) => {
    const context = core.newsFeed.getTaskContext(taskId);
    return context?.module_id
      ? core.newsFeed.list({ module_id: context.module_id, history: true, limit: 30 })
      : core.news.list({ task_id: taskId, limit: 30 });
  };
  const scoped = <T>(write: boolean, fn: (taskId: number, claimToken: string) => T): T => inTx(core.db, () => {
    const run = core.db.prepare('SELECT * FROM news_agent_runs WHERE id=?').get(runId);
    if (!owner || !run || run.owner_token !== owner || run.status !== 'running') throw new Error('本次新闻执行已停止或身份无效');
    const task = core.news.getTask(Number(run.task_id));
    const claim = core.db.prepare('SELECT claim_token,claimed_by FROM news_tasks WHERE id=?').get(task.id);
    if (write && (task.status !== 'claimed' || claim?.claimed_by !== `dayfolio-run:${runId}`)) throw new Error('当前任务已结束或认领已变更');
    return fn(task.id, String(claim?.claim_token ?? ''));
  });
  server.tool('get_news_task', '读取本次采集要求、固定时间窗、实时剩余预算、版本与已收录结果。什么场景调用我：开始前读取 context 快照和实时权限，重试时避免重复；prior_items 仅为当前模块近期报道，发现有实质事实更正时亲自核实来源后用 report_news_correction，不能写其他新闻。', {}, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async () => wrap(() => scoped(false, taskId => {
    const prior = priorItems(taskId);
    shownPriorIds.clear(); for (const item of prior) shownPriorIds.add(item.id);
    return {
      now: new Date().toISOString(), task: core.news.getTask(taskId), context: core.newsFeed.getTaskContext(taskId),
      items: core.news.list({ task_id: taskId, limit: 100 }), prior_items: prior,
    };
  }))());
  server.tool('submit_news_items', '提交已亲自打开原始来源、核实真实发布时间的新闻。本工具仅写入本次任务；每批最多10条，累计受任务预算限制，同链接或同事件不得重复。缺少可靠来源或时间则跳过；brief 子新闻分别核实，外层链接和时间取首则。', {
    items: newsItemsSchema,
  }, { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, async ({ items }) => wrap(() => scoped(true, (taskId, token) => core.news.submitItems(taskId, token, items)))());
  server.tool('report_news_correction', '报告本任务 prior_items 中已有报道的重要事实更正。什么场景调用我：亲自打开公开来源发现数字、主体或结果有误；仅记录更正说明与证据，不静默改写原摘要，不改变已读状态，不把普通措辞调整作为更正。禁止写其他模块或未展示的新闻。', {
    news_id: z.number().int().positive(), summary: z.string().min(1).max(2000), evidence_url: z.string().min(1).max(2048),
  }, { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, async (input) => wrap(() => scoped(true, taskId => {
    if (!shownPriorIds.has(input.news_id) || !priorItems(taskId).some(item => item.id === input.news_id)) throw new Error('只能更正本任务公开的近期新闻，请先读取 get_news_task');
    return core.newsFeed.submitCorrection(input);
  }))());
  server.tool('complete_news_task', '提交完毕后结束本次任务。什么场景调用我：完成采集时记录收录结果和不足原因；允许0条，不编造新闻凑数。检索不可用等执行故障不要假装正常完成，应在回复说明失败原因。', {
    note: z.string().max(500).optional(),
  }, { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, async ({ note }) => wrap(() => scoped(true, (taskId, token) => core.news.completeTask(taskId, token, note)))());
  return server;
}
