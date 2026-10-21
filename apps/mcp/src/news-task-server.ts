// 后台 Agent 仅获得当前新闻任务的三个工具；不暴露其他业务、通用动作或数据库接口。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { version } from '../../../package.json';
import { inTx, type TodoDeskCore } from '../../../packages/core/src';
import { newsItemsSchema } from './tools/news';
import { wrap } from './shared/response';

export function createNewsTaskMcpServer(core: TodoDeskCore, runId: string, owner: string): McpServer {
  const server = new McpServer({ name: 'dayfolio-news-task', version });
  const scoped = <T>(write: boolean, fn: (taskId: number, claimToken: string) => T): T => inTx(core.db, () => {
    const run = core.db.prepare('SELECT * FROM news_agent_runs WHERE id=?').get(runId);
    if (!owner || !run || run.owner_token !== owner || run.status !== 'running') throw new Error('本次新闻执行已停止或身份无效');
    const task = core.news.getTask(Number(run.task_id));
    const claim = core.db.prepare('SELECT claim_token,claimed_by FROM news_tasks WHERE id=?').get(task.id);
    if (write && (task.status !== 'claimed' || claim?.claimed_by !== `dayfolio-run:${runId}`)) throw new Error('当前任务已结束或认领已变更');
    return fn(task.id, String(claim?.claim_token ?? ''));
  });
  server.tool('get_news_task', '读取本次采集的要求、时间窗、剩余预算和已收录结果。什么场景调用我：开始采集前读取快照，或重试时避免重复提交。', {}, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async () => wrap(() => scoped(false, taskId => ({
    now: new Date().toISOString(), task: core.news.getTask(taskId), items: core.news.list({ task_id: taskId, limit: 100 }),
  })))());
  server.tool('submit_news_items', '提交已亲自打开原始来源、核实真实发布时间的新闻。本工具仅写入本次任务；每批最多10条，累计受任务预算限制，同链接或同事件不得重复。缺少可靠来源或时间则跳过；brief 子新闻分别核实，外层链接和时间取首则。', {
    items: newsItemsSchema,
  }, { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, async ({ items }) => wrap(() => scoped(true, (taskId, token) => core.news.submitItems(taskId, token, items)))());
  server.tool('complete_news_task', '提交完毕后结束本次任务。什么场景调用我：完成采集时记录收录结果和不足原因；允许0条，不编造新闻凑数。检索不可用等执行故障不要假装正常完成，应在回复说明失败原因。', {
    note: z.string().max(500).optional(),
  }, { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, async ({ note }) => wrap(() => scoped(true, (taskId, token) => core.news.completeTask(taskId, token, note)))());
  return server;
}
