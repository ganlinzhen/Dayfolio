// 独立新闻执行器：只通过结构化事件汇报进度，通过受限 MCP 写入业务数据。
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TodoDeskCore } from '../../../../packages/core/src';
import { agentEnv, buildAgentInvocation, checkAgent, parseAgentEvent, AGENT_LABELS, type AgentConnection } from './agent-adapters';
export type { AgentStatus as NewsAgentStatus } from './agent-adapters';
interface RunnerOptions {
  core: TodoDeskCore; dbPath: string; mcpServer: string; nodeBinary: string; timeoutMs?: number;
}

export function createNewsAgentRunner(options: RunnerOptions) {
  const { core, dbPath, mcpServer, nodeBinary } = options;
  const owner = randomUUID();
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<void> | undefined;
  let stopping = false;
  let killActive: (() => void) | undefined;
  const connection = (): AgentConnection | null => {
    const saved = core.agentSettings.get();
    return saved.provider ? { provider: saved.provider, ...saved.profiles[saved.provider] } : null;
  };
  const status = () => checkAgent(connection());
  const execute = async (held: NonNullable<ReturnType<TodoDeskCore['newsRuns']['claimNext']>>) => {
    const id = held.run.id;
    const cwd = join(dirname(dbPath), 'news-agent', id);
    let exitCleanup: (() => void) | undefined;
    try {
      // 每次启动读取一份配置，运行中切换设置不会改变已有子进程。
      const selected = connection();
      const checked = await checkAgent(selected);
      if (!selected || !checked.available || !checked.binary) throw new Error(checked.message);
      const label = AGENT_LABELS[selected.provider];
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
      const invocation = buildAgentInvocation({ connection: selected, cwd, nodeBinary, mcpServer, dbPath, runId: id });
      const child = spawn(checked.binary, invocation.args, { cwd, env: { ...agentEnv(checked.binary), ...invocation.env, DAYFOLIO_NEWS_RUN_TOKEN: owner }, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
      let reason: string | undefined;
      let turnCompleted = false;
      let buffer = '';
      let failure = '';
      let hardKill: ReturnType<typeof setTimeout> | undefined;
      const signal = (sig: NodeJS.Signals) => {
        try { if (process.platform === 'win32') child.kill(sig); else if (child.pid) process.kill(-child.pid, sig); } catch { /* 进程已退出。 */ }
      };
      const stopChild = () => {
        if (hardKill) return;
        signal('SIGTERM'); hardKill = setTimeout(() => signal('SIGKILL'), 3000);
      };
      exitCleanup = () => signal('SIGKILL');
      process.once('exit', exitCleanup);
      killActive = () => { reason = 'cancelled'; stopChild(); };
      const consume = (line: string) => {
        try {
          const event = parseAgentEvent(selected.provider, line);
          if (event.progress || event.threadId) core.newsRuns.progress(id, owner, event.progress || '正在执行采集', event.threadId);
          if (event.completed) turnCompleted = true;
          if (event.failed) failure = `${label} 执行失败，请检查网络、登录和账户额度后重试`;
        } catch { /* 非 JSON 诊断或过期执行事件不写入公开状态。 */ }
      };
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        let cut: number;
        while ((cut = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, cut)); buffer = buffer.slice(cut + 1); }
        if (buffer.length > 2_000_000) { failure = `${label} 输出超过限制`; reason = 'failed'; stopChild(); }
      });
      // 标准错误可能包含本地路径或令牌，不落公开日志；失败展示稳定、可操作的中文原因。
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => {});
      child.stdin.end('你是 Dayfolio 新闻采集执行器。全程使用简体中文。先调用 get_news_task，严格执行其中保存的采集要求、时间窗和剩余预算。使用实时网页搜索，并逐条打开原始来源核实标题、事实及真实发布时间；不要仅凭搜索摘要或记忆提交。不要使用本机文件、其他技能或其他任务。通过 submit_news_items 保存结果，每批最多10条，失败时修正输入，重复项跳过；brief 子消息必须各有来源和真实时间。最后通过 complete_news_task 记录实际结果及缺口。没有合格新闻可以0条完成，但如果搜索工具不可用、认证失败或无法联网，请说明失败并停止，不要假装采集完成。最后简短汇报。');
      const poll = setInterval(() => {
        try { if (stopping || core.newsRuns.get(id).status === 'cancelling') { reason = 'cancelled'; stopChild(); } }
        catch { reason = 'failed'; stopChild(); }
      }, 500);
      const deadline = setTimeout(() => { reason = 'timeout'; stopChild(); }, options.timeoutMs ?? 12 * 60_000);
      const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => {
        clearInterval(poll); clearTimeout(deadline); if (hardKill) clearTimeout(hardKill);
        // 包括 MCP 在内的进程组必须停止，再释放业务认领。
        signal('SIGKILL');
      });
      if (reason === 'cancelled') core.newsRuns.finish(id, owner, 'cancelled');
      else if (reason === 'timeout') core.newsRuns.finish(id, owner, 'failed', '采集超过12分钟，已停止；已收录内容保留，可重试');
      else if (code !== 0 || failure || !turnCompleted) core.newsRuns.finish(id, owner, 'failed', failure || `${label} 未正常完成，请检查网络、登录或版本后重试`);
      else core.newsRuns.finish(id, owner, 'succeeded');
    } catch (e) {
      core.newsRuns.finish(id, owner, 'failed', e instanceof Error ? e.message : '后台执行失败');
    } finally {
      if (exitCleanup) process.removeListener('exit', exitCleanup);
      killActive = undefined;
      rmSync(cwd, { recursive: true, force: true });
    }
  };
  const tick = () => {
    if (stopping || active) return;
    try {
      const held = core.newsRuns.claimNext(owner, process.pid);
      if (held) active = execute(held).catch(() => { /* 动作被停用等故障由持久状态和下次恢复处理，不能形成未处理拒绝。 */ }).finally(() => { active = undefined; });
    } catch { /* 短时数据库竞争留待下一次检查。 */ }
  };
  const start = () => {
    if (timer) return;
    stopping = false;
    for (const run of core.newsRuns.list()) if (['running', 'cancelling'].includes(run.status)) {
      try { core.newsRuns.recover(run.id); } catch { /* 其他仍活跃的宿主不接管。 */ }
    }
    timer = setInterval(tick, 1000); tick();
  };
  const stop = async () => { stopping = true; if (timer) clearInterval(timer); timer = undefined; killActive?.(); await active; };
  return { status, start, stop, tick };
}
