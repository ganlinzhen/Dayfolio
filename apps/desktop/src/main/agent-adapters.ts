// 通用 CLI 适配层：只生成参数数组，不执行 shell，不修改用户的 CLI 配置。
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateAgentProfile, type AgentProfile, type AgentProvider } from '../../../../packages/core/src';

const exec = promisify(execFile);
export const AGENT_LABELS = { codex: 'Codex', claude: 'Claude Code', gemini: 'Gemini CLI' };
export interface AgentConnection extends AgentProfile { provider: AgentProvider }
export interface AgentStatus { available: boolean; provider: AgentProvider | null; binary: string | null; version: string | null; message: string }
export const agentEnv = (binary: string) => ({ ...process.env, PATH: [dirname(binary), process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':') });
export function agentCandidates(provider: AgentProvider, explicit = '') {
  if (explicit) return [explicit];
  const paths = [...(process.env.PATH ?? '').split(':').filter(Boolean).map(p => join(p, provider)),
    `/opt/homebrew/bin/${provider}`, `/usr/local/bin/${provider}`, join(homedir(), '.local/bin', provider)];
  try { for (const version of readdirSync(join(homedir(), '.nvm/versions/node')).reverse()) paths.push(join(homedir(), '.nvm/versions/node', version, 'bin', provider)); } catch { /* 用户未使用 nvm。 */ }
  return [...new Set(paths)];
}
export async function checkAgent(connection: AgentConnection | null): Promise<AgentStatus> {
  if (!connection) return { available: false, provider: null, binary: null, version: null, message: '请先到「设置 → 配置 Agent」选择并保存连接' };
  const { provider } = connection, label = AGENT_LABELS[provider];
  validateAgentProfile(connection);
  for (const binary of agentCandidates(provider, connection.binary)) {
    try { accessSync(binary, constants.X_OK); } catch { continue; }
    try {
      const env = agentEnv(binary);
      const { stdout } = await exec(binary, ['--version'], { env, timeout: 20000, maxBuffer: 65536 });
      const version = stdout.trim().slice(0, 200);
      if (provider === 'codex') {
        const match = version.match(/codex-cli (\d+)\.(\d+)\.(\d+)/);
        if (!match || (Number(match[1]) === 0 && Number(match[2]) < 163)) return { available: false, provider, binary, version, message: '请将本机 Codex CLI 升级至 0.163.0 或更新版本' };
        try { await exec(binary, ['login', 'status'], { env, timeout: 20000, maxBuffer: 65536 }); }
        catch { return { available: false, provider, binary, version, message: 'Codex 尚未登录，请先在终端运行 codex login' }; }
      } else {
        const { stdout: help } = await exec(binary, ['--help'], { env, timeout: 20000, maxBuffer: 262144 });
        const required = provider === 'claude' ? ['--strict-mcp-config', '--bare', '--tools'] : ['--output-format', '--allowed-mcp-server-names', '--extensions'];
        if (required.some(flag => !help.includes(flag))) return { available: false, provider, binary, version, message: `请升级 ${label}，当前 CLI 缺少后台执行所需参数` };
        if (provider === 'claude') {
          try { await exec(binary, ['auth', 'status'], { env, timeout: 20000, maxBuffer: 65536 }); }
          catch { return { available: false, provider, binary, version, message: 'Claude Code 尚未登录，请先运行 claude auth login' }; }
        }
      }
      return { available: true, provider, binary, version, message: provider === 'gemini' ? `${label} 可启动；登录、模型与联网能力在实际执行时验证` : `${label} 已连接，将使用该 CLI 的登录账户和额度` };
    } catch { return { available: false, provider, binary, version: null, message: `无法启动 ${label}，请核对路径、版本及执行权限` }; }
  }
  return { available: false, provider, binary: null, version: null, message: `未找到 ${label}，请先在本机安装，或选择可执行文件` };
}

interface Invocation { connection: AgentConnection; cwd: string; nodeBinary: string; mcpServer: string; dbPath: string; runId: string }
const tools = ['get_news_task', 'submit_news_items', 'complete_news_task', 'report_news_correction', 'submit_news_daily_summary', 'get_news_batch', 'submit_batch_news', 'summarize_batch_news', 'complete_batch_task'];
export function buildAgentInvocation({ connection, cwd, nodeBinary, mcpServer, dbPath, runId }: Invocation) {
  const { provider, model } = connection;
  const env: NodeJS.ProcessEnv = {};
  const mcp = { command: nodeBinary, args: [mcpServer], env: { TODODESK_DB: dbPath, DAYFOLIO_NEWS_RUN_ID: runId, ELECTRON_RUN_AS_NODE: '1' } };
  if (provider === 'codex') {
    const cfg: Record<string, unknown> = {
      approval_policy: 'never', web_search: 'live', project_doc_max_bytes: 0,
      'features.skip_host_skill_discovery': true, 'features.skill_search': false,
      'features.view_image': false, 'features.workspace_dependencies': false, 'features.chronicle': false,
      'features.shell_tool': false, 'features.unified_exec': false,
      'features.apps': false, 'features.plugins': false, 'features.memories': false,
      'features.multi_agent': false, 'features.browser_use': false, 'features.computer_use': false,
      ...(model ? { model } : {}),
      'mcp_servers.dayfolio_news.command': nodeBinary, 'mcp_servers.dayfolio_news.args': [mcpServer],
      'mcp_servers.dayfolio_news.env_vars': ['DAYFOLIO_NEWS_RUN_TOKEN'],
      'mcp_servers.dayfolio_news.startup_timeout_sec': 30,
    };
    for (const [key, value] of Object.entries(mcp.env)) cfg[`mcp_servers.dayfolio_news.env.${key}`] = value;
    for (const name of tools) cfg[`mcp_servers.dayfolio_news.tools.${name}.approval_mode`] = 'approve';
    const args = ['exec', '--json', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', cwd];
    for (const [key, value] of Object.entries(cfg)) args.push('-c', `${key}=${JSON.stringify(value)}`);
    return { args: [...args, '-'], env };
  }
  if (provider === 'claude') {
    const allowed = ['WebSearch', 'WebFetch', ...tools.map(name => `mcp__dayfolio_news__${name}`)];
    return { args: ['--print', '--output-format', 'stream-json', '--verbose', '--bare', '--no-session-persistence',
      '--setting-sources', '', '--settings', JSON.stringify({ disableAllHooks: true }),
      '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { dayfolio_news: mcp } }),
      '--tools', 'WebSearch,WebFetch', '--allowedTools', allowed.join(','), '--permission-mode', 'dontAsk',
      ...(model ? ['--model', model] : [])], env };
  }
  // Gemini 的配置与扩展在临时根隔离；认证文件只链接原位置，任务结束后清理链接。
  const isolatedHome = join(cwd, 'gemini-home'), configDir = join(isolatedHome, '.gemini');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const source = join(process.env.GEMINI_CLI_HOME || homedir(), '.gemini');
  for (const name of ['oauth_creds.json', 'google_accounts.json']) {
    if (existsSync(join(source, name))) symlinkSync(join(source, name), join(configDir, name));
  }
  let selectedType = process.env.GEMINI_API_KEY ? 'gemini-api-key' : 'oauth-personal';
  try { selectedType = JSON.parse(readFileSync(join(source, 'settings.json'), 'utf8')).security?.auth?.selectedType || selectedType; } catch { /* 未保存认证方式时采用 CLI 默认登录。 */ }
  const settings = { security: { auth: { selectedType } }, tools: { core: ['google_web_search', 'web_fetch'] },
    skills: { enabled: false }, mcp: { allowed: ['dayfolio_news'] },
    mcpServers: { dayfolio_news: { ...mcp, trust: true, includeTools: tools } } };
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify(settings), { mode: 0o600 });
  env.GEMINI_CLI_HOME = isolatedHome;
  return { args: ['--prompt', '执行标准输入中的新闻采集要求。', '--output-format', 'stream-json', '--allowed-mcp-server-names', 'dayfolio_news', '--extensions', 'none', ...(model ? ['--model', model] : [])], env };
}

export function parseAgentEvent(provider: AgentProvider, line: string): { progress?: string; threadId?: string; completed?: boolean; failed?: boolean } {
  const e = JSON.parse(line);
  if (provider === 'codex') return {
    ...(e.type === 'thread.started' ? { progress: '正在核实采集要求', threadId: e.thread_id } : {}),
    ...(['item.started', 'item.completed'].includes(e.type) ? { progress: e.item?.type === 'web_search' ? '正在搜索并核实新闻来源' : e.item?.tool === 'submit_news_items' ? '正在校验并保存新闻' : '正在整理新闻' } : {}),
    completed: e.type === 'turn.completed', failed: ['turn.failed', 'error'].includes(e.type),
  };
  if (provider === 'claude') return { threadId: e.type === 'system' ? e.session_id : undefined,
    progress: e.type === 'assistant' ? '正在核实来源并整理新闻' : undefined,
    completed: e.type === 'result' && e.is_error === false, failed: e.type === 'result' && e.is_error !== false };
  return { threadId: e.type === 'init' ? e.session_id : undefined,
    progress: e.type === 'tool_use' ? '正在核实来源并保存新闻' : undefined,
    completed: e.type === 'result' && e.status === 'success', failed: e.type === 'result' && e.status !== 'success' };
}
