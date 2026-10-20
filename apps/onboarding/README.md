# Dayfolio 上手课程

本目录是「Dayfolio 上手之旅」的唯一内容源，与 `../help/docs/` 的产品说明同步维护。它是可由 MCP `import_course` 导入的课程包，不是新的应用或数据模块。

## 目录

```text
apps/onboarding/
├── course.json                    # 课程清单、稳定标识与课程版本
├── overview.html                  # 独立课程总览，不占日课天数
├── lessons/0001-quick-tour.html    # 第一天：认识能力与学习入口（样课）
└── assets/style.css               # 离线样式，导入时内联
```

当前只有一天样课，没有完整五天课程。正式 App 将本目录打包到 `Contents/Resources/onboarding/`，首次启动经现有课程服务自动导入；已有用户升级后也会补入。在「学习」页顶部点击「上手课程」即可打开。不自动创建计划或待办，也不替用户确认样课。课程库已有相同 slug 时保持原内容与进度，不自动更新已导入版本。

隔离预览会复制同一课程包到临时目录，并绑定演示计划；后续天数保持「待生成」。

## 与帮助文档同步

| 课程内容 | 对应说明文档 |
| --- | --- |
| 侧边栏导航顺序与新闻、学习入口 | `../help/docs/00-quickstart.md`、`../help/docs/05-news.md` |
| 本地数据与文件、AI 接入 | `../help/docs/08-mcp.md` |
| 计划、课程入口与逐日学习 | `../help/docs/03-plans.md`、`../help/docs/11-course.md` |
| 带课程的草案确认、双向关联核对与旧关联补齐 | `../help/docs/03-plans.md`、`../help/docs/09-study-loop.md` |
| 学习会话、测评与复习 | `../help/docs/09-study-loop.md` |
| 新闻任务、长期提示词与专题简报、助手执行边界 | `../help/docs/05-news.md` |
| 隔离预览与演示边界 | `../help/docs/14-isolated-preview.md` |

新增、修改或移除功能时，同时核对帮助文档和本课程，更新入口、操作步骤、练习和能力边界。新增用户能力时补充教学内容及上表的对应关系；描述只写当前真实行为。根目录 `AGENTS.md` 将此列为完成条件。

## 更新与验收

1. 在本目录更新总览、讲义和样式，不在预览脚本中复制内容；课程正文变化时递增 `course.json` 的课程版本，保留 slug。
2. 帮助内容有变化时，运行 `npm run help:sync`；生成文件不得手改。
3. 运行 `npm test` 和 `npm run typecheck`。演示播种测试会实际导入本目录的课程，并校验独立总览、讲义和离线样式。
4. 需要查看预览效果时，先构建桌面端，再运行 `node apps/desktop/scripts/preview-isolated.mjs`；这只写临时数据。运行 `node apps/desktop/scripts/ui-smoke-onboarding.mjs` 验证空库启动导入、阅读与重启幂等；通过 `TODODESK_SMOKE_APP` 可验收已打包 App。

更新用户已经导入的课程，必须通过课程业务流程执行；本目录不会自动覆盖真实数据，也不会代替用户确认样课。用户在 App 阅读后可直接在对话中明确确认，由助手通过专用工具记录当前版本；无需在 App 点击确认。课程包不绑定固定计划，隔离预览在临时副本上补充 `plan_id`。

学习入口验收还需核对计划/条目卡片的课件、评测与笔记进度，详情内直接展示课件与自测、提交答案、无需用时的笔记保存，评测后紧接 AI 检验、随后显示笔记，以及底部完成操作与按计划/条目复制 AI 检验提示词的范围。复制本身不启动聊天或完成任务。
