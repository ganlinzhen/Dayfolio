import { z } from 'zod';
import type { ToolRegistrar } from '../shared/context';
import { wrap } from '../shared/response';
import type { TodoDeskCore } from '../../../../packages/core/src';

export function registerToolFollowingTools(server:ToolRegistrar,core:TodoDeskCore) {
  const scope=z.object({kind:z.enum(['item','group']),key:z.string().min(1).max(240)}).strict();
  const target={toolId:z.number().int().positive(),scope};
  const source=z.object({sourceKey:z.string().min(1).max(240),title:z.string().min(1).max(300),notes:z.string().max(10000).optional(),priority:z.enum(['high','medium','low']).optional(),tags:z.array(z.string().max(80)).max(20).optional(),startAt:z.string().nullable().optional(),endAt:z.string().nullable().optional(),dueDate:z.string().nullable().optional(),sourceUrl:z.string().max(2048).optional(),groupKeys:z.array(z.string().min(1).max(80)).max(20).optional(),sourceStatus:z.enum(['scheduled','postponed','cancelled','finished']).optional()}).strict();
  const snapshot=z.object({schemaVersion:z.literal(1),revision:z.number().int().positive(),groups:z.array(z.object({key:z.string().min(1).max(80),title:z.string().min(1).max(80)}).strict()).max(200).optional(),category:z.object({key:z.string().min(1).max(80),title:z.string().min(1).max(80),color:z.enum(['blue','green','violet','amber','rose','slate']).optional()}).strict().optional(),items:z.array(source).max(500)}).strict();
  server.tool('publish_tool_follow_sources','发布已核实的 HTML 工具关注资料。先用 list_tools 核对数值 ID；单调递增 revision，旧修订或同修订不同内容拒绝。只更新已确认关注的待办，保留手动修改、完成和删除记录；无关注时不创建待办或分类。HTML 的 dayfolio-follow.json 随 update_tool 更新时共用此入口，页面关闭仍生效；不代表已联网核实。',{toolId:z.number().int().positive(),snapshot},async p=>wrap(()=>core.toolFollowing.publish(p))());
  server.tool('preview_tool_follow','只读预览 HTML 工具单项或分组持续关注范围、来源修订、分类及已有关联。分组首次确认后，新资料中的未来事项会自动加入。',target,async p=>wrap(()=>core.toolFollowing.preview(p))());
  server.tool('follow_tool_scope','用户明确确认持续关注后调用。携带 preview_tool_follow 的 revision 作为 expectedRevision；单项与分组共用去重关联，手改或已完成记录受保护，未知时间不编造；空分组只保存关注，不创建空分类。',{...target,expectedRevision:z.number().int().positive()},async p=>wrap(()=>core.toolFollowing.follow(p))());
  server.tool('unfollow_tool_scope','用户要求停止持续关注时调用，保留已有待办。取消单项后，分组更新不会自动启用该事项；取消分组不影响其他仍有效的关注规则。',target,async p=>wrap(()=>core.toolFollowing.unfollow(p))());
  server.tool('get_tool_follow_state','查询本 HTML 工具的关注规则、来源修订及关联摘要，不返回个人备注。可指定最多 500 个 sourceKeys；默认最多返回 500 项，并告知是否截断。',{toolId:z.number().int().positive(),sourceKeys:z.array(z.string()).max(500).optional()},async p=>wrap(()=>core.toolFollowing.getState(p))());
  server.tool('get_tool_todo_following','按待办 ID 读取 HTML 关注状态与最新来源，用于核对手动接管、待同步修订或恢复跟随的影响；没有关联返回 null。',{todoId:z.number().int().positive()},async p=>wrap(()=>core.toolFollowing.getTodo(p))());
  server.tool('resume_tool_todo_following','用户明确同意用最新来源覆盖个人标题和时间后恢复跟随；先读取 get_tool_todo_following 并核对两个修订。保留备注、标签、优先级，不重开或修改已完成记录。',{todoId:z.number().int().positive(),expectedSourceRevision:z.number().int().positive(),expectedTodoRevision:z.number().int().nonnegative()},async p=>wrap(()=>core.toolFollowing.resume(p))());
  server.tool('stop_tool_todo_following','用户要求把当前事项留作个人待办时，停止该事项的全部 HTML 来源跟随，保留内容与分类，分组更新不会重新启用它。',{todoId:z.number().int().positive()},async p=>wrap(()=>core.toolFollowing.stopTodo(p))());
}
