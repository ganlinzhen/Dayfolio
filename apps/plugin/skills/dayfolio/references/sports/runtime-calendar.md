# 运行时赛事日程工具

当用户需要单场订阅、关联待办或日历分类时采用此路径；普通网页展示和旧 HTML 更新沿用原流程。先调用 `get_runtime_tool_contract` 核对实际支持，不能根据技能文字假定旧 App 已升级。

作者工具位于完整能力包的 `extension-tools/`，说明与合同见 [作者指南](../../../../extension-tools/README.md)。Node 运行 `pack.mjs` / `validate.cjs`，仅对工具目录生成摘要和校验。无需宿主源码、npm 安装、专用 MCP 注册或宿主重新打包。HTML 使用宿主 `/__dayfolio_sdk__/v1.js`，不得请求原始 IPC、数据库或父页面对象。

工具包包含 manifest、静态页面、help.md、标准事件种子和 sports-page.json。保持稳定 extensionId / pageId / provider localId；运行时侧车用 target.kind=local、entry 和 runtimeExtensionId 标明交付身份，不伪填旧工具箱数值 toolId。

首次安装先 `preview_extension_install`，在 App 可信预览审阅所请求权限与来源。只有取得针对该摘要/基线的 authorizationRef 后才能 `install_extension`；MCP 没有自行授权工具。不要直接写授权表。安装后通过 list_extensions、list_event_providers、list_external_events 和实际工具页回读。

赛事获取仍按来源参考执行。标准事件必须显式给出四个时间字段；timed 含 Z/偏移，all_day 使用结束日排他，tbd 不填猜测日期。externalId 来源于供应商稳定 ID，改期不换身份。没有可靠异常状态时核验或明确缺口，不把未结束全部猜为确定待赛。

公开 JSON 只有在 v1 声明映射能完整表达时才配置 http-json。根数组、数值 ID 转换、复杂条件和需认证来源由助手在宿主外归一化，再通过固定 import_external_events 提交。App 不自动运行 AI；外部助手来源请求显示 queued，实际导入后才完成。

数据更新先读 provider revision，使用唯一 batchId 和完整事件快照导入，再读回任务、事件和订阅。只更新比赛事实时不升级页面或重放种子；页面/帮助变更才递增工具版本并重新预览安装。空响应与失败保留旧数据。已订阅待办的用户标题、排期、备注和完成状态由公共订阅规则保护，助手不直接重写这些待办。

验证使用独立 DB、HOME、userData。安装包、页面能打开、资料真实、刷新成功、无宿主重构建是不同证据，分别报告。
