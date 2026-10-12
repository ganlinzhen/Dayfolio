---
title: MCP 与 AI 接入
description: 让 zcode 等 AI 客户端直接读写你的待办与计划
---

## 是什么

TodoDesk 内置一个 MCP Server（`apps/mcp`），AI 客户端（如 zcode）接入后可以直接读写同一份数据库：查待办、加待办、制定学习计划、打卡、抓新闻，全部与 App 实时同步。

## 在 App 里查看

侧边栏左下角「MCP」面板分「业务模块」与「应用本体」两个分区（后者对应「数据」面板的本体层），按组单列列出全部工具的能力与说明，支持关键词筛选——想了解「AI 能对我的数据做什么」直接翻这个面板即可，本页则说明接入方式与数据位置。

## 接入方式

本机已完成注册，两种方式并存：

- 用户级：`~/.zcode/cli/config.json` → `mcpServers.tododesk`（所有项目可用）
- 项目级：仓库根目录的 `.mcp.json`（进入该仓库生效；路径以实际检出位置为准，不硬编码）

其他机器手工注册，在 `~/.zcode/cli/config.json` 中加入：

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

## 数据位置

数据库固定在 `~/Library/Application Support/tododesk/tododesk.db`，可用环境变量 `TODODESK_DB` 覆盖。**App 与 MCP 必须指向同一文件**，否则两边看到的数据会不一致。

## 工具一览（80 个）

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
| `get_today` | 今日概览（逾期、安排、打卡状态、连续天数） |
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
| `create_object` / `update_object` / `delete_object` | 任意类型（含自定义类型）的实例增删改 |
| `create_object_type` / `update_object_type` / `delete_object_type` | 对象类型管理（建表/加列/删列） |
| `create_link_type` / `delete_link_type` | 链接类型管理（类型间关系） |
| `create_action_type` / `update_action_type` / `delete_action_type` | 动作类型管理（启停/创建/删除） |
| `invoke_action` | 执行动作（内置或自定义，单事务） |

日期类参数（`due_date`、`date` 等）除 `YYYY-MM-DD` 外，还接受 **today / tomorrow / yesterday** 与「今天 / 明天 / 后天 / 昨天」等别名，AI 说「加到今日待办」时无需先查日历。

## 试着对 AI 说

- 「帮我看下现在有哪些待办」
- 「把这个任务加到今日待办」
- 「加一条高优先级待办：周五前交报告」
- 「把 ~/Downloads/色板.html 加到工具箱，分类放到效率工具」
- 「帮我写个倒计时小工具放进工具箱」
- 「为《TypeScript 全面指南》这门 20 集的课做个 14 天学习计划，每天 1 小时，注意安排复习」
- 「看看现在有哪些待处理的课程生成请求」
- 「把 ~/Downloads/sample-course/ 里的课程样课包导入进来」（AI 会走样课流程：导入后由你在 App 阅读确认）
- 「我想学线性代数，每天晚上 1 小时，用《线性代数及其应用》」（AI 会先出**草案**给你确认，再按学习闭环推进）
- 「今天的学习任务打卡了吗」
- 「为今天学的《递归》知识点按遗忘曲线生成复习计划」
- 「帮我建一个"读书笔记"的类型，要有书名、评分和心得字段，然后记一条《三体》9.5 分」
- 「建一个"记一条心得"的动作：参数是内容，执行时自动建笔记并打上今天日期」
