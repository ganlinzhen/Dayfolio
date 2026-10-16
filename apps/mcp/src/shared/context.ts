import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TodoDeskCore } from '../../../../packages/core/src/index';

export interface McpContext {
  core: TodoDeskCore;
  toolFilesRoot: string;
}

export interface ToolGroup {
  id: string;
  title: string;
  entity: string;
  desc: string;
  section: '业务模块' | '应用本体';
}

export interface ToolCatalogEntry {
  name: string;
  desc: string;
  group: ToolGroup;
}

export type ToolRegistrar = Pick<McpServer, 'tool'>;

/** 使用同一次真实注册采集展示信息，避免另写一份工具清单。 */
export function createRegistrar(server: McpServer, group: ToolGroup, catalog: ToolCatalogEntry[]): ToolRegistrar {
  const tool: McpServer['tool'] = (...args: unknown[]): RegisteredTool => {
    if (typeof args[0] !== 'string' || typeof args[1] !== 'string') {
      throw new Error('工具必须声明名称与中文说明');
    }
    const registered: RegisteredTool = Reflect.apply(server.tool, server, args);
    catalog.push({ name: args[0], desc: args[1], group });
    return registered;
  };
  return { tool };
}
