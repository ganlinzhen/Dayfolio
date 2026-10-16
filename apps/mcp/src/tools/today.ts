import type { ToolRegistrar, McpContext } from '../shared/context';
import { dateSchema } from '../shared/schemas';
import { wrap } from '../shared/response';

export function registerTools(server: ToolRegistrar, { core }: McpContext): void {
  server.tool(
    'get_today',
    '今日概览：逾期待办、今日到期待办、今日学习计划安排、今日日程、已完成事项与打卡状态、连续打卡天数——向用户汇报进度或规划今天该做什么时先调这个',
    { date: dateSchema.optional().describe('缺省今天') },
    async ({ date }) => wrap(() => core.today.getToday(date))(),
  );
}
