import type { ToolGroup } from './shared/context';

export const TOOL_GROUPS = {
  settings: { id: 'settings', title: '设置', entity: 'agent_settings', desc: 'App 后台 Agent 的连接偏好，不含登录凭证。', section: '业务模块' },
  runtime: { id: 'runtime', title: '运行时工具与订阅', entity: 'extension / provider / event / subscription', desc: '声明式工具安装、来源事件、订阅与统一日历。', section: '业务模块' },
  today: { id: 'today', title: '今日', entity: 'today', desc: '今日待办、学习与日程概览。', section: '业务模块' },
  todos: { id: 'todos', title: '待办', entity: 'todo / checkin', desc: '待办与完成记录，保留业务联动。', section: '业务模块' },
  plans: { id: 'plans', title: '学习', entity: 'plan / plan_item', desc: '学习计划与逐日安排。', section: '业务模块' },
  calendar: { id: 'calendar', title: '日历', entity: 'calendar_event', desc: '个人日历的查询与维护。', section: '业务模块' },
  news: { id: 'news', title: '新闻', entity: 'news / news_task', desc: '助手采集任务与库内新闻管理。', section: '业务模块' },
  courses: { id: 'courses', title: '课程', entity: 'course / course_request', desc: '样课导入、讲义阅读与课程请求。', section: '业务模块' },
  reviews: { id: 'reviews', title: '间隔复习', entity: 'plan / plan_item', desc: '为学过的知识生成复习安排。', section: '业务模块' },
  study: { id: 'study', title: '学习闭环', entity: 'study_session / study_assessment', desc: '从草案到会话、测评、调整与卡片。', section: '业务模块' },
  toolbox: { id: 'toolbox', title: '工具箱', entity: 'tool / tool_category', desc: '安装和更新 HTML 小工具。', section: '业务模块' },
  ontology: { id: 'ontology', title: '对象、查询与动作', entity: 'object / link / action', desc: '类型、实例、关系、统一查询与动作执行。', section: '应用本体' },
  knowledge: { id: 'knowledge', title: '知识库', entity: 'vault / note', desc: '知识库的只读索引、搜索与概念关联。', section: '业务模块' },
  media: { id: 'media', title: '自媒体', entity: 'media_topic / media_content', desc: '选题、内容、素材、排期与复盘。', section: '业务模块' },
} satisfies Record<string, ToolGroup>;
