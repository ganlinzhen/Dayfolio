# 页面契约与 Dayfolio 接入

## 文件与最小契约

交付目录包含 HTML、全部引用资源，以及不以点开头的 `sports-page.json`。Dayfolio 的本地目录收集会跳过点文件，不要把配置放入隐藏目录。允许其他 JSON/CSS/JS 文件，不能只上传入口导致资源缺失。

`schemaVersion: 1` 是本技能页面侧车契约，不是 Dayfolio 数据库表或公共 MCP 新工具。示例结构如下（对象/阶段/来源/记录按实际需求扩展，不固定赛事枚举）：

```json
{
  "schemaVersion": 1,
  "pageId": "创建时生成并保持不变的唯一标识",
  "revision": 1,
  "event": {"id": "稳定赛事标识", "name": "赛事名称", "sport": "项目", "edition": "具体届次", "scope": "single_sport"},
  "participantKinds": ["team"],
  "modules": ["schedule", "participants", "progress", "sources"],
  "preferences": {"timezone": "Asia/Shanghai", "following": []},
  "target": {"kind": "local", "entry": "index.html"},
  "stages": [{"id": "阶段ID", "name": "阶段名", "format": "经核实的赛制"}],
  "sources": [{"id": "来源ID", "kind": "official_page", "url": "https://example.org/official", "coverage": "该届赛制和指定阶段", "status": "pending", "checkedAt": null, "lastSuccessAt": null}],
  "records": [],
  "lastCheckedAt": null,
  "lastUpdatedAt": null
}
```

- `event.scope` 可为 `single_sport` / `multi_sport`，综合赛事的层级可在额外字段表示；参赛单位和模块是可扩展字符串。
- `target.kind` 为 `dayfolio` / `local` / `hosted`。Dayfolio 安装回读后在配置中记录数值 `toolId`；托管保存真实项目标识/原地址；本地位置从当前文件目录定位。保存身份不保存密钥。
- 每个来源有唯一 `id`、类型、覆盖和状态。AI 来源还包含该模块实际生成的 `prompt`，派生来源记录规则与输入来源。允许 `url` 为 null（用户输入或派生来源）；事实原始参考放在 `references` 数组。
- `records` 每项具有唯一 `id`、可扩展 `type`、有效 `sourceId`、`data` 对象；可选 `stageId` 引用已有阶段，`entityIds` 关联参赛者。`publishedAt` 未知可为 null，成功观察时间可用 `observedAt`。
- 人工记录使用 `owner: "user"`；混合记录用 `fieldOwners: {"note": "user"}` 保护顶层 `data.note`。其他层级人工内容使用独立记录或明确维护更细归属。
- `preferences` 是页面配置默认值；浏览器实时偏好以稳定 pageId 保存。更新默认值需用户要求，不能覆盖实际浏览器关注。
- 所有已知时间是含时区的 ISO 8601；检查与成功抓取时间用真实执行时间，不以比赛时间冒充抓取时间。模拟测试必须单独明确标记，不把模拟记录当实赛发布。

校验：

```bash
node <本技能目录>/scripts/validate-page.mjs <页面目录>/sports-page.json
# 更新后额外传入更新前完整配置，验证身份、范围、人工内容和修订号
node <本技能目录>/scripts/validate-page.mjs <候选目录>/sports-page.json <备份目录>/sports-page.json
```

人工偏好/内容确需由用户请求修改时，将该变更与纯数据更新分开记录，再以其为更新基线；首次绑定 toolId 也属于目标绑定，不是数据刷新。

契约允许扩展，但本脚本只验证基本结构、引用和更新边界；具体赛制、官方规则、渲染与文件完整性另验。

## App 工具箱

先使用客户端注册的 Dayfolio MCP 工具；没有注册时可读取 [dayfolio 入口](../../SKILL.md) 使用其直连脚本，或让具备 MCP 连接能力的宿主使用插件内声明的服务器。不要凭空假定存在 `get_tool`、`read_tool_file`、赛事专用工具或后台订阅服务。

1. `list_tools` 返回工具 ID、标题、分类、入口和相对文件名清单；不会返回文件正文或绝对路径。
2. 新工具：`add_tool` 用 `file_paths` 传**完整目录**，或 `files` 传全部文件的 `{name, content_base64}`。两者二选一；显式 `entry_file` 避免多个 HTML 入口歧义。
3. 更新工具：先按实际绑定或候选列表唯一确定 ID。原文件位于该 MCP 数据库同目录的 `tools/<id>/`，只有已确认同一主机和实际数据库配置时才从该处读文件，不能通过读 SQLite 绕过 MCP。远程 MCP 没有文件读取能力时要求可访问的工具包或对应宿主能力，原件保持不变。
4. 更新时在临时工作目录读取并复制**完整**旧包，对副本修改。`update_tool` 传文件会整体替换旧目录，必须携带未变 CSS/JS/图片、用户附件和侧车配置，不能只传改动文件。不传文件仅改元信息。
5. 使用同一数值 `id` 调用 `update_tool`，保留标题/图标/分类/入口，除非用户要求改变。`add_tool` 返回后配置可绑定 `toolId`，绑定时仍需保留完整文件再更新；写入前后都检查 pageId 与实际 ID 一致。
6. 回读 `list_tools`、配置和文件清单，实际打开页面确认内容。安装成功只能证明资产已存入，实际 UI 与实时源另验。

资源目录从实际数据库路径推导，不依赖 Electron userData。所有 App 写操作使用 MCP 或 core 业务入口，不直接写业务 SQLite 或覆盖现用数据库。

测试使用临时库和独立用户目录，迁移到别的 cwd 仍需成功；插件安装验证仅创建临时探针，不自动修改真实客户端连接配置。
