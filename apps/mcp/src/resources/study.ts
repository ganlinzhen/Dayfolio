import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import studyWorkflowSpec from '../../../../apps/help/docs/09-study-loop.md';

export function registerStudyResource(server: McpServer): void {
  server.resource('study-workflow', 'tododesk://study/workflow', async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text: studyWorkflowSpec }],
  }));
}
