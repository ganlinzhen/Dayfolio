---
name: dayfolio
description: 使用 Dayfolio 管理待办、日程、学习与课程、新闻、工具箱和自定义数据，也用于制作或更新赛事页面。教学和赛事流程包含在本技能内；优先使用已注册 MCP，否则使用包内调用器。
---

# Dayfolio

Dayfolio 是用户 macOS 上的桌面待办/学习应用（曾用名 TodoDesk、日序 Dayfolio）。App、MCP 服务、本技能共享同一个 SQLite 数据库（默认 `~/Library/Application Support/tododesk/tododesk.db`，环境变量 `TODODESK_DB` 覆盖）。**不要直接读写数据库文件**，一律走 MCP 工具，否则会绕过业务联动（打卡、连续天数、待办关联等）。

## 按任务读取内部参考

本技能是 Dayfolio 唯一对外入口，教学和赛事是内部工作流，不单独注册或展示技能。

- 用户明确要求「教我 X」「学习 X」、生成/优化课程或导入课程时，读取 [教学流程](references/teaching.md)，再调用 `get_study_workflow` 获取当前规范。只查学习进度或课程列表时直接查询，不主动启动教学。
- 用户要生成或更新体育、电竞赛事页面时，读取 [赛事页面流程](references/sports.md)，按需进入赛事模型、视觉生成与验收、页面契约、来源更新及运行时订阅参考。仅问比分或赛制不自动创建页面。
- 制作或修改任意 HTML 工具时，先按内容判断待办接入价值，读取 [HTML 待办接口](references/html-todos.md) 的判断规则。赛事、活动、截止事项及可执行的学习或行动清单，默认补上合适的单项或批量「加入待办」入口，并在交付时说明；纯计算、解码、只读查询工具按实际价值决定。用户明确要求原样导入或只要展示时遵从其范围。
- 内容会持续改期或补充事项、且有可核实的稳定来源时，读取 [HTML 持续关注](references/html-following.md)，主动提供合适的单项/分组关注入口及通用来源清单；保持一次性添加与持续关注分开，真实关注须用户确认。更新已接入工具时同步发布来源修订，不能只更新页面外观。
- 配置新闻模块、联网采集、管理兴趣或临时时事时，读取 [新闻模块与兴趣流程](references/news.md)；只查库内新闻先用 `list_news_daily_editions` / `get_news_daily_edition`，单条检索用 `list_news_feed` / `list_news`，不启动采集。

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
- `get_news_feed_config` / `update_news_feed_config` / `preview_news_feed` — 读取、保存和预览结构化模块配置；先读 revision，保存带 expected_revision。默认国内、国际、AI、时事关注，俄乌与美伊共用时事模块。首页每天每模块一条 AI 重点综合总结，同日更新累计去重条数；点击模块列表再进单条详情，每轮最多 10 则，同日累计可更多。
- `start_news_feed_update` → `claim_news_task` → `get_news_task_context` → 搜索并打开原始来源核实 → `submit_news_items` → `complete_news_task` → `advance_news_feed_update` — 在当前对话连续完成模块采集并回读；活动批次复用，先覆盖再补足，不因重试重置预算。
- `list_news_daily_editions` / `get_news_daily_edition` — 读取首页每日模块及完整累计列表，筛选按内部新闻状态匹配。`save_news_daily_summary` 根据实际重点新闻保存综合总结、依据 IDs 和当前 revision，不拼接标题冒充总结。
- `list_news_feed` / `list_news` — 只查本地单条新闻，不联网；按模块、未读、收藏、关键词或历史筛选。`list_news_feed_batches` 查看整轮与模块进度，`stop_news_feed_update` / `continue_news_feed_update` 停止或接续同一批次。
- `get_news_interests` / `record_news_feedback` / `manage_news_topic` / `manage_news_source` — 查看真实推荐依据、按用户明确意图记录反馈和管理主题/来源。学习默认关闭；助手回读不伪造阅读。探索每轮一个具体细分主题、1–2 则已核实试读，随新闻提交带真实依据的 `candidate_topic`。取消关注、少推荐与移除候选分开：降频或候选冷却保留已有订阅，不自动取消关注。
- `update_news_event` 管理时事暂停、期限、结束与明确恢复；`reset_news_learning` 按用户要求清空学习，保留明确关注/结束记录，不自动回放旧收藏。`report_news_correction` / `dismiss_news_correction` 记录有来源的重要更正和已查看状态，不强标未读。
- `mark_news_read` / `mark_news_starred` / `mark_all_news_read` 与 App 共用状态；`delete_news_item` 仅在用户确认后删除指定单条。临时单主题任务可用 `create_news_task`，默认每日更新使用模块批次。
- App 在北京时间 08:00、12:00、17:00 开始调用已配置的本机 Agent，也可手动更新；彻底退出或关机期间不能采集，恢复后合并补最新一次。当前对话更新由当前助手完成，不只创建任务等待后续会话。
- 本次升级保留现有模块新闻并回填每日记录；更早 0.46 模型切换清理旧抓取新闻、旧采集模型、旧自定义 daily_brief 及其专属本体/派生动作；自媒体成果保留来源标题/原链快照。不要把旧源/话题对象或历史长提示词当作当前配置入口；详细预算、撤回和异常处理见 [新闻模块与兴趣流程](references/news.md)。

**工具箱（仅 HTML）**
- App 工具首页只有「编辑」和「导入」；编辑模式支持分类管理、工具排序与分组、名称/图标/本地图片/背景/HTML 入口/完整文件集编辑，删除入口在编辑弹窗中。元信息编辑保留原文件，替换文件须提交完整目录。没有启停、卸载或版本管理；不再生成、预览或安装运行时工具包。
- `add_tool` — 导入 HTML：`files`（base64 内容，现场生成的 HTML 用这个，无需落盘）或 `file_paths`（本地文件/目录）；`category_name` 不存在会自动建
- `list_tools` / `update_tool` / `reorder_tools` / `delete_tool`
- `preview_tool_todos` / `add_tool_todos` / `get_tool_todo_status`：将已定位 HTML 工具的事项按用户要求添加为待办快照；稳定来源键去重，不自动覆盖、复活或持续关注。页面接入方式见 [HTML 待办接口](references/html-todos.md)。
- HTML 待办分类在首次确认并实际创建新待办时创建或复用；默认使用工具名，制作页面时可按内容声明分类键、名称和颜色。预览与取消不创建分类，已有分类的日历隐藏偏好保持不变；待办列表可按分类筛选。日历更多菜单的「管理分类」支持显示控制、编辑及删除自定义分类；MCP 使用共用分类业务工具，删除须核对 ID、原名称和删除限制，并保留内容。
- 持续关注使用 `publish_tool_follow_sources`、`preview_tool_follow`、`follow_tool_scope`、`unfollow_tool_scope` 与 `get_tool_follow_state`；待办管理用 `get_tool_todo_following`、`stop_tool_todo_following`、`resume_tool_todo_following`。来源更新自动同步已授权规则；恢复个人安排前必须说明覆盖标题和时间的影响并取得用户明确确认。
- `list_tool_categories` / `add_tool_category` / `rename_tool_category` / `delete_tool_category`

**运行时日程与订阅**
- `get_runtime_tool_contract` / `list_extensions` / `list_event_providers`：查询历史事件来源身份、修订和更新状态；当前 HTML 工具箱通过 `list_tools` 发现。
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

仅查询首页每日模块使用 `list_news_daily_editions` / `get_news_daily_edition`，单条检索用 `list_news_feed` / `list_news`。用户要求联网采集并存入 App 时，读取 [新闻模块与兴趣流程](references/news.md)，遵守动态配置、任务快照、认领、来源核实、共享预算和完成回读。App 可按保存的早中晚时刻调用本机 Agent；当前对话更新由当前助手连续完成。保存显示项立即应用阅读，普通采集要求不改写已开始任务快照，尚未开始的任务用最新要求；主动撤回立即停止相关授权。

## 安全规则

- `delete_todo` / `delete_study_plan` / `delete_course` / `delete_tool` / `delete_object_type` 不可恢复，调用前必须向用户确认
- `create_object` / `delete_object` 仅操作自定义对象；系统内置字段必须用业务动作，`update_object` 仅允许系统用户扩展字段。关系使用 `list_object_links` / `create_link` / `delete_link`；不要直接更新关联字段或借通用动作绕过 App 人工审批。
- 工具描述里带"请先与用户确认"的，同样遵守
- `delete_news_item` 仅删除用户指定的单条新闻：先复述标题与不可恢复后果并取得确认，不批量删。删除会移除正文及已读/收藏，保留自媒体成果与来源快照、解除失效引用，并保留去重指纹防回流。`cancel_news_task` 需用户明确同意，且任务无有效认领；已入库新闻保留。

## 典型工作流

**晨间汇报**：`get_today` → 用一段话总结逾期/今日到期/今日学习，问用户要不要先处理逾期的。

**记一批待办**：逐条 `add_todo`（要进今日待办就带 `due_date: "today"`）→ `list_todos {"status":"open"}` 核对。

**学完一个知识点**：`create_review_schedule {"topics":["TS 协变与逆变"]}` → 告知用户复习日（默认第 1/3/7/21 天）。

**按配置更新新闻存入 App**：`get_news_feed_config` → `preview_news_feed` → `start_news_feed_update` → 指定返回任务 `claim_news_task` → `get_news_task_context` → 搜索并打开原始来源核实 → 逐则 `submit_news_items` → 重读上下文并用 `save_news_daily_summary` 保存本日模块重点综合总结及依据 → `complete_news_task` → `advance_news_feed_update` 接续下一模块 → `list_news_feed` 与 `list_news_feed_batches` 回读实际结果和缺口。创建批次只是开始，不能据此报告采集成功；临时仅采 AI 的要求再选择单主题任务。

**做一个网页小工具装进 App**：先判断内容是否适合待办，适合时生成单项或批量入口，复用 [HTML 待办接口](references/html-todos.md) → `add_tool` 导入完整文件集 → 实际验证页面及添加预览，告诉用户入口与能力边界。只生成入口不自动创建真实待办。

**建自定义数据**：`list_object_types` 看现状 → `create_object_type` 定义属性 → 需要关联就 `create_link_type` → 日常读写用 `create_object`/`query_objects`；高频组合可 `create_action_type` 封装成 `invoke_action`。
