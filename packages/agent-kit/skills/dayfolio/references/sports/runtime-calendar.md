# HTML 赛事页、持续关注与历史订阅

工具箱统一使用 HTML。制作赛事页时通过 `add_tool` 导入 HTML 及配套资源；更新已有页面先 `list_tools` 核对数值 ID，再通过 `update_tool` 提交完整文件集。无需 manifest、安装授权、工具版本或回滚流程，不再生成新的运行时工具包。

HTML 页面可接入宿主提供的 [待办接口](../html-todos.md)，以稳定比赛 ID 请求单场添加或球队批量添加。需要改期同步或后续新比赛时，同时接入 [通用持续关注](../html-following.md)：单场使用 item 范围，球队使用稳定 group 键；`dayfolio-follow.json` 与页面资料同步更新，页面关闭后也同步已确认规则。App 提供预览确认，保留个人修改、已完成和已删除记录；原页面筛选偏好与收藏仍独立。不自动登记历史事件来源，不引用旧 `/__dayfolio_sdk__/v1.js`，也不读取原始 IPC、数据库或父页面对象。

欧冠页分别提供「加入待办」「持续关注」和球队「持续关注赛程」，已有待办可点详情。助手更新 `sports-page.json`、内嵌快照与完整文件时，同时更新来源清单及一致的 revision、sourceKey 和球队分组键；不能只更新显示时间或比分。来源仍须实际核实，不把持续关注说成后台联网采集。

用户要维护已有订阅时，先调用 `get_runtime_tool_contract`、`list_event_providers` 与必要的 `list_extensions` 核对历史来源；最后一项只用于历史事件身份，不代表当前工具箱列表。历史事件仍通过 `import_external_events`、`subscribe_event`、`unsubscribe_event`、`query_calendar_items` 等专用业务入口操作。不要把页面导入等同于登记新来源或获得订阅权限。

更新已有来源时读取 provider revision，使用唯一 batchId 和完整快照，保护用户待办标题、排期和完成记录。HTML 资料页与事件库分别更新、分别回读；复制提示词、排队和文件写入均不等于资料已核实或刷新成功。

隔离验收使用独立 DB、HOME、userData，检查 HTML 入口、图片、筛选、战队详情与晋级图。删除工具前核对 ID 和标题，只删除用户指定的工具，不连带删除个人待办。
