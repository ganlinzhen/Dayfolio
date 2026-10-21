// 复制给外部 Agent 的接入任务，只包含连接偏好，不包含账户凭证。
export function agentConnectionPrompt(input: { provider: string; label: string; binary: string; model: string }): string {
  return `请帮我将本机的 ${input.label} 接入 Dayfolio 后台任务，并实际完成检查、保存与回读验证。

目标 Agent：${input.label}（provider=${input.provider}）
当前填写的可执行路径：${input.binary.trim() || '未指定，请检测本机安装位置'}
当前填写的模型：${input.model.trim() || '留空，使用 CLI 默认模型'}

请按以下流程执行：
1. 先读取 Dayfolio 技能或 MCP 接入说明。使用 get_agent_settings 读取现有配置与最新 revision；如果当前没有这些工具，按 Dayfolio 随 App 能力包的 README 接入 MCP 或使用包内调用器，不直接修改 SQLite 或猜测配置文件。
2. 检查所选 CLI 的本机可执行路径、版本与执行权限。未指定路径时检测 PATH、Homebrew、用户本地和 nvm 安装位置；找到后使用绝对路径。Codex 至少需要 0.163.0；其他 Agent 检查其无界面执行与 MCP 参数是否可用。不要把模型服务或 API 当作 Agent CLI，不要将 CLI 塞进 Dayfolio 安装包。
3. 检查所选 CLI 的登录状态。Codex 使用 login status，Claude Code 使用 auth status；Gemini 没有可靠的独立登录检查时如实说明。若缺少 CLI、版本过旧或尚未登录，先说明具体安装、升级或登录步骤；安装升级需征得我的同意，涉及账户登录由我本人完成。不要读取、复制或回传密钥、令牌和认证文件。
4. 检查通过后，用 update_agent_settings 保存 provider、实际可执行文件的绝对路径、上述模型及最新 expected_revision。保留其他 Agent 的已保存偏好；并发冲突时重新读取，不用旧配置覆盖。路径字段只放文件路径，不附 shell 参数。若仍有安装或登录阻塞，先处理阻塞，不把不可用配置说成已接通。
5. 再次使用 get_agent_settings 回读核对；如可操作 Dayfolio，在「设置 → 配置 Agent」展开该条目并点「检查连接」。本次只完成接入，不自动发起新闻采集或消耗推理额度。

最后报告实际 CLI 路径、版本、登录检查结果、保存与回读结果，以及仍需我完成的步骤。只有已经验证的项目才能报告完成。`;
}
