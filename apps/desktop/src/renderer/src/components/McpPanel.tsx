// MCP 面板：按本体分组展示 MCP Server 暴露给 AI 客户端的全部工具与说明
// 目录数据与 apps/mcp/src/server.ts 的工具注册保持同步（新增/修改工具时同步更新这里）
import { useMemo, useState } from 'react';

interface McpTool {
  name: string;
  desc: string;
}

interface McpGroup {
  title: string;
  /** 对应的本体对象/元数据 apiName */
  entity: string;
  desc: string;
  tools: McpTool[];
}

interface McpSection {
  title: string;
  /** 分区说明，跟在标题后 */
  hint: string;
  groups: McpGroup[];
}

// 业务模块 = 与侧边栏对应的功能；应用本体 = 对象/链接/动作的通用数据层（对应「数据」面板），两类分区分开陈列
const SECTIONS: McpSection[] = [
  {
    title: '业务模块',
    hint: '与侧边栏各功能对应，读写带业务联动',
    groups: [
  {
    title: '待办',
    entity: 'todo',
    desc: '核心对象 todo 的增删改查；完成时自动联动打卡，计入连续天数。',
    tools: [
      { name: 'list_todos', desc: '按状态/优先级/是否过期/关键词/标签筛选待办，未完成与紧急的排前面' },
      { name: 'add_todo', desc: '新增待办；priority 接受 high/P0/高 等别名，due_date 支持 today/今天（要加进今日待办就传 today）' },
      { name: 'update_todo', desc: '修改待办（只传要改的字段）；status=done 等同完成并自动打卡' },
      { name: 'complete_todo', desc: '完成一条待办，自动记录打卡' },
      { name: 'delete_todo', desc: '删除待办（不可恢复，AI 会先与用户确认）' },
    ],
  },
  {
    title: '学习计划',
    entity: 'plan / plan_item',
    desc: 'plan 与逐日条目 plan_item：按天编排学习/复习/练习，条目打卡即联动待办。',
    tools: [
      { name: 'create_study_plan', desc: '按逐日安排创建完整学习计划，自动为每天生成一条待办' },
      { name: 'list_study_plans', desc: '查询计划列表与进度（done_items/total_items）' },
      { name: 'get_study_plan', desc: '查询单个计划详情：逐日条目与各自状态' },
      { name: 'update_plan_item', desc: '条目打卡核心入口：done 完成 / pending 撤销 / skipped 跳过' },
      { name: 'update_study_plan', desc: '修改计划标题、目标、备注或状态（active/done/archived）' },
      { name: 'delete_study_plan', desc: '删除计划及其条目与打卡记录；生成的待办保留但解除关联' },
      { name: 'create_review_schedule', desc: '按遗忘曲线（默认学后第 1/3/7/21 天）批量生成复习计划与待办' },
    ],
  },
  {
    title: '学习闭环',
    entity: 'study_plan_draft / study_session / study_assessment',
    desc: 'agent 主导的完整学习流程：规范→草案→确认→学习会话→测评证据→掌握度→调整→知识卡片。App 只做展示与确认。',
    tools: [
      { name: 'get_study_workflow', desc: '学习闭环执行规范（与帮助面板同源）；也可读 MCP 资源 tododesk://study/workflow' },
      { name: 'draft_study_plan', desc: '生成计划草案：知识点+每日预算 → 透明规则排出逐日安排；只存草案，不建计划/待办' },
      { name: 'list_study_drafts / get_study_draft', desc: '查询草案列表 / 详情（App 计划面板顶部也会显示待确认草案）' },
      { name: 'confirm_study_plan_draft', desc: '确认草案为正式计划（生成逐日条目与待办，幂等）——须先经用户同意' },
      { name: 'cancel_study_plan_draft', desc: '取消草案（无任何副作用，重复取消幂等）' },
      { name: 'record_study_session', desc: '记录一次学习会话：实际用时/自己的解释/疑问/材料；稳定 id 重试幂等，attempt 支持多次尝试' },
      { name: 'list_study_sessions', desc: '按计划/条目/知识点/日期查询学习会话' },
      { name: 'record_study_assessment', desc: '记录测评证据：题目/标准/原答案/评分/依据；self 可纠正（保留历史），objective 必须带真实判题依据，ai_suggestion 不计入掌握' },
      { name: 'list_study_assessments', desc: '查询测评记录（含纠正历史 corrections）' },
      { name: 'get_mastery', desc: '知识点掌握情况（unknown/weak/reviewing/strong），与任务完成率分开；无证据=未知' },
      { name: 'suggest_plan_adjustments', desc: '未完成条目的调整建议（漏做改期 + 依赖联动顺延后继 + 薄弱补复习），纯预览不写库' },
      { name: 'apply_plan_adjustments', desc: '按预览快照应用建议（须携带预览时的 to_date，变化即拒绝；依赖组不完整整组拒绝）：只动未完成条目，同步待办截止日与计划边界——须先经用户确认' },
      { name: 'preview_study_cards', desc: '预览待审知识卡片（Obsidian Markdown，不落盘）' },
      { name: 'export_study_cards', desc: '导出卡片到用户指定目录：防重、不覆盖人工编辑' },
      { name: 'list_card_exports', desc: '查询卡片导出历史' },
    ],
  },
  {
    title: '打卡与今日',
    entity: 'checkin',
    desc: 'checkin 记录与今日聚合视图：向 AI 汇报进度、规划今天先调这组。',
    tools: [
      { name: 'checkin', desc: '每日打卡（ref_type=day），或对待办/计划条目打卡；同日重复打卡幂等' },
      { name: 'get_today', desc: '今日概览：逾期、今日到期、学习安排、已完成事项、打卡状态、连续天数' },
      { name: 'get_checkin_stats', desc: '打卡统计：连续天数、近 7/30 天活跃、总数与最近记录' },
    ],
  },
  {
    title: '新闻',
    entity: 'news_item',
    desc: 'agent-only：新闻由 AI 助手经「新闻任务」生产（App 不抓取、无源配置、无定时器）。',
    tools: [
      { name: 'list_news', desc: '库内查询新闻（任务/来源/未读/收藏筛选、关键词、24h 时间窗），不联网' },
      { name: 'create_news_task / list_news_tasks / cancel_news_task', desc: '新闻任务：创建（规则+预算+时间窗）/ 查看进度 / 取消（需用户同意）' },
      { name: 'claim_news_task', desc: '认领待执行任务（30 分钟租约，过期可被接力）' },
      { name: 'submit_news_items', desc: '核实后提交：原始来源链接+摘要+真实发布时间；硬校验去重与预算（每任务累计 10 条）' },
      { name: 'complete_news_task / release_news_task', desc: '完成（0 条也是合法完成）/ 释放回待执行' },
      { name: 'mark_news_read / mark_news_starred / mark_all_news_read', desc: '已读/收藏状态（与 App 阅读面板共享同一持久状态）' },
    ],
  },
  {
    title: '工具箱',
    entity: 'tool / tool_category',
    desc: 'tool（HTML 小工具）与分类：AI 可把本地 HTML 文件或现场生成的页面装入工具箱，切换面板即可见。',
    tools: [
      { name: 'list_tools', desc: '查看全部工具（分类/入口文件/文件清单）与分类列表' },
      { name: 'add_tool', desc: '把工具装入工具箱：file_paths 读本地文件，或 files 传 base64 现场生成；分类不存在自动创建' },
      { name: 'update_tool', desc: '改名/图标/分类/入口文件，或整体替换文件' },
      { name: 'delete_tool', desc: '删除工具连同文件目录（AI 会先与用户确认）' },
      { name: 'list_tool_categories', desc: '查看全部分类及各自工具数' },
      { name: 'add_tool_category', desc: '新建分类' },
      { name: 'rename_tool_category', desc: '重命名分类' },
      { name: 'delete_tool_category', desc: '删除分类；其下工具自动移入未分类' },
    ],
  },
    ],
  },
  {
    title: '应用本体',
    hint: '对象/链接/动作类型的通用数据层，对应「数据」面板',
    groups: [
  {
    title: '实例读写',
    entity: '任意对象类型',
    desc: '对任意类型（含用户自定义类型）实例的通用 CRUD；系统类型建议优先用上面的专用工具，业务联动更完整。',
    tools: [
      { name: 'query_objects', desc: '按类型查询实例：文本模糊搜索 + 等于/范围过滤 + 分页' },
      { name: 'get_object', desc: '读单个对象完整详情，含出链/入链（它引用了谁、谁引用了它）' },
      { name: 'create_object', desc: '在任意类型上创建实例，必填属性不能缺省' },
      { name: 'update_object', desc: '按主键更新实例（只传要改的字段）' },
      { name: 'delete_object', desc: '按主键裸删除实例——不走业务联动（删 todo 不会自动清打卡），慎用' },
    ],
  },
  {
    title: '动作',
    entity: 'action',
    desc: 'action = 参数 + 按顺序执行的写规则，执行时单事务（全部成功或全部回滚）；内置动作与用户自定义动作统一执行。',
    tools: [
      { name: 'invoke_action', desc: '执行内置（add_todo/complete_todo/checkin…）或自定义动作' },
      { name: 'create_action_type', desc: '创建自定义动作：声明参数与写规则序列' },
      { name: 'update_action_type', desc: '修改动作显示名/说明/启停状态' },
      { name: 'delete_action_type', desc: '删除自定义动作；内置动作不可删、只能停用' },
    ],
  },
  {
    title: '类型定义',
    entity: 'object / link / action type',
    desc: '本体元数据本身也可被 AI 管理：对象类型（建表）、链接类型（类型间关系）、动作类型的定义与增删。',
    tools: [
      { name: 'list_object_types', desc: '列出全部对象/链接/动作类型定义——AI 的「数据字典」，传参前先看这个' },
      { name: 'create_object_type', desc: '创建自定义对象类型（自动建表，附带 id/created_at/updated_at）' },
      { name: 'update_object_type', desc: '改类型元数据、追加属性（自动加列）、删除后加属性' },
      { name: 'delete_object_type', desc: '删除自定义对象类型连同物理表与数据；系统类型不可删' },
      { name: 'create_link_type', desc: '创建类型间链接：一对一 / 一对多 / 多对多' },
      { name: 'delete_link_type', desc: '删除自定义链接类型（纯元数据操作，不动实例）' },
    ],
  },
    ],
  },
];

const GROUPS: McpGroup[] = SECTIONS.flatMap((s) => s.groups);

const TOTAL = GROUPS.reduce((n, g) => n + g.tools.length, 0);

export default function McpPanel() {
  const [q, setQ] = useState('');

  // 关键词过滤：组标题/本体名/工具名/说明命中任一即保留该工具，无命中的分区整块隐藏
  const sections = useMemo(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return SECTIONS;
    return SECTIONS.map((s) => ({
      ...s,
      groups: s.groups
        .map((g) => ({
          ...g,
          tools: g.tools.filter(
            (t) =>
              t.name.toLowerCase().includes(kw) ||
              t.desc.toLowerCase().includes(kw) ||
              g.title.toLowerCase().includes(kw) ||
              g.entity.toLowerCase().includes(kw),
          ),
        }))
        .filter((g) => g.tools.length > 0),
    })).filter((s) => s.groups.length > 0);
  }, [q]);

  const shown = sections.reduce((n, s) => n + s.groups.reduce((m, g) => m + g.tools.length, 0), 0);

  return (
    <div className="panel">
      <header className="panel-head">
        <h1>MCP</h1>
        <div className="head-meta mono">
          {GROUPS.length} 组 · {TOTAL} 个工具{q ? ` · 命中 ${shown}` : ''}
        </div>
      </header>
      <p className="sub mcp-intro">
        TodoDesk 内置 MCP Server，把这些能力暴露给 zcode 等 AI 客户端——与 App 读写同一个数据库，改动实时同步。
        接入方式见「帮助 → MCP 与 AI 接入」。
      </p>
      <div className="searchbox mcp-search">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="筛选工具…"
          aria-label="筛选 MCP 工具"
        />
      </div>
      {sections.map((s) => (
        <div key={s.title} className="mcp-section">
          <div className="mcp-section-label">
            <span>{s.title}</span>
            <span className="mcp-section-hint">{s.hint}</span>
          </div>
          <div className="mcp-grid">
            {s.groups.map((g) => (
              <section key={g.title} className="mcp-group">
                <header className="mcp-group-head">
                  <span className="mcp-group-title serif">{g.title}</span>
                  <span className="mono mcp-group-entity">{g.entity}</span>
                  <span className="group-count">{g.tools.length}</span>
                </header>
                <p className="mcp-group-desc">{g.desc}</p>
                <ul className="mcp-tools">
                  {g.tools.map((t) => (
                    <li key={t.name} className="mcp-tool">
                      <code className="mcp-tool-name">{t.name}</code>
                      <span className="mcp-tool-desc">{t.desc}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      ))}
      {sections.length === 0 && (
        <div className="empty">
          <div className="empty-title">没有匹配「{q.trim()}」的工具</div>
          <div className="empty-hint">试试工具名（如 checkin）或关键词（如 打卡）</div>
        </div>
      )}
    </div>
  );
}
