// IPC 通道注册：渲染进程与核心服务之间的桥梁
import { clipboard, dialog, ipcMain, shell } from 'electron';
import {
  defaultDbPath,
  runtimeErrorInfo,
  deleteToolFilesAt,
  sanitizeToolPath,
  listToolFiles,
  saveToolFilesTo,
  type TodoDeskCore,
  type ToolItem,
} from '../../../../packages/core/src/index';
import type { createNewsAgentRunner } from './news-agent-runner';
import { registerDataIpc } from './data-ipc';
import { registerAgentIpc } from './agent-ipc';
import { toolsRoot } from './tools-store';
import { registerExtensionIpc } from './extension-ipc';
import { registerRuntimeIpc } from './runtime-ipc';
import { registerToolTodoIpc } from './tool-todo-ipc';
import { registerNewsFeedIpc } from './news-feed-ipc';
import { checkAgent, type AgentConnection } from './agent-adapters';
import { AGENT_PROVIDERS } from '../../../../packages/core/src';

// 统一 IPC 信封：{ok, data|error}。async/await 包装——处理器返回 Promise 时先等待再装入 data，
// 否则 Promise 会被结构化克隆成空对象（pickExportDir 的目录对话框等异步处理器都依赖这一点）
const handle = (channel: string, fn: (payload: unknown) => unknown) => {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      return { ok: true, data: await fn(payload) };
    } catch (e) {
      const info=runtimeErrorInfo(e);return {ok:false,error:info.message,code:info.code,retryable:info.retryable};
    }
  });
};

export function registerIpc(core: TodoDeskCore, newsAgent: ReturnType<typeof createNewsAgentRunner>): void {
  registerRuntimeIpc(core);
  registerToolTodoIpc(core);
  registerNewsFeedIpc(core, newsAgent);
  registerExtensionIpc(core);
  registerAgentIpc();
  // 数据面板 / 本体管理（对象·链接·动作三类型）
  registerDataIpc(core);
  handle('agentSettings:get', () => core.agentSettings.get());
  handle('agentSettings:update', p => core.agentSettings.update(p as never));
  handle('agentSettings:check', p => {
    const input = p as AgentConnection;
    if (!input || !AGENT_PROVIDERS.includes(input.provider)) throw new Error('请选择受支持的 Agent');
    return checkAgent(input);
  });
  handle('agentSettings:pickBinary', async () => {
    const result = await dialog.showOpenDialog({ title: '选择 Agent CLI 可执行文件', properties: ['openFile', 'showHiddenFiles'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  // 待办
  handle('todos:list', (p) => core.todos.list((p as never) ?? {}));
  handle('todos:add', (p) => core.todos.add(p as never));
  handle('todos:update', (p) => {
    const { id, ...patch } = p as { id: number };
    return core.todos.update(id, patch as never);
  });
  handle('todos:complete', (p) => core.todos.complete((p as { id: number }).id));
  handle('todos:reopen', (p) => core.todos.reopen((p as { id: number }).id));
  handle('todos:delete', (p) => {
    core.todos.remove((p as { id: number }).id);
    return true;
  });

  // 学习计划
  handle('plans:create', (p) => core.plans.create(p as never));
  handle('plans:list', (p) => core.plans.list((p as { status?: never })?.status));
  handle('plans:get', (p) => core.plans.get((p as { id: number }).id));
  handle('plans:updateItemStatus', (p) =>
    core.plans.updateItemStatus((p as { id: number }).id, (p as { status: never }).status),
  );
  handle('plans:update', (p) => {
    const { id, ...patch } = p as { id: number };
    return core.plans.update(id, patch as never);
  });
  handle('plans:delete', (p) => {
    const { id, delete_todos } = p as { id: number; delete_todos?: boolean };
    core.plans.remove(id, { delete_todos });
    return true;
  });

  // 打卡与今日概览
  handle('checkins:checkin', (p) => core.checkins.checkin(p as never));
  handle('checkins:list', (p) => core.checkins.listDetailed((p as never) ?? {}));
  handle('checkins:stats', () => core.checkins.stats());
  handle('today:get', (p) => core.today.getToday((p as { date?: string })?.date));

  // 日历（今日页月视图）：日程 CRUD + 区间聚合（待办/学习/打卡叠加）
  handle('calendar:list', (p) => core.calendar.list((p as never) ?? {}));
  handle('calendar:rangeAgenda', (p) => core.calendar.rangeAgenda(p as never));
  handle('calendar:add', (p) => core.calendar.add(p as never));
  handle('calendar:update', (p) => {
    const { id, ...patch } = p as { id: number };
    return core.calendar.update(id, patch as never);
  });
  handle('calendar:delete', (p) => {
    core.calendar.remove((p as { id: number }).id);
    return true;
  });

  // 学习闭环（agent 经 MCP 写入，App 侧展示 + 必要的确认/导出控件；无手工建计划表单）
  handle('study:listDrafts', (p) => core.study.listDrafts((p as { status?: never })?.status));
  handle('study:getDraft', (p) => core.study.getDraft((p as { id: number }).id));
  handle('study:confirmDraft', (p) =>
    core.study.confirmDraft((p as { id: number }).id, { confirmed_over_dates: (p as { confirmed_over_dates?: string[] }).confirmed_over_dates }),
  );
  handle('study:cancelDraft', (p) => core.study.cancelDraft((p as { id: number }).id));
  // 无日期专题草案的排期（App 侧：预览冲突/依赖 → 用户确认 → 事务排期；幂等）
  handle('study:previewSchedule', (p) =>
    core.study.previewDraftSchedule((p as { id: number }).id, (p as { start_date: string }).start_date, (p as { daily_minutes: number }).daily_minutes),
  );
  handle('study:scheduleDraft', (p) =>
    core.study.scheduleDraft(
      (p as { id: number }).id,
      (p as { start_date: string }).start_date,
      (p as { daily_minutes: number }).daily_minutes,
      { confirmed_over_dates: (p as { confirmed_over_dates?: string[] }).confirmed_over_dates },
    ),
  );
  handle('study:getProgress', (p) => core.study.getProgress((p as { plan_id?: number } | undefined)?.plan_id));
  handle('study:recordSession', (p) => core.study.recordSession(p as never));
  handle('study:copyPrompt', (p) => {
    const text = (p as { text: string }).text;
    if (typeof text !== 'string' || text.length > 100000) throw new Error('提示词内容无效');
    clipboard.writeText(text);
    return true;
  });
  handle('study:listSessions', (p) => core.study.listSessions((p as never) ?? {}));
  handle('study:listAssessments', (p) => core.study.listAssessments((p as never) ?? {}));
  handle('study:getMastery', (p) => core.study.getMastery((p as never) ?? {}));
  handle('study:suggestAdjustments', (p) => core.study.suggestAdjustments((p as { plan_id: number }).plan_id));
  handle('study:applyAdjustments', (p) =>
    core.study.applyAdjustments(
      (p as { plan_id: number }).plan_id,
      (p as { suggestions?: Array<{ id: string; to_date: string }> }).suggestions ?? [],
    ),
  );
  handle('study:previewCards', (p) => core.study.previewCards((p as never) ?? {}));
  handle('study:exportCards', (p) => {
    const { export_dir, ...selector } = p as { export_dir: string };
    return core.study.exportCards(selector, export_dir);
  });
  handle('study:listCardExports', () => core.study.listCardExports());
  // 卡片导出目录选择（系统对话框）；取消选择返回 null，渲染层不触发导出
  handle('study:pickExportDir', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
  });

  // 每日新闻（agent-only）：App 只持久展示任务/规则/结果与旧收藏，不抓取、不配置源、无定时器。
  // 新闻生产由 agent 经 MCP 认领任务后提交（core 层硬校验）。
  // 用户可在 App 发起任务（createTask，同一 core 硬校验）与取消待执行任务；
  // 认领/提交/完成/释放不暴露给渲染层；后台 Codex 通过限定任务的 MCP 提交。
  handle('news:agentStatus', () => newsAgent.status());
  handle('news:agentRuns', p => core.newsRuns.list((p as { task_id?: number } | undefined)?.task_id));
  handle('news:runAgent', async p => {
    const status = await newsAgent.status();
    if (!status.available) throw new Error(status.message);
    const run = core.newsRuns.enqueue((p as { task_id?: number } | undefined)?.task_id);
    newsAgent.tick(); return run;
  });
  handle('news:stopAgent', p => core.newsRuns.cancel((p as { run_id: string }).run_id));
  handle('news:collectionSettings', () => core.news.getCollectionSettings());
  handle('news:updateCollectionSettings', (p) => core.news.updateCollectionSettings(p as never));
  handle('news:list', (p) => core.news.list((p as never) ?? {}));
  handle('news:tasks', (p) => core.news.listTasks((p as never) ?? {}));
  handle('news:cancelTask', (p) => core.news.cancelTask((p as { id: number }).id));
  // 已读 / 收藏（与 MCP 双向共享同一持久状态）
  handle('news:markRead', (p) => core.news.markRead((p as { id: number }).id, (p as { read?: boolean }).read ?? true));
  handle('news:markStarred', (p) => core.news.markStarred((p as { id: number }).id, (p as { starred?: boolean }).starred ?? true));
  handle('news:markAllRead', (p) =>
    core.news.markAllRead({ task_id: (p as { task_id?: number } | undefined)?.task_id }),
  );
  // 用户手动删除单条新闻（渲染层已弹确认；core 单事务：指纹 + 独占关联 + 正文，幂等）
  handle('news:delete', (p) => core.news.deleteItem((p as { id: number }).id));
  handle('news:openUrl', (p) => {
    const raw = String((p as { url: string }).url ?? '');
    let url: URL;
    try { url = new URL(raw); } catch { return false; }
    // 外部浏览器同样只放行干净的 http(s)，避免 file: / javascript: 等协议
    if ((url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === '') {
      void shell.openExternal(url.toString());
    }
    return true;
  });
  // 教学课程（v6）：导入/列表/阅读/答题/样课确认/生成请求——入口统一走 core 校验
  handle('courses:import', (p) => core.courses.importCourse(String((p as { staging_dir: string }).staging_dir)));
  handle('courses:list', () => core.courses.listCourses());
  handle('courses:remove', (p) => {
    const { course_id, expected_slug } = p as { course_id: number; expected_slug: string };
    return core.courses.remove(course_id, expected_slug);
  });
  handle('courses:lessons', (p) => core.courses.listLessons((p as { course_id: number }).course_id));
  handle('courses:overviewHtml', (p) => {
    const overview = core.courses.getOverview((p as { course_id: number }).course_id);
    return overview ? { overview, html: core.courses.readOverviewHtml(overview) } : null;
  });
  handle('courses:lessonHtml', (p) => {
    const { course_id, day } = p as { course_id: number; day: number };
    const lesson = core.courses.getLesson(course_id, day);
    return { lesson, html: core.courses.readLessonHtml(lesson) };
  });
  handle('courses:markRead', (p) => core.courses.markLessonRead((p as { course_id: number }).course_id, (p as { day: number }).day));
  handle('courses:submitQuiz', (p) =>
    core.courses.submitQuiz((p as { course_id: number }).course_id, (p as { day: number }).day, (p as { answers: never }).answers),
  );
  handle('courses:confirmSample', (p) => core.commands.human.confirmCourseSample((p as { course_id: number }).course_id));
  handle('courses:createRequest', (p) => core.courses.createGenerationRequest((p as { course_id: number }).course_id, 'app'));
  handle('courses:listRequests', (p) => core.courses.listRequests((p as never) ?? {}));

  // 联网抓取/源管理/定时抓取通道已随 agent-only 改版移除（2026-10-11）：
  // App 不抓 RSS、不配置新闻源或凭证、不运行任何定时抓取；待执行任务由 agent 经 MCP 认领。

  // 工具箱：分类与工具的 CRUD。新增/更新工具时把上传文件写入数据库旁的 tools/<id>/
  //（与 MCP Server 同一实现、同一目录，agent 添加的工具 App 里直接可见）
  handle('tools:listCategories', () => core.tools.listCategories());
  handle('tools:addCategory', (p) => core.tools.addCategory(p as never));
  handle('tools:renameCategory', (p) =>
    core.tools.renameCategory((p as { id: number }).id, String((p as { name: string }).name ?? '')),
  );
  handle('tools:deleteCategory', (p) => {
    core.tools.deleteCategory((p as { id: number }).id);
    return true;
  });
  handle('tools:reorderCategories', (p) => {
    core.tools.reorderCategories(((p as { ids: number[] }).ids ?? []).map(Number));
    return core.tools.listCategories();
  });

  handle('tools:list', () => core.tools.listTools());
  handle('tools:listFiles', p => {
    const id = (p as { id: number }).id;
    core.tools.getTool(id);
    return listToolFiles(toolsRoot(), id);
  });
  handle('tools:reorder', p => {
    core.tools.reorderTools((p as { ids: number[] }).ids);
    return core.tools.listTools();
  });
  handle('tools:add', (p) => {
    const { title, icon, icon_background, category_id, files, entry_file } = p as {
      title: string;
      icon?: string;
      icon_background?: string;
      entry_file?: string;
      category_id?: number | null;
      files: Array<{ name: string; contentBase64: string }>;
    };
    const list = Array.isArray(files) ? files : [];
    const entry = list.find((f) => /\.html?$/i.test(f.name));
    if (!entry) throw new Error('请选择一个 HTML 文件作为入口');
    const tool = core.tools.addTool({
      title,
      icon,
      icon_background,
      category_id: category_id ?? null,
      entry_file: sanitizeToolPath(entry_file ?? entry.name),
      files:list,
    });
    return tool;
  });
  handle('tools:update', (p) => {
    const { id, title, icon, icon_background, category_id, files, entry_file } = p as {
      id: number;
      title?: string;
      icon?: string;
      icon_background?: string;
      entry_file?: string;
      category_id?: number | null;
      files?: Array<{ name: string; contentBase64: string }>;
    };
    const patch: Record<string, unknown> = {};
    if (title !== undefined) patch.title = title;
    if (icon !== undefined) patch.icon = icon;
    if (icon_background !== undefined) patch.icon_background = icon_background;
    if (entry_file !== undefined) patch.entry_file = sanitizeToolPath(entry_file);
    if (category_id !== undefined) patch.category_id = category_id;
    const list = Array.isArray(files) ? files : null;
    if (list && list.length > 0) {
      const entry = list.find((f) => /\.html?$/i.test(f.name));
      if (!entry) throw new Error('文件中缺少 HTML 入口');
      patch.entry_file = sanitizeToolPath(entry_file ?? entry.name);
      patch.files=list;
      return core.tools.updateTool(id, patch as never);
    }
    return core.tools.updateTool(id, patch as never);
  });
  handle('tools:delete', (p) => {
    const id = (p as { id: number }).id;
    core.tools.deleteTool(id);

    return true;
  });

  // ---- 知识库 vault（只读联动：索引/搜索/阅读/概念关联；绝不写 vault 文件） ----
  handle('vault:pickRoot', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
  });
  handle('vault:register', (p) => core.vaults.register(p as never));
  handle('vault:list', () => core.vaults.list());
  handle('vault:update', (p) => {
    const { id, ...patch } = p as { id: number };
    return core.vaults.update(id, patch as never);
  });
  handle('vault:remove', (p) => {
    core.vaults.remove((p as { id: number }).id);
    return true;
  });
  handle('vault:scan', (p) => core.vaults.scan((p as { id: number }).id));
  handle('vault:notes', (p) => core.vaults.listNotes((p as never) ?? {}));
  handle('vault:getNote', (p) => {
    const { vault_id, rel_path } = p as { vault_id: number; rel_path: string };
    return core.vaults.getNote(vault_id, rel_path);
  });
  handle('vault:linkConcept', (p) => core.vaults.linkConcept(p as never));
  handle('vault:unlinkConcept', (p) => {
    core.vaults.unlinkConcept((p as { id: number }).id);
    return true;
  });
  handle('vault:listConceptLinks', (p) => core.vaults.listConceptLinks((p as never) ?? {}));
  handle('vault:revealInFinder', (p) => {
    const { vault_id, rel_path } = p as { vault_id: number; rel_path: string };
    shell.showItemInFolder(core.vaults.noteAbsolutePath(vault_id, rel_path));
    return true;
  });

  // ---- 自媒体工作流（选题/内容/素材/日历/复盘；审核与发布回填为用户在 App 的动作） ----
  handle('media:addTopic', (p) => core.media.addTopic(p as never));
  handle('media:listTopics', (p) => core.media.listTopics((p as never) ?? {}));
  handle('media:updateTopic', (p) => {
    const { id, ...patch } = p as { id: number };
    return core.media.updateTopic(id, patch as never);
  });
  handle('media:deleteTopic', (p) => {
    core.media.deleteTopic((p as { id: number }).id);
    return true;
  });
  handle('media:addContent', (p) => core.media.addContent(p as never));
  handle('media:listContents', (p) => core.media.listContents((p as never) ?? {}));
  handle('media:getContent', (p) => core.media.getContent((p as { id: number }).id));
  handle('media:updateContent', (p) => {
    const { id, ...patch } = p as { id: number };
    return core.media.updateContent(id, patch as never);
  });
  handle('media:deleteContent', (p) => {
    core.media.deleteContent((p as { id: number }).id);
    return true;
  });
  handle('media:addVersion', (p) => {
    const { content_id, ...rest } = p as { content_id: number };
    return core.media.addVersion(content_id, rest as never);
  });
  handle('media:updateVersion', (p) => {
    const { id, ...patch } = p as { id: number };
    return core.media.updateVersion(id, patch as never);
  });
  // 审核动作（submit/approve/reject/revoke）：approve/reject 是用户在 App 内的亲自动作
  handle('media:reviewVersion', (p) => {
    const { id, action, note } = p as { id: number; action: 'submit' | 'approve' | 'reject' | 'revoke'; note?: string };
    return core.commands.human.reviewMediaVersion(id, action, note);
  });
  handle('media:addMaterial', (p) => core.media.addMaterial(p as never));
  handle('media:listMaterials', (p) => core.media.listMaterials((p as never) ?? {}));
  handle('media:updateMaterial', (p) => {
    const { id, ...patch } = p as { id: number };
    return core.media.updateMaterial(id, patch as never);
  });
  handle('media:deleteMaterial', (p) => {
    core.media.deleteMaterial((p as { id: number }).id);
    return true;
  });
  handle('media:attachMaterial', (p) => {
    core.media.attachMaterial((p as { content_id: number }).content_id, (p as { material_id: number }).material_id);
    return true;
  });
  handle('media:detachMaterial', (p) => {
    core.media.detachMaterial((p as { content_id: number }).content_id, (p as { material_id: number }).material_id);
    return true;
  });
  handle('media:schedule', (p) => core.media.schedule(p as never));
  handle('media:listCalendar', (p) => core.media.listCalendar((p as never) ?? {}));
  handle('media:markPublished', (p) => {
    const { id, ...rest } = p as { id: number };
    return core.media.markPublished(id, rest as never);
  });
  handle('media:cancelSchedule', (p) => core.media.cancelSchedule((p as { id: number }).id));
  handle('media:addMetric', (p) => core.media.addMetric(p as never));
  handle('media:listMetrics', (p) => core.media.listMetrics((p as never) ?? {}));
  handle('media:overview', () => core.media.getOverview());
  handle('media:stats', (p) => core.media.getStats((p as never) ?? {}));
  handle('media:pickExportDir', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
  });
  handle('media:exportPackage', (p) => {
    const { content_id, export_dir } = p as { content_id: number; export_dir: string };
    return core.media.exportPackage(content_id, export_dir);
  });
}
