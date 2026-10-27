import type { ObjectTypeDef } from './data-shared';

// 按主要使用入口归组；跨菜单共享的运行能力集中放在基础功能。
const GROUPS = [
  { id: 'today', title: '今日与日历', description: '本地日程与日历分类', names: ['calendar_event', 'calendar_collection'] },
  { id: 'todos', title: '待办', description: '待办事项与完成记录', names: ['todo', 'checkin'] },
  { id: 'news', title: '新闻', description: '新闻内容与采集任务', names: ['news_item', 'news_task'] },
  { id: 'study', title: '学习', description: '计划、课程、学习记录与评测', names: ['study_plan', 'plan_item', 'study_plan_draft', 'study_session', 'study_assessment', 'course', 'course_lesson', 'course_overview', 'course_request', 'plan_adjustment', 'card_export'] },
  { id: 'knowledge', title: '知识库', description: '知识库、笔记索引与概念关联', names: ['vault', 'vault_note', 'vault_concept_link'] },
  { id: 'media', title: '自媒体', description: '选题、稿件、素材、排期与指标', names: ['media_topic', 'media_content', 'media_content_version', 'media_material', 'media_calendar_entry', 'media_metric'] },
  { id: 'tools', title: '工具箱', description: 'HTML 工具、分类与持续关注', names: ['tool', 'tool_category', 'tool_follow_source', 'tool_follow_rule'] },
  { id: 'foundation', title: '基础功能', description: '共享日期、扩展、事件订阅与执行记录', names: ['day', 'tool_extension', 'event_provider', 'external_event', 'event_subscription', 'action_execution'] },
  { id: 'custom', title: '自定义', description: '你自行创建的对象类型', names: [] },
] as const;

export function groupObjectTypes(types: ObjectTypeDef[]) {
  return GROUPS.map(group => ({
    ...group,
    types: types.filter(type => {
      if (!type.isSystem) return group.id === 'custom';
      const owner = GROUPS.find(candidate => (candidate.names as readonly string[]).includes(type.apiName));
      return group.id === (owner?.id ?? 'foundation');
    }),
  })).filter(group => group.types.length > 0);
}
