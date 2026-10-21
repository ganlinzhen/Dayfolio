---
title: MCP 与 AI 接入
description: 让 zcode 等 AI 客户端直接读写你的待办与计划
---

## 页面操作区

顶部操作栏可筛选工具或技能，并展示分组和工具总数。输入关键词后显示命中的工具数量；三个技能也按名称和说明筛选。

## 是什么

Dayfolio 内置一个 MCP Server（`apps/mcp`），AI 客户端（如 zcode）接入后可以直接读写同一份数据库：查待办、加待办、制定学习计划、打卡、抓新闻，全部与 App 实时同步。

## 在 App 里查看

侧边栏左下角「MCP」面板展示统一 AI 能力包与工具目录。通用操作、教学、赛事页面三个技能共用一个 `tododesk` MCP 服务入口。

工具目录分「业务模块」与「应用本体」两个分区，直接从实际注册生成；完整工具数量与说明以该面板和客户端的工具列表为准。

- **导出 / 更新能力包**：选择目录后，把随 App 提供的完整包写入其 `Dayfolio-Agent` 子目录。已由本功能导出的目录可原位更新，保留上一版；目录含人工修改或其他文件时会拒绝覆盖。
- **检查接入包**：核对随包与上次导出副本的文件、版本，以及 App 的 PATH 中能找到的 Node。若客户端配置了 Node 绝对路径，应以客户端环境为准。
- **随包 / 已导出版本**：分别表示 App 内能力包和导出副本的版本，不表示客户端已加载。导出不会改写客户端配置，也不会自动重启 MCP 会话；加载与重连按客户端方式完成。

## 接入方式

先安装 **Node 22.13+ 或 24.x**（推荐 24.x）。MCP 使用 Node 内置 `node:sqlite`，Node 20 无法运行。源码安装后，在仓库根目录执行：

```bash
npm ci
npm run build:mcp
```

根据 AI 客户端支持的方式注册：

- 用户级：`~/.zcode/cli/config.json` → `mcpServers.tododesk`（所有项目可用）
- 项目级：仓库根目录的 `.mcp.json`（进入该仓库生效；路径以实际检出位置为准，不硬编码）

例如使用 zcode 时，在 `~/.zcode/cli/config.json` 中加入以下配置。把 `args` 替换为实际检出位置的**绝对路径**，确保客户端启动的 `node` 是上述受支持版本：

```json
{
  "mcpServers": {
    "tododesk": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/tododesk/apps/mcp/dist/mcp-server.cjs"]
    }
  }
}
```

源码检出不会自动注册 MCP，也不会自动启动 AI 助手。若客户端找不到 `node`，将 `command` 改为本机 Node 可执行文件的绝对路径。其他客户端按照其配置格式添加同一个 stdio 服务器。

## 统一技能与能力包

仅保留一个对外技能 `dayfolio`，显示名为 **Dayfolio**，源码位于 `packages/agent-kit/skills/dayfolio/`。

待办、日程、新闻、工具箱、自定义数据、教学与赛事页面都由这个入口处理。教学和赛事说明按需从内部参考文件读取，不单独展示技能。样课仍在 App 阅读后由用户在对话中确认，助手通过专用工具记录当前版本。

本机运行 `npm run package:desktop` 后，只有打包与签名校验成功，才会把同版本的完整能力包同步到 Codex。默认入口为 `~/.codex/skills/dayfolio`，设置 `CODEX_HOME` 时使用其下的 `skills/dayfolio`；旧 TodoDesk、教学和赛事入口会备份后移出发现目录。CI 和隔离验收不更新真实 Codex 目录。同步失败会使打包命令报错，并保留旧入口或受管包的上一版；重新打开对话后可重新加载技能列表。

源码分发前运行 `npm run agent:build`、`npm run agent:verify`，完整包生成在 `dist/agent-kit/`。保留包内技能、运行时、MCP、宿主清单和发布记录文件，不单独拷贝技能目录。没有注册 MCP 的助手可使用包内 `runtime/call.mjs` 调用同一服务器。

旧 `npm run plugin:build`、`npm run plugin:verify` 和 `apps/plugin/` 路径继续可用；旧插件身份 `tododesk-teach` 保留为兼容入口。新能力包身份为 `dayfolio`。同一客户端选择一种接入方式，避免同时加载新旧插件或重复注册同一个 MCP。

现有手工 MCP 配置、服务名、工具名和 `TODODESK_DB` 均保持兼容。包内提供现有两种宿主格式的清单；实际插件加载是否支持，以客户端为准，目录导出与隔离协议测试不代表已完成宿主加载验收。

维护与诊断命令：

```bash
npm run agent:build
npm run agent:verify
npm run agent:install -- --target /自选目录/Dayfolio-Agent --dry-run
npm run agent:install -- --target /自选目录/Dayfolio-Agent
npm run agent:doctor -- --target /自选目录/Dayfolio-Agent
```

安装命令只处理指定的能力包目录，不修改客户端配置。`--rollback` 可与原安装目标一起使用以恢复上一版文件；恢复前需核对旧 MCP 与当前数据库的兼容性，文件回退不会回退数据库。

## 数据位置

数据库固定在 `~/Library/Application Support/tododesk/tododesk.db`，可用环境变量 `TODODESK_DB` 覆盖。**App 与 MCP 必须指向同一文件**，否则两边看到的数据会不一致。

## 常用工具（完整目录见 MCP 面板）

| 工具 | 用途 |
| --- | --- |
| `list_todos` / `add_todo` / `update_todo` / `complete_todo` / `delete_todo` | 待办增删改查、完成 |
| `create_study_plan` / `list_study_plans` / `get_study_plan` / `update_study_plan` / `delete_study_plan` | 学习计划管理与进度 |
| `update_plan_item` | 计划条目打卡（done / pending / skipped） |
| `get_study_workflow` | **学习闭环执行规范**（与 App 帮助「学习闭环」一节同源）；另有 MCP 资源 `tododesk://study/workflow` 可直接读取 |
| `draft_study_plan` / `list_study_drafts` / `get_study_draft` | 生成与查询学习计划**草案**（透明规则排程，仅预览不建计划） |
| `draft_study_topic` / `update_study_topic_draft` | **无日期专题草案**：日期待排期先存（大纲/知识点/材料/样课关联；不排日程、不产待办、不占预算）与内容更新 |
| `preview_study_draft_schedule` / `schedule_study_draft` | 草案排期：只读预览（每日预算冲突+知识点重复+依赖顺序，汇总 `over_budget_dates`）→ 确认后事务排期（服务端硬校验：`confirmed_over_dates` 必须与重算精确一致；同参数幂等） |
| `confirm_study_plan_draft` / `cancel_study_plan_draft` | 草案确认（幂等；排期草案确认时再次硬校验冲突，须带最新 `confirmed_over_dates`）/ 取消（无副作用） |
| `record_study_session` / `list_study_sessions` | 记录 / 查询学习会话（稳定 ID，多次尝试，重复提交幂等） |
| `record_study_assessment` / `list_study_assessments` | 记录 / 查询测评证据（自评可纠正、客观必须带判题依据、AI 建议不计入掌握；证据按计划隔离） |
| `get_mastery` | 知识点掌握情况（与完成率分开，无证据=未知，客观优先） |
| `suggest_plan_adjustments` / `apply_plan_adjustments` | 未完成条目调整：预览（不写库）/ 按预览快照应用（只动未完成并同步待办） |
| `preview_study_cards` / `export_study_cards` / `list_card_exports` | 待审知识卡片：预览 / 导出到指定目录（防重、不覆盖人工编辑）/ 导出历史 |
| `checkin` | 每日打卡、对待办或计划条目打卡 |
| `get_today` | 今日概览（逾期、安排、今日日程、打卡状态、连续天数） |
| `list_calendar_events` / `add_calendar_event` / `update_calendar_event` / `delete_calendar_event` | 日程（个人日历）增删改查：跨天区间相交、全天/定时；与 App 今日页月历同源 |
| `get_checkin_stats` | 打卡统计与最近记录 |
| `create_review_schedule` | 按遗忘曲线批量生成复习计划与待办 |
| `list_news` | 库内查询新闻（任务/来源/未读/收藏筛选、关键词、时间窗、分页；只读不联网） |
| `create_news_task` / `list_news_tasks` / `cancel_news_task` | 新闻任务（agent-only 唯一生产入口）：创建/查看进度/取消（需用户同意） |
| `claim_news_task` / `submit_news_items` / `complete_news_task` / `release_news_task` | 认领执行（30 分钟租约）→ 核实后提交（原始来源链接+摘要+真实发布时间，硬校验去重与预算）→ 完成/释放 |
| `mark_news_read` / `mark_news_starred` / `mark_all_news_read` | 已读/收藏状态（与 App 共享） |
| `delete_news_item` | 删除单条新闻（须用户确认、不可恢复；哈希指纹防回流、自媒体成果与快照保留、任务名额不返还；幂等） |
| `import_course` / `list_courses` / `get_course_lessons` / `get_lesson_html` | 教学课程：导入课程包 / 查课程 / 查讲义 / 读讲义正文（详见「课程」一节） |
| `submit_lesson_quiz` | 提交每日讲义自测答案（学习痕迹，不算掌握） |
| `create_course_request` / `list_course_requests` / `claim_course_request` / `complete_course_request` | 完整版生成请求队列：用户确认样课后由 agent 认领→生成→导入→完成（不能绕过确认） |
| `list_tools` / `add_tool` / `update_tool` / `delete_tool` | 工具箱管理：把本地 HTML 文件或 AI 现场生成的页面装入工具箱，App 内即时可见 |
| `list_tool_categories` / `add_tool_category` / `rename_tool_category` / `delete_tool_category` | 工具箱分类管理 |
| `list_object_types` | 列出本体全部对象/链接/动作类型定义（AI 的「数据字典」） |
| `query_objects` / `get_object` | 按类型查询实例 / 读单个对象详情（含出链入链） |
| `create_object` / `update_object` / `delete_object` | 自定义实例增删改；系统对象仅允许更新用户扩展字段，内置字段走业务动作 |
| `create_object_type` / `update_object_type` / `delete_object_type` | 对象类型管理（建表/加列/删列） |
| `list_object_links` / `create_link` / `delete_link` | 关系双向分页、建立与精确解除（目标存在性、基数和删除规则生效） |
| `create_link_type` / `delete_link_type` | 链接类型管理（类型间关系） |
| `create_action_type` / `update_action_type` / `delete_action_type` | 动作类型管理（启停/创建/删除） |
| `invoke_action` | 执行共用业务命令或自定义动作；自定义声明式动作单事务 |

日期类参数（`due_date`、`date` 等）除 `YYYY-MM-DD` 外，还接受 **today / tomorrow / yesterday** 与「今天 / 明天 / 后天 / 昨天」等别名，AI 说「加到今日待办」时无需先查日历。

## 试着对 AI 说

- 「帮我看下现在有哪些待办」
- 「把这个任务加到今日待办」
- 「帮我记个日程：周五下午 3 点牙医」
- 「加一条高优先级待办：周五前交报告」
- 「把 ~/Downloads/色板.html 加到工具箱，分类放到效率工具」
- 「帮我写个倒计时小工具放进工具箱」
- 「为《TypeScript 全面指南》这门 20 集的课做个 14 天学习计划，每天 1 小时，注意安排复习」
- 「看看现在有哪些待处理的课程生成请求」
- 「把 ~/Downloads/sample-course/ 里的课程样课包导入进来」（AI 会走样课流程：导入后由你在 App 阅读，再在对话中确认）
- 「我想学线性代数，每天晚上 1 小时，用《线性代数及其应用》」（AI 会先出**草案**给你确认，再按学习闭环推进）
- 「今天的学习任务打卡了吗」
- 「为今天学的《递归》知识点按遗忘曲线生成复习计划」
- 「帮我建一个"读书笔记"的类型，要有书名、评分和心得字段，然后记一条《三体》9.5 分」
- 「建一个"记一条心得"的动作：参数是内容，执行时自动建笔记并打上今天日期」


## 本体写入边界

所有公开业务写工具与 App 共用动作启停和业务校验。`list_object_types` 返回写入方式、适用对象和入口限制，使用 `invoke_action` 前先查看其参数结构；复杂动作的 `input`／`patch` 为结构化 JSON，不是 JSON 字符串。课程、笔记索引、自媒体内容等现有业务对象也可统一查询。系统内置字段裸写会返回推荐业务入口，不能用通用 CRUD 绕过样课确认、审核、新闻租约或学习证据规则。

## 功能归属

「学习计划」功能分组统一为「学习」。完成记录工具 `checkin`、`get_checkin_stats` 归入「待办」，不再单列打卡分组；底层工具名保持兼容。待办时段使用 `start_time` / `end_time`（HH:MM），允许仅开始；跨日通过 end_date 指定结束日期；均传 null 切回仅日期。

## 运行时事件与订阅（P1 接口）

先用 `get_runtime_tool_contract` 查询阶段与限额，`list_event_providers` 获取已登记来源。通用工具如下，后续同类工具复用这些固定名称：

| 用途 | 工具 |
| --- | --- |
| 标准事件 | `import_external_events`、`list_external_events`、`get_external_event` |
| 历史处理 | `archive_external_event`、`delete_unused_external_event` |
| 订阅 | `subscribe_event`、`get_event_subscription`、`list_event_subscriptions` |
| 停止/恢复 | `unsubscribe_event`、`resume_event_following` |
| 来源启停 | `update_event_provider` |
| 分类偏好 | `list_calendar_collections`、`set_calendar_collection_visibility` |
| 统一时区 | `set_display_timezone` |

导入必须携带 batchId 与 provider 修订，并显式给出四个时间字段；相同批次、相同内容幂等重放，不同内容拒绝。取消订阅须显式选择 keep 或 delete_open。恢复跟随必须携带来源及待办的最新修订。固定时刻待办传 `time_mode: instant` 与 `scheduled_start_at`、可空 `scheduled_end_at`，不能同时传本地排期字段；浮动安排允许仅开始时间，跨日通过 `end_date` 表达。专用 `update_todo` 支持 `expected_revision` 防并发覆盖。

统一日历工具 `query_calendar_items` 已接入 App 分类面板，使用共享偏好；显式空分类数组返回空。查询包含完整过滤统计和分页游标，数据变化后须整轮重查。工具箱只导入 HTML，不再提供旧工具包安装与版本管理。

## App 内后台 Agent 与对话采集

「设置 → 配置 Agent」统一管理 Codex、Claude Code、Gemini CLI 的本机路径与可选模型。App 不携带 Agent 运行时；CLI 在本机安装并登录后，新闻页「更新今日新闻」直接调用所选 Agent，完成后自动刷新。

也可以在已接入 Dayfolio 的 Agent 对话中要求更新新闻，助手在本次对话中读取保存要求、核实来源、提交并完成，不只创建请求等待以后处理。`get_agent_settings` / `update_agent_settings` 读写后台连接偏好，不读取或保存登录凭证；修改必须来自用户明确要求并携带最新 expected_revision。对话采集不需要修改后台连接。

`list_news_agent_runs` 读取后台进度、`cancel_news_agent_run` 按用户要求停止；运行依赖 Dayfolio App 保持运行。新闻认领、提交和完成工具继续用于同一次对话内的采集流程。
