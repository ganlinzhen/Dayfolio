# HTML 赛事页与历史订阅

工具箱统一使用 HTML。制作赛事页时通过 `add_tool` 导入 HTML 及配套资源；更新已有页面先 `list_tools` 核对数值 ID，再通过 `update_tool` 提交完整文件集。无需 manifest、安装授权、工具版本或回滚流程，不再生成新的运行时工具包。

HTML 页面可接入宿主提供的 [待办接口](../html-todos.md)，以稳定比赛 ID 请求单场添加或球队批量添加。App 提供预览与勾选确认；只添加当前已知的未来比赛，球队关注与收藏仍用于页面筛选，不自动登记历史事件来源或持续跟随。不要引用旧 `/__dayfolio_sdk__/v1.js`，也不要读取原始 IPC、数据库或父页面对象。赛事资料、队标与晋级图按页面契约和视觉验收流程维护。

用户要维护已有订阅时，先调用 `get_runtime_tool_contract`、`list_event_providers` 与必要的 `list_extensions` 核对历史来源；最后一项只用于历史事件身份，不代表当前工具箱列表。历史事件仍通过 `import_external_events`、`subscribe_event`、`unsubscribe_event`、`query_calendar_items` 等专用业务入口操作。不要把页面导入等同于登记新来源或获得订阅权限。

更新已有来源时读取 provider revision，使用唯一 batchId 和完整快照，保护用户待办标题、排期和完成记录。HTML 资料页与事件库分别更新、分别回读；复制提示词、排队和文件写入均不等于资料已核实或刷新成功。

隔离验收使用独立 DB、HOME、userData，检查 HTML 入口、图片、筛选、战队详情与晋级图。删除工具前核对 ID 和标题，只删除用户指定的工具，不连带删除个人待办。
