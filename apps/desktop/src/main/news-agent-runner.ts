// 独立新闻执行器：只通过结构化事件汇报进度，通过受限 MCP 写入业务数据。
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TodoDeskCore } from '../../../../packages/core/src';
import { createNewsScheduleService } from '../../../../packages/core/src/services/news-schedule';
import type { NewsFeedBatch } from '../../../../packages/core/src/news-types';
import { agentEnv, buildAgentInvocation, checkAgent, parseAgentEvent, AGENT_LABELS, type AgentConnection } from './agent-adapters';
export type { AgentStatus as NewsAgentStatus } from './agent-adapters';
interface RunnerOptions {
  core: TodoDeskCore; dbPath: string; mcpServer: string; nodeBinary: string; timeoutMs?: number;
  /** 隔离进程测试可关闭定时触发，手动批次仍按实际服务执行。 */
  scheduling?: boolean;
}

export function createNewsAgentRunner(options: RunnerOptions) {
  const { core, dbPath, mcpServer, nodeBinary } = options;
  const owner = randomUUID();
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<void> | undefined;
  let stopping = false;
  let killActive: (() => void) | undefined;
  const schedule = createNewsScheduleService(core.db, core.newsFeed);
  let lastScheduleCheck = 0;
  let checkingSchedule = false;
  let scheduleError: string | null = null;
  const connection = (): AgentConnection | null => {
    const saved = core.agentSettings.get();
    return saved.provider ? { provider: saved.provider, ...saved.profiles[saved.provider] } : null;
  };
  const status = () => checkAgent(connection());
  const enqueueBatch = (batch: NewsFeedBatch | null) => {
    if (batch?.status === 'active' && batch.next_task_id != null) core.newsRuns.enqueue(batch.next_task_id);
  };
  const scheduleDue = () => {
    if (options.scheduling === false || checkingSchedule || Date.now() - lastScheduleCheck < 30_000) return;
    lastScheduleCheck = Date.now();
    // 独立旧任务仍可执行；不在其运行中另外建立新闻工作台批次。
    if (core.newsRuns.list().some(run => ['queued', 'running', 'cancelling'].includes(run.status)) && !core.newsFeed.listBatches().some(batch => batch.status === 'active')) return;
    checkingSchedule = true;
    void status().then(checked => {
      if (stopping) return;
      if (!checked.available) { scheduleError = checked.message; return; }
      scheduleError = null;
      enqueueBatch(schedule.tick());
    }).catch(error => { scheduleError = error instanceof Error ? error.message : '定时更新暂不可用'; }).finally(() => { checkingSchedule = false; });
  };
  const startFeedUpdate = async () => {
    const checked = await status();
    if (!checked.available) throw new Error(checked.message);
    const batch = core.newsFeed.startUpdate({ trigger: 'manual' });
    enqueueBatch(batch); tick(); return batch;
  };
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
      let taskTimeout = options.timeoutMs ?? 12 * 60_000;
      const context = core.newsFeed.getTaskContext(held.run.task_id);
      if (context?.batch_id) {
        const batch = core.newsFeed.listBatches().find(item => item.id === context.batch_id);
        if (!batch || batch.status !== 'active') throw new Error('新闻批次已停止');
        const current = batch.modules.find(item => item.task_id === held.run.task_id);
        const firstRoundRemaining = current?.phase === 1 ? batch.modules.filter(item => item.phase === 1 && !['completed', 'cancelled', 'skipped'].includes(item.status)).length : 1;
        taskTimeout = Math.min(taskTimeout, Math.max(1000, (Date.parse(batch.deadline_at) - Date.now()) / Math.max(1, firstRoundRemaining)));
      }
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
      child.stdin.end('你是 Dayfolio 新闻采集执行器。全程使用简体中文。先调用 get_news_task，严格执行其中保存的动态采集要求、固定时间窗和实时剩余预算。优先寻找上次更新后的新增事实或实质进展，已有内容不要重复提交；先及时保存少量已核实重点，再继续补充。使用实时网页搜索，并逐条打开原始来源核实标题、事实及真实发布时间；不要仅凭搜索摘要或记忆提交。不要使用本机文件、其他技能或其他任务。通过 submit_news_items 保存独立图文新闻，每批最多10条，失败时修正输入；旧任务的brief子消息必须各有来源和真实时间。优先提取来源原图并标注图片来源与图注，没有可靠图片就省略，不生成伪现场图片。若发现get_news_task所列既有新闻有实质错误或来源撤回，用report_news_correction附核实依据，不静默改写原摘要。最后通过 complete_news_task 记录实际结果及缺口。没有合格新闻可以0条完成，但搜索不可用、认证失败或无法联网属于失败，请说明并停止。当前执行有时间预算，请先保存核实结果，不为凑数持续等待。最后简短汇报。');
      const poll = setInterval(() => {
        try {
          if (stopping || core.newsRuns.get(id).status === 'cancelling') { reason = 'cancelled'; stopChild(); return; }
          // 撤回时事、关闭学习及预算失效优先于不可变提示词快照。
          core.newsFeed.getTaskContext(held.run.task_id);
        }
        catch { reason = 'failed'; stopChild(); }
      }, 500);
      const deadline = setTimeout(() => { reason = 'timeout'; stopChild(); }, taskTimeout);
      const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => {
        clearInterval(poll); clearTimeout(deadline); if (hardKill) clearTimeout(hardKill);
        // 包括 MCP 在内的进程组必须停止，再释放业务认领。
        signal('SIGKILL');
      });
      if (reason === 'cancelled') core.newsRuns.finish(id, owner, 'cancelled');
      else if (reason === 'timeout') core.newsRuns.finish(id, owner, 'failed', '本模块时间预算已到，已收录内容保留；其余模块将继续，可手动接续');
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
    if (stopping) return;
    scheduleDue();
    if (active) return;
    try {
      const batch = core.newsFeed.listBatches().find(item => item.status === 'active');
      if (batch) enqueueBatch(core.newsFeed.advance(batch.id));
      for (const run of core.newsRuns.list().filter(item => item.status === 'queued')) {
        try { core.newsFeed.getTaskContext(run.task_id); }
        catch { core.newsRuns.cancel(run.id); }
      }
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
  return { status, start, stop, tick, startFeedUpdate, scheduleStatus: () => ({ ...schedule.getStatus(), error: scheduleError }) };
}
