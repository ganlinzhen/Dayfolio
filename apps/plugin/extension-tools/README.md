# 历史运行时工具协议资料

当前 Dayfolio 工具箱仅导入 HTML，不再提供本目录旧工具包的安装、启停、卸载与回滚入口。新建或更新工具请使用唯一 Dayfolio 技能中的 HTML 流程。下列协议、模板与校验器仅为已有事件来源的兼容维护保留，不代表当前可用的工具交付方式。

# 历史作者包（v1）

本目录随统一 Agent 能力包分发，可复制到宿主仓库外独立使用。`pack.mjs`、`validate.cjs` 和静态模板只需 Node 22.13+ / 24；作者无需安装宿主源码、npm 依赖、原生模块或 Electron，也不运行宿主代码生成或打包。

宿主底座仍须先发布一次支持 v1 的版本。能力范围是标准事件、公共 JSON、受限订阅与导航；新增原生认证或宿主能力仍需要宿主升级。

## 最小操作

1. 在新目录编写 `manifest.json`、HTML、JS、CSS、`help.md` 及可选标准 `events.json`。参考已完成的欧冠包和 `template/`；身份必须全新且稳定，后续更新递增版本而不改 ID。
2. 运行 `node /本作者包/pack.mjs /新工具目录`。这只生成包内文件摘要并调用独立校验器，不编译或修改宿主。
3. App 工具箱点击「安装或更新工具包」，选择目录，在可信预览里核对权限与网络目标后安装。MCP 仅能使用宿主已授予的当前摘要授权，不能自行授予新权限。
4. 后续事件更新调用固定 MCP `list_event_providers` → `import_external_events` → 读回。不要每次更新赛程都发布页面版本；种子只为首次安装和新事件提供数据，旧种子不会回退最新事实。

现有包独立校验：`node /本作者包/validate.cjs /工具目录`。资源清单必须完整，改动任一文件后重新执行 pack。帮助由当前 release 动态读取，无需修改宿主帮助生成物。

## 页面 SDK

HTML 引用 `<script src="/__dayfolio_sdk__/v1.js"></script>`，该绝对保留路径属于当前工具的独立来源；不要拼接内容摘要。

等待 `await window.Dayfolio.ready` 后调用 `Dayfolio.call('runtime.describe', {})` 获取实际身份与权限。标准方法及 Schema 见 `contracts/`。providerId 由 `ext:<extensionId>/<providerLocalId>` 生成；请求不能传入任意身份、SQL、IPC 或内部标志。

`events.list` 必须读完 nextCursor；游标因数据或授权变化失效时重新查询。`subscriptions.subscribe` 本身幂等。取消订阅显式传 `todoPolicy:'keep'`。恢复跟随必须读取并核对事件与待办两个 revision。

`Dayfolio.onChanged` 只提示重新查询，关闭页面时解绑。升级、撤权、停用、卸载、reload 均会使旧文档会话失效，不能缓存令牌或访问父页面对象。

`providers.refresh` 立即返回 queued/reused，不等于已更新；`providers.getStatus` 在 P4 实现的返回中附带 mode（http-json / external-agent）、运行状态及最后成功时间。外部助手来源不会自动执行 AI，只有实际导入才完成请求。

## HTTP JSON 配置

仅公共 HTTPS GET，无凭据或自定义请求头。itemsPath / fieldMappings 只支持安全点分属性和标量 literal，statusMap 明确列出状态映射，不执行任意表达式。必须明确映射所有时间字段，未知填 null。数组索引、根数组转换、数字 ID 转字符串、状态条件和外部认证等超出能力时由助手归一化后导入。

URL 固定在已审阅的包中，不能通过 SDK 参数改写目标；域名/路径前缀和每次重定向均受限。已知日期参数 fromDate/toDateExclusive、from/to、startDate/endDate、date_from/date_to、start_date/end_date 必须成对，跨度不超过100天；date 支持单日，dates 支持 YYYYMMDD 或不超过100天的 YYYYMMDD-YYYYMMDD。拒绝本地/内网/保留 IP，DNS 混入私有地址也拒绝，连接固定至已检查地址。

App/MCP 运行时按 refreshSeconds 到期排队，同来源单一有效任务；机器休眠恢复最多补一次。App 与 MCP 均未运行时不承诺执行。

## 第二领域验证

`node /本作者包/generate-sample-tool.mjs /全新目录 [新extensionId] [标题]` 生成含定时、全天两条合成演出的工具包。它只改外部目录，明确标记模拟。可在独立临时环境验证标准事件与订阅；这些内容不是真实演出资料。

真实欧冠来源为 OpenLigaDB 社区 API（ODbL 1.0），本轮覆盖18场、非整季；来源页记录核验时间与缺口。不要将社区 API 描述为赛事官方服务，也不把未确认的取消/延期或未知时间猜测为事实。
