// Agent 连接偏好由 App 与 MCP 共用；这里只保存路径和模型，不保存登录凭证。
import { isAbsolute } from 'node:path';
import { inTx, type DbAdapter } from '../db';

export const AGENT_PROVIDERS = ['codex', 'claude', 'gemini'] as const;
export type AgentProvider = typeof AGENT_PROVIDERS[number];
export interface AgentProfile { binary: string; model: string }
export interface AgentSettings {
  provider: AgentProvider | null;
  profiles: Record<AgentProvider, AgentProfile>;
  revision: number;
}
export interface AgentSettingsInput {
  provider: AgentProvider | null; binary?: string; model?: string; expected_revision: number;
}
export function validateAgentProfile(input: AgentProfile): AgentProfile {
  if (typeof input.binary !== 'string' || typeof input.model !== 'string') throw new Error('Agent 路径和模型必须是文本');
  const binary = input.binary.trim(), model = input.model.trim();
  if (binary && (!isAbsolute(binary) || binary.length > 4096 || /[\x00-\x1f]/.test(binary))) throw new Error('请选择可执行文件的绝对路径，不要填写命令参数');
  if (model.length > 200 || /[\x00-\x1f]/.test(model) || model.startsWith('-')) throw new Error('模型名称无效');
  return { binary, model };
}
export function createAgentSettingsService(db: DbAdapter) {
  const get = (): AgentSettings => {
    const row = db.prepare('SELECT config,revision FROM agent_settings WHERE id=1').get();
    return row ? { ...JSON.parse(String(row.config)), revision: Number(row.revision) } : {
      provider: null, profiles: { codex: { binary: '', model: '' }, claude: { binary: '', model: '' }, gemini: { binary: '', model: '' } }, revision: 0,
    };
  };
  const update = (input: AgentSettingsInput): AgentSettings => inTx(db, () => {
    if (!input || (input.provider !== null && !AGENT_PROVIDERS.includes(input.provider))) throw new Error('请选择受支持的 Agent');
    const current = get();
    if (input.expected_revision !== current.revision) throw new Error('Agent 配置已变化，请重新加载后保存');
    if (input.provider) current.profiles[input.provider] = validateAgentProfile({ binary: input.binary ?? '', model: input.model ?? '' });
    current.provider = input.provider;
    current.revision++;
    const { revision, ...config } = current;
    db.prepare('INSERT INTO agent_settings(id,config,revision) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,revision=excluded.revision').run(JSON.stringify(config), revision);
    return current;
  });
  return { get, update };
}
export type AgentSettingsService = ReturnType<typeof createAgentSettingsService>;
