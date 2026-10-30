import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentCandidates, buildAgentInvocation, checkAgent, parseAgentEvent } from '../src/main/agent-adapters';

describe('Agent 适配协议', () => {
  it('显式路径失败时不能偷偷回退其他已安装版本，未配置不能启动', async () => {
    expect(agentCandidates('codex', '/missing/cli')).toEqual(['/missing/cli']);
    expect((await checkAgent(null)).available).toBe(false);
    expect((await checkAgent({ provider: 'codex', binary: '/missing/cli', model: '' })).available).toBe(false);
  });
  it('三种 CLI 使用独立参数和限定 MCP，密钥不写入参数或配置文件', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-protocol-'));
    try {
      for (const provider of ['codex', 'claude', 'gemini'] as const) {
        const invocation = buildAgentInvocation({ connection: { provider, binary: '/tmp/cli', model: 'test model' }, cwd, nodeBinary: '/tmp/node', mcpServer: '/tmp/mcp.cjs', dbPath: '/tmp/test.db', runId: 'test-run' });
        expect(invocation.args).not.toContain('--dangerously-skip-permissions');
        expect(invocation.args.join(' ')).not.toContain('secret-token');
        if (provider === 'codex') expect(invocation.args).toContain('--ignore-user-config');
        if (provider === 'claude') {
          expect(invocation.args).toContain('--strict-mcp-config');
          expect(invocation.args[invocation.args.indexOf('--tools') + 1]).toBe('WebSearch,WebFetch');
        }
        if (provider === 'gemini') {
          const config = JSON.parse(readFileSync(join(cwd, 'gemini-home/.gemini/settings.json'), 'utf8'));
          expect(config.tools.core).toEqual(['google_web_search', 'web_fetch']);
          expect(config.mcp.allowed).toEqual(['dayfolio_news']);
          expect(config.mcpServers.dayfolio_news.includeTools).toEqual(['get_news_task', 'submit_news_items', 'complete_news_task', 'report_news_correction', 'submit_news_daily_summary', 'get_news_batch', 'submit_batch_news', 'summarize_batch_news', 'complete_batch_task']);
        }
      }
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  it('分别识别完成与失败，不能把有错误的最终事件当成功', () => {
    expect(parseAgentEvent('claude', JSON.stringify({type:'result',is_error:true}))).toMatchObject({completed:false,failed:true});
    expect(parseAgentEvent('gemini', JSON.stringify({type:'result',status:'error'}))).toMatchObject({completed:false,failed:true});
    expect(parseAgentEvent('codex', JSON.stringify({type:'turn.failed'})).failed).toBe(true);
  });
});
