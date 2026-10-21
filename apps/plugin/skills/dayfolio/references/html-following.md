# HTML 通用持续关注

用于会改期的赛事、活动、持续更新的分组清单等。所有领域共用同一来源模型，不新建赛事专用表或接口。用户确认的是持续同步规则，页面展示偏好、收藏与一次性添加仍独立。

## 制作与更新工具

按内容判断价值：有可验证的稳定事项身份、变化来源和持续安排需求时，主动提供单项或分组「持续关注」；纯计算工具不强加关注。保留一次性加入入口，并清楚区分两者。

随 HTML 提交根目录 `dayfolio-follow.json`：

```json
{
  "schemaVersion": 1,
  "revision": 1,
  "category": {"key": "events", "title": "活动", "color": "green"},
  "groups": [{"key": "reading", "title": "读书会活动"}],
  "items": [{
    "sourceKey": "session:stable-id",
    "title": "参加阅读讨论",
    "startAt": "2026-11-04T10:00:00+08:00",
    "sourceUrl": "https://example.com/session",
    "groupKeys": ["reading"],
    "sourceStatus": "scheduled"
  }]
}
```

来源项沿用 [待办草稿](html-todos.md)，另有可选 `groupKeys` 和 `sourceStatus`（scheduled/postponed/cancelled/finished）。时间未知省略，不推算结束时刻。分组键和名称最长 80 字，最多 200 组；每批最多 500 项、512 KiB，每项最多归入 20 组。稳定来源键按工具隔离，不能包含可变日期；单项、分组与快照添加共用同一键。

修订为正整数且单调递增；相同修订相同内容幂等，不同内容拒绝，旧资料不能覆盖新资料。页面脚本与清单使用同一修订和内容；更新清单时递增页面 revision，保留 pageId、toolId、原偏好及人工记录。来源遗漏不等于取消；取消必须显式发布状态。使用来源清单的工具仍有有效关注时，完整文件更新不能移除清单，停止关注后才可移除。失败时保留旧资料，文件更新和待办同步整体回滚。

通过 `update_tool` 更新完整文件集时，宿主读取清单并同步已确认的关注，即使 HTML 已关闭也生效。动态 HTML 可用 `await dayfolio.following.publish(snapshot)` 发布相同结构；它只能更新本工具的来源。首次发布或导入不代表用户关注，不自动生成待办或分类。

这不是后台联网采集器。资料必须由页面或助手实际核实并发布；只改文件时间、复制指令、排队、打开页面或展示旧快照，不算完成来源更新。

## 页面接口

先检查 `dayfolio.following` 并等待 ready；旧 App 没有此能力时保留一次性添加并说明升级入口。

```js
await dayfolio.ready;
await dayfolio.following.publish(snapshot);
await dayfolio.following.follow({kind: 'item', key: 'session:stable-id'});
await dayfolio.following.follow({kind: 'group', key: 'reading'});
await dayfolio.following.unfollow({kind: 'group', key: 'reading'});
const state = await dayfolio.following.getState({sourceKeys: ['session:stable-id']});
await dayfolio.todos.open('session:stable-id');
```

`follow` 和 `unfollow` 打开宿主确认弹窗；取消抛出 USER_CANCELLED，页面恢复按钮，不伪报成功。`following.preview(scope)` 只读，不登记规则。分组没有未来事项时仍可确认保存规则，实际出现新事项后才创建待办与分类。状态摘要只返回本工具的来源键、待办 ID、状态、跟随模式与修订，不返回个人备注等内容；默认最多 500 项，truncated=true 时按当前来源键读取。

已确认分组后，新发布的未来事项或时间待定事项自动加入；过去、已结束或已取消的事项不自动新增。单项与多个分组重叠只生成一条待办。取消分组保留已有待办，其他仍有效的规则继续生效；取消单项会阻止分组重新启用它。删除工具停止所有关注，保留个人待办；删除分类停止该分类规则，防止后续更新重新创建分类。

## 手动修改和完成保护

自动同步只更新标题和排期，保留备注、标签、优先级与分类偏好。用户修改标题或时间后进入 manual，不再自动覆盖；未修改的事项继续同步。旧快照没有创建基线时采取保守判断，不能把个人内容当成可覆盖的来源。已完成记录保持原样，不自动重开；已删除记录不自动恢复。

用户通过页面「详情」、待办「来源详情」或日历打开宿主详情，可查看最新来源、停止关注或恢复跟随。恢复时先展示影响，明确确认后携带最新来源修订与待办修订；过期拒绝覆盖，已完成记录继续受保护。助手不能仅因来源有更新擅自恢复用户接管的事项。

## MCP

先 `list_tools` 确认 toolId。资料发布用 `publish_tool_follow_sources`，关注按 `preview_tool_follow` → 用户明确授权 → `follow_tool_scope`（expectedRevision）→ `get_tool_follow_state` 回读。停止用 `unfollow_tool_scope`。

单条待办管理用 `get_tool_todo_following`、`stop_tool_todo_following`、`resume_tool_todo_following`。恢复前读取两个修订、说明将覆盖标题和时间并取得用户明确确认。App 与 MCP 共用 Commands，不直接写数据库或改 HTML 冒充真实关注状态。

隔离验收覆盖预览取消、零事项分类、重叠去重、资料改期、新增事项、手动/已完成/已删除保护、明确恢复、取消、旧版本拒绝、跨工具隔离，以及关闭页面更新文件后的真实待办回读。
