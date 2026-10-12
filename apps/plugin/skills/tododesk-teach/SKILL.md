---
name: tododesk-teach
description: 按 TodoDesk 学习闭环规范执行教学：课程计划→逐日讲义导入→学习会话→测评留证→复习调整→知识卡片。当用户说「学习 X」「教我 X」「导入课程」时显式调用（不自动触发）。
---

# TodoDesk 教学

本技能让 agent 按 **TodoDesk 学习闭环规范**（`get_study_workflow` 工具返回的单一来源）执行教学。
调用方式：**显式**（用户明确要求学习某主题时）——不自动触发、不冒称已自动调用。

## 来源与许可

教学流程思路改编自 [mattpocock/skills](https://github.com/mattpocock/skills) 的 teach 技能
（MIT License, Copyright (c) 2026 Matt Pocock, commit `49dd158`）。上游使用
`disable-model-invocation: true`（仅显式调用）——本改编保留同一语义。
本文为 TodoDesk 自有改写，非上游原文复制；上游 MIT 许可全文随包保留在同目录 `LICENSE`。

## 前置

本插件内置 TodoDesk MCP 服务器（`tododesk`），声明于 `mcp.json` / `.mcp.json`
（双宿主：Codex 与 ZCode；启动命令用 `${CLAUDE_PLUGIN_ROOT}/mcp/mcp-server.cjs`
官方约定，任何工作目录均可启动）。`TODODESK_DB` 环境变量指定 SQLite 库路径
（从宿主环境继承，与桌面 App 共用同一文件；stdio, 需 node ≥ 20）。

## 执行流程（透明规则见 get_study_workflow 返回的规范全文）

1. **澄清目标**：问用户学习动机、每日时间预算（分钟）、材料来源、先修基础——缺信息不编造。
2. **生成计划草案**：`draft_study_plan`（知识点分解 + 依赖 + 每日预算）；把逐日安排与假设展示给用户。
3. **确认**：用户同意 → `confirm_study_plan_draft`；拒绝 → `cancel_study_plan_draft`（无副作用）。
4. **课程内容**（教学插件扩展）：
   - **任何课程包必须恰好含一个 `is_sample` 标记**（样课包仅样课一天；完整包保留样课标记）——
     无标记包会被拒绝；首次导入完整包同样被拒绝，用 `import_course` 导入样课；
     **plan_id 绑定后不可改绑**（重导省略 plan_id 表示沿用原绑定）；
   - 用户须在 App **阅读样课并亲自确认**（MCP 无确认工具，agent 不代确认）后，才能 `create_course_request` 请求完整版；
   - agent 定期 `list_course_requests` 发现 pending → `claim_course_request` 认领 → 编写完整包（含样课天且**样课正文与已确认版本逐字节一致**，否则导入即拒）→
     `import_course` 导入（仅认领后放行）→ `complete_course_request` 完成（核验确认哈希未过期 + 天数覆盖绑定计划的全部天数，缺一天即拒绝；绑定计划被删除亦拒绝）；
   - **内容生成不算掌握**：掌握证据只来自 `record_study_assessment`（自评可纠正/客观须带判题依据）。
5. **每日执行**：`record_study_session`（实际用时、自己的解释、疑问、材料）。
6. **测评**：`record_study_assessment`（source 显式：self/objective/ai_suggestion）。
7. **复习调整**：`suggest_plan_adjustments` 预览 → 用户确认 → `apply_plan_adjustments`。
8. **沉淀**：`preview_study_cards` → 用户指定目录 → `export_study_cards`（status: draft, verified: false）。

## 安全边界

- 绝不读写用户真实 SQLite 库（测试用 `TODODESK_DB=<临时路径>` + 独立 `HOME`）；
- 讲义 HTML 会被消毒（script/事件/危险协议剥除，外部资源 http/https 一律中和，讲义须离线自包含）；
  讲义引用的包内 .css 样式表会在导入时内联为离线 `<style>`（@import 与外部 url() 移除，课程排版保留）；
  源码导读是纯文本，不执行命令；课程包拒绝路径穿越与符号链接（symlink）；
- 样课确认必须用户在 App 亲自操作——agent 不代确认（MCP 无确认工具）；
- 导入失败不留孤儿（资产先就位、库后写入），重导保留已读与答题、不删已生成天。
