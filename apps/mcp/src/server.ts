// 组装统一 MCP；导入本模块不会启动进程或打开用户数据库。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { version } from '../../../package.json';
import type { McpContext, ToolCatalogEntry } from './shared/context';
import { createRegistrar } from './shared/context';
import { registerRuntimeTools } from './runtime-tools';
import { wrap } from './shared/response';
import { TOOL_GROUPS } from './groups';
import { registerStudyResource } from './resources/study';
import { registerTools as todos } from './tools/todos';
import { registerTools as plans } from './tools/plans';
import { registerTools as today } from './tools/today';
import { registerTools as calendar } from './tools/calendar';
import { registerTools as news } from './tools/news';
import { registerTools as agentSettings } from './tools/agent-settings';
import { registerTools as courses } from './tools/courses';
import { registerTools as reviews } from './tools/reviews';
import { registerTools as study } from './tools/study';
import { registerTools as toolbox } from './tools/toolbox';
import { registerTools as ontology } from './tools/ontology';
import { registerTools as knowledge } from './tools/knowledge';
import { registerTools as media } from './tools/media';

export function createMcpServer(context: McpContext) {
  const server = new McpServer({ name: 'tododesk', version });
  const catalog: ToolCatalogEntry[] = [];
  registerStudyResource(server);
  todos(createRegistrar(server, TOOL_GROUPS.todos, catalog), context);
  plans(createRegistrar(server, TOOL_GROUPS.plans, catalog), context);
  today(createRegistrar(server, TOOL_GROUPS.today, catalog), context);
  calendar(createRegistrar(server, TOOL_GROUPS.calendar, catalog), context);
  news(createRegistrar(server, TOOL_GROUPS.news, catalog), context);
  agentSettings(createRegistrar(server, TOOL_GROUPS.settings, catalog), context);
  courses(createRegistrar(server, TOOL_GROUPS.courses, catalog), context);
  reviews(createRegistrar(server, TOOL_GROUPS.reviews, catalog), context);
  study(createRegistrar(server, TOOL_GROUPS.study, catalog), context);
  toolbox(createRegistrar(server, TOOL_GROUPS.toolbox, catalog), context);
  ontology(createRegistrar(server, TOOL_GROUPS.ontology, catalog), context);
  knowledge(createRegistrar(server, TOOL_GROUPS.knowledge, catalog), context);
  media(createRegistrar(server, TOOL_GROUPS.media, catalog), context);
  registerRuntimeTools(createRegistrar(server, TOOL_GROUPS.runtime, catalog), context.core, wrap);
  return { server, catalog };
}
