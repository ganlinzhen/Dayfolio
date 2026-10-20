---
name: dayfolio
description: 使用 Dayfolio 管理待办、日程、学习与课程、新闻、工具箱和自定义数据，也用于制作或更新赛事页面。教学和赛事流程包含在本技能内；优先使用已注册 MCP，否则使用包内调用器。
---

# Dayfolio

Dayfolio 是用户 macOS 上的桌面待办/学习应用（曾用名 TodoDesk、日序 Dayfolio）。App、MCP 服务、本技能共享同一个 SQLite 数据库（默认 `~/Library/Application Support/tododesk/tododesk.db`，环境变量 `TODODESK_DB` 覆盖）。**不要直接读写数据库文件**，一律走 MCP 工具，否则会绕过业务联动（打卡、连续天数、待办关联等）。

## 按任务读取内部参考

本技能是 Dayfolio 唯一对外入口，教学和赛事是内部工作流，不单独注册或展示技能。

- 用户明确要求「教我 X」「学习 X」、生成/优化课程或导入课程时，读取 [教学流程](references/teaching.md)，再调用 `get_study_workflow` 获取当前规范。只查学习进度或课程列表时直接查询，不主动启动教学。
- 用户要生成或更新体育、电竞赛事页面时，读取 [赛事页面流程](references/sports.md)，按需进入赛事模型、页面契约、来源更新及运行时订阅参考。仅问比分或赛制不自动创建页面。
- 联网采集新闻并存入 App 时读取 [新闻任务流程](references/news.md)；只查库内新闻直接使用 `list_news`。

## 接入方式（先判断，二选一）

**方式 A：客户端已注册 MCP**（工具名形如 `add_todo`、`list_todos`、`get_today`，服务名 `tododesk`）——直接调用这些工具，本技能只用来选工具和组流程。

**方式 B：客户端没有 MCP 工具**——用捆绑脚本经 stdio 直连 MCP 服务，等价于调用工具：

```bash
# 使用已安装的唯一 Dayfolio 技能；CODEX_HOME 自定义时改用其 skills/dayfolio 路径
node ~/.codex/skills/dayfolio/scripts/call.mjs list
node ~/.codex/skills/dayfolio/scripts/call.mjs call get_today
node ~/.codex/skills/dayfolio/scripts/call.mjs call add_todo '{"title":"周报","due_date":"today","priority":"高"}'
```

脚本优先使用 `TODODESK_MCP` 指定的构建产物，其次使用完整能力包内的 MCP；源码开发时定位本仓库 `apps/mcp/dist/mcp-server.cjs`，不依赖固定检出目录。保留完整能力包的目录结构；不要只拷贝单个技能目录；现有自定义服务器位置可由 `TODODESK_MCP` 指定。未构建时在仓库根运行 `npm run build:mcp`。所有工具返回统一 JSON：`{"ok":true,"data":…}` 或 `{"ok":false,"error":"…"}`。

Node 要求 22.13+ 的 22.x 或 24.x。若 shell 报 `node: command not found`（用户装的是 nvm，非交互 shell 常见），先 `source ~/.nvm/nvm.sh`，或直接用本机已安装、满足版本要求的 Node 可执行文件绝对路径。

## 常用工具速查（按场景选，完整清单以当前服务为准）

**今日与汇报**
- `get_today` — 今日概览（逾期/今日到期/今日学习/已完成/连续打卡）。**用户问"今天该干什么"或要汇报进度时先调它**

**待办**
- `add_todo` / `update_todo` / `complete_todo` / `delete_todo`：浮动排期使用 `due_date`、可空 `start_time/end_time`；只知道开始时间时可不填结束，跨日填写 `end_date`。固定时刻使用 `time_mode=instant` 和带 Z/偏移的 `scheduled_start_at/scheduled_end_at`，不混入本地字段；显示时区由共享设置决定。更新可携带 `expected_revision`；due_date 传 null 清除浮动排期。
- `list_todos` — 按状态/优先级/是否过期/关键词/标签筛选，未完成+紧急+近期在前

- `checkin` — 待办与学习条目的完成记录，同目标同日幂等；保留首次记录时间
- `get_checkin_stats` — 待办记录统计，连续天数、近 7/30 天活跃、总数与带精确时间的记录

**学习与复习**
- `create_study_plan` — 逐日安排（items：date+content），自动为每天生成待办
- `list_study_plans` / `get_study_plan` / `update_study_plan` / `delete_study_plan`
- `list_courses` / `get_course_lessons` / `delete_course`：删除前核对课程 ID、slug、标题并确认不可恢复。`delete_course` 必须传匹配的 `expected_slug`，删除该课总览、讲义、阅读自测、生成请求和资产，解除草案引用；保留计划及待办，整组删除时另调用 `delete_study_plan`。
- `update_plan_item` — 计划条目打卡核心入口：`status=done` 完成当日学习并联动待办
- `create_review_schedule` — 按遗忘曲线（默认 1/3/7/21 天）为刚学完的知识点批量生成复习任务。**用户说"学完了 X"时主动建议**

**新闻**
- `get_news_collection_settings` / `update_news_collection_settings` — 读取或保存 App 长期采集提示词；每日采集前先读取最新设置，创建请求用 `use_collection_prompt=true`，已有任务使用快照。
- `list_news` — 库内查询，**不联网**；默认近 3 个北京日期，可按 `task_id` / `search` / `filter` / `since` 筛选，`limit` + `offset` 分页
- `create_news_task` / `list_news_tasks` — 创建 AI 采集任务、查看规则与进度
- `claim_news_task` → `submit_news_items` → `complete_news_task` — 认领后用助手自己的搜索/浏览工具核实来源，再提交并收尾；中断用 `release_news_task`
- `mark_news_read` / `mark_news_starred` / `mark_all_news_read` — 已读与收藏状态，与 App 共享
- `cancel_news_task` — 用户明确同意后取消任务，已有新闻保留；`delete_news_item` — 用户确认后删除单条新闻
- 新闻采集与异常处理见下文；旧 `fetch_news`、源/话题管理和 `news:fetch` 命令已移除

**工具箱（HTML 小工具）**
- `add_tool` — 装入工具：`files`（base64 内容，现场生成的 HTML 用这个，无需落盘）或 `file_paths`（本地文件/目录）；`category_name` 不存在会自动建
- `list_tools` / `update_tool` / `delete_tool`
- `list_tool_categories` / `add_tool_category` / `rename_tool_category` / `delete_tool_category`

**运行时日程与订阅**
- `get_runtime_tool_contract` / `list_extensions` / `list_event_providers`：发现实际底座、工具身份、来源修订和更新状态。
- `import_external_events`：标准事件完整快照，稳定 externalId、batchId 与 provider 基线保证幂等；不因缺失条目删除旧活动。
- `subscribe_event` / `unsubscribe_event` / `resume_event_following`：单事件唯一待办；手动标题/排期与完成记录受保护，取消默认显式 keep。
- `query_calendar_items` / `set_calendar_collection_visibility`：统一日历及显示偏好；隐藏不取消订阅。
- `refresh_event_provider` / `get_provider_sync_run`：排队不是成功；external-agent 来源须由助手实际核验并导入。

**本体与自定义数据**（用户想建自己的数据类型/记录，如书单、阅读记录）
- `list_object_types` — 全部对象/链接/动作类型元数据。**操作自定义数据前先调它**
- `get_query_contract` — 新查询前查看字段操作符、日期语义、分组聚合能力与限额。`query_objects` 可传 `query: {version:1,objectType,where,select,orderBy,page,includeTotal}`，不能和旧参数混用；`aggregate_objects` 统计分组，`query_related_objects` 读取实际存在的关联实体。
- 自定义类型默认生成持久化基础动作，动作名称从 `list_object_types.actionTypes[].template` 发现，不拼接猜测；旧 CRUD 也受对应基础动作启停控制。`generate_actions=false` 关闭生成后，须先定义明确自定义动作再写入。
- 纯数据库动作可用 `invoke_action.options.idempotencyKey` 去重；修正参数后换新键。先 `preview_action` 读取修订，再把 definitionRevision/targets 分别放入 expectedDefinitionRevision/expectedObjects；过期重新读取，不能强行覆盖。`list_action_executions` 查结果。仅 composable=true 的命令可进入 invoke_command 步骤，结果映射 `{result:{step:0,path:["objectId"]}}` 只能引用前步，命令结果用 `value.id`。
- 列表/关系查询可用 `page:{mode:"cursor",limit:50,cursor:上页nextCursor}` 连续分页，不与 offset 混用；模型或条件变化后重新开始。不要把游标解释成跨页固定快照。
- `create_object_type`（建类型自动建表）→ `create_object` / `query_objects` / `get_object` / `update_object` / `delete_object`
- `create_link_type` / `delete_link_type` — 对象间关系（1:1 / 1:N / N:N）
- `create_action_type` / `update_action_type` / `delete_action_type` + `invoke_action` — 把一组写规则封装成事务动作
- 系统类型（todo 等）的内置字段必须使用专用业务工具或已公开动作；通用对象写入不能绕过业务校验

## 参数别名（中英文都收）

- **日期**：`today`/`今天`、`tomorrow`/`明天`、`yesterday`/`昨天`、`后天`，或 `YYYY-MM-DD`；传 `null` 表示清除（如 update_todo 的 due_date）
- **优先级**：`high`/`P0`/`高`/`紧急`、`medium`/`P1`/`中`、`low`/`P2`/`低`
- **计划条目类型**：`learn`/`学习`、`review`/`复习`、`practice`/`练习`、`rest`/`休息`

## 新闻采集

仅查询库内新闻时使用 `list_news`。用户要求联网采集并存入 App 时，按需读取 [新闻任务流程](references/news.md)，遵守认领、来源核实、提交预算和完成回读。采集由助手执行，App 不自动唤醒助手。

## 安全规则

- `delete_todo` / `delete_study_plan` / `delete_course` / `delete_tool` / `delete_object_type` 不可恢复，调用前必须向用户确认
- `create_object` / `delete_object` 仅操作自定义对象；系统内置字段必须用业务动作，`update_object` 仅允许系统用户扩展字段。关系使用 `list_object_links` / `create_link` / `delete_link`；不要直接更新关联字段或借通用动作绕过 App 人工审批。
- 工具描述里带"请先与用户确认"的，同样遵守
- `delete_news_item` 仅删除用户指定的单条新闻：先复述标题与不可恢复后果并取得确认，不批量删。删除会移除正文及已读/收藏，保留自媒体成果与来源快照、解除失效引用，并保留去重指纹防回流。`cancel_news_task` 需用户明确同意，且任务无有效认领；已入库新闻保留。

## 典型工作流

**晨间汇报**：`get_today` → 用一段话总结逾期/今日到期/今日学习，问用户要不要先处理逾期的。

**记一批待办**：逐条 `add_todo`（要进今日待办就带 `due_date: "today"`）→ `list_todos {"status":"open"}` 核对。

**学完一个知识点**：`create_review_schedule {"topics":["TS 协变与逆变"]}` → 告知用户复习日（默认第 1/3/7/21 天）。

**采集 AI 最近 24 小时新闻存入 App**：查看同主题未完成任务 → 按需 `create_news_task {"title":"AI 最近 24 小时重要新闻","instructions":"中文摘要，优先官方发布与一手报道","max_items":10,"window_hours":24}` → 指定任务 `claim_news_task` → 搜索并打开来源核实 → `submit_news_items` → `complete_news_task` → `list_news` 按任务回读。创建任务只是排队，提交成功才算收录。

**做一个网页小工具装进 App**：直接 `add_tool`，把生成的 HTML 放进 `files:[{name:"index.html", content_base64:…}]`（base64 编码后传）→ 告诉用户在 App 工具箱可见。

**建自定义数据**：`list_object_types` 看现状 → `create_object_type` 定义属性 → 需要关联就 `create_link_type` → 日常读写用 `create_object`/`query_objects`；高频组合可 `create_action_type` 封装成 `invoke_action`。
