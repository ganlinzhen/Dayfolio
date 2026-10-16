# 项目文档

`doc/` 用于存放Dayfolio 的项目架构、技术设计和开发说明。

| 文档 | 内容 |
| --- | --- |
| [当前项目数据流架构](data-flow-architecture.md) | 整体架构、主要数据流、存储边界与源码入口 |
| [数据流架构图 · SVG](data-flow-architecture.svg) | 可编辑、可缩放的架构图 |
| [数据流架构图 · PNG](data-flow-architecture@2x.png) | 高清预览，适合分享或插入文档 |
| [数据库与本体设计](database-design.md) | 本体 3 表、业务分组、关系承载、扩展机制及实际库差异 |
| [数据库表结构明细](database-table-reference.md) | 35 张源码表与 2 张实际库额外表的字段、索引、外键和 DDL |
| [数据库 schema 快照](database-schema.json) | 程序可读的结构与类型定义，不包含业务记录 |
| 数据库与本体分层图：[SVG](database-architecture.svg) / [PNG](database-architecture@2x.png) | 元数据层、运行时与业务实体层如何对应 |
| 学习、待办和课程关系图：[SVG](database-learning-er.svg) / [PNG](database-learning-er@2x.png) | 计划、条目、打卡、历史证据与课程关系 |
| 新闻、知识库和创作关系图：[SVG](database-content-er.svg) / [PNG](database-content-er@2x.png) | 新闻来源、素材中间表、创作链路、知识索引与工具 |

文档约定：

- 用简体中文编写，记录核对日期与适用范围。
- 架构说明以当前源码为依据；模块或数据流变化时，同时更新文字和图。
- 项目技术文档放在此目录；应用内帮助内容继续维护在 `apps/help/docs/`，按项目约束同步生成。
- 文档中的源码链接使用相对路径，方便在其他机器和代码托管平台查看。
