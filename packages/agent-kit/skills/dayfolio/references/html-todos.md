# HTML 工具待办接口

Dayfolio 为工具箱 iframe 中的 HTML 提供 `window.dayfolio`，不需要运行时工具包或 manifest。源页面 CSP 须允许同源脚本；独立浏览器和旧版 App 可能没有该接口，须保留展示功能并说明待办连接不可用。不要读取数据库、父页面业务对象或原始 IPC。

## 创建工具时主动判断

用户让你制作工具时，检查其中是否存在值得执行、安排或提醒的具体事项，并主动决定接入方式，不等用户再点名要求：

- 赛事、活动、演出、会议等可安排事件：默认提供单项「加入待办」；存在球队、日期、轮次或分组选择时，提供对应的批量入口。
- 截止事项、学习任务、练习或行动清单：为可以独立完成的条目提供入口；已由学习计划等既有业务生成待办的条目，复用原关联，不再创建重复记录。
- 纯计算、解码、检索或历史资料展示：根据是否产出明确的下一步行动判断，不强加按钮。具备执行价值但缺少可核实的内容时，简短说明可接入的场景与缺口；时间未知可保存不排期的事项，不编造日期。
- 用户明确要求只看方案、原样导入或不增加功能时，保留其范围；只提醒接入价值，不擅改原件。

在页面摘要和交付说明中，用一句话说明已增加的单项、批量入口以及一次性快照边界。自动补齐页面功能后，真实待办仍由用户点击、勾选并确认；页面打开、工具导入、收藏或关注不触发创建。

为新条目选定稳定来源键，批量和单项使用同一键。批量预览标明已存在、已完成和已移除的记录，页面捕获取消及失败并恢复按钮。验收时在隔离数据库里验证预览、取消、确认、重复添加和分组批量，禁止把测试待办写入用户库。

## 分类与待办数据类型

「欧冠」「英超」「读书会」等属于待办的业务分类，复用同一个待办数据模型；不要为每个领域新建本体类型、数据库表或专用 MCP 工具。所有 HTML 工具首次确认并实际创建新待办时，宿主在同一事务中创建或复用分类；取消预览、只导入工具、全部重复和添加失败时不留空分类。省略分类声明时按工具名归类，不需要旧页面先改代码。

制作工具时根据内容声明合适的分类名称，单项和批量使用同一个稳定分类键。调用形式为 `todos.create(draft, {category: {key: 'reading', title: '读书会', color: 'green'}})` 或 `todos.createMany(drafts, options)`。键以字母或数字开头，只含字母、数字、点、下划线和连字符，最长 80 字符；名称最长 80 字符。颜色支持 `blue / green / violet / amber / rose / slate`，缺省 blue。

分类键在工具内唯一；相同名称不自动合并其他工具分类。不能传入宿主分类 ID，不能把工具箱分组直接当成待办分类。已存在的分类保留名称、颜色和日历隐藏偏好；已有待办重复添加不重新分类。删除工具保留分类和个人待办，已归档分类不能重新写入。待办列表支持分类筛选，日历的分类显示偏好只影响展示。

## 页面接口

```js
if (window.dayfolio?.apiMajor === 1) {
  await window.dayfolio.ready;
  const result = await window.dayfolio.todos.create({
    sourceKey: 'uefa:2026-27:espn-比赛ID',
    title: '观看欧冠：球队 A vs 球队 B',
    startAt: '2026-11-04T04:00:00+08:00',
    sourceUrl: 'https://example.com/match'
  });
}
```

- `todos.create(draft, options?)` 与 `todos.createMany(drafts, options?)` 打开宿主预览，用户可勾选、取消并确认，核对分类；只有确认后创建。成功返回 `{created,reused,deleted,items,category}`，category 为实际存在的分类或 null；取消抛出 `USER_CANCELLED`，页面捕获后恢复按钮，不伪报添加成功。
- `todos.getStatus(sourceKeys)` 返回 `[{sourceKey,todoId,status}]`，状态为 `missing / open / done / deleted`，不包含个人备注等数据。每批最多 100 项，页面消息最多 64 KiB。
- 草稿必填 `sourceKey`、`title`；可带 `notes`、`priority`（high/medium/low）、`tags`、`sourceUrl`。稳定来源键不含可变开球时间、队名或轮次；球队批量与单场使用相同键。同一键只在同工具内去重。
- 时间使用带 Z 或偏移的 `startAt`，可选已知 `endAt`；只知道日期使用 `dueDate`，不与固定时刻混用；时间待定全部省略，不推算结束时刻。
- 已有待办重复添加只回传状态，保留用户标题、排期、备注、完成状态；已删除记录不自动恢复。删除工具保留待办。
- 当前为一次性快照。球队关注、比赛收藏、持续订阅和来源刷新分别处理，不把静态 HTML 描述成自动跟随。

助手从 MCP 添加时先 `list_tools` 确认数值 ID，再 `preview_tool_todos` 核对条目与可选 category，按用户授权调用 `add_tool_todos`，最后 `get_tool_todo_status` 与待办回读。MCP 的 category 与页面 options.category 结构相同；`list_calendar_collections` 查询分类，`list_todos` 可按 collection_id 筛选。使用同一个 toolId/sourceKey 即可与页面共用去重；不要绕过关联服务逐条 `add_todo` 冒充工具待办。

分类管理统一使用日历的更多菜单 →「管理分类」，或 MCP `update_calendar_collection` / `delete_calendar_collection`。编辑前读取原名称与颜色，保留稳定身份和隐藏偏好；删除前核对 `deleteBlockedReason`、ID 和原名称并明确用户授权。删除自定义分类只移除分类，待办回到基础待办、本地日程回到本地日程分类，完成与去重关联保留。系统与事件来源分类不可单独删除，可隐藏。工具下次确认添加新的事项时可重新创建分类，预览与全部重复仍不创建。
