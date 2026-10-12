# Design

## Theme

「Codex 纸面」：暖白背景上的黑白编辑部风格。设计服务于任务，不抢戏。当前事实标准来自 `apps/desktop/src/renderer/src/styles.css`。

## Colors

- `--bg #faf9f7` 暖白纸面（body）
- `--surface #ffffff` 卡片 / 侧栏 / 输入容器
- `--line #e8e7e3` / `--line-strong #d6d4cf` hairline 边框两级
- `--text #1a1a19` / `--text-2 #57564f` / `--text-3 #98968e` 三级墨色（text-3 仅限短元信息，正文用 text/text-2）
- `--accent #1a1a19` 黑白主色：主按钮、勾选圆钮、激活分段
- `--danger #b3401f`（逾期 / 删除）、`--ok #46730b`（成功 / 已打卡）、`--warn-text #8a6d01`
- `--sel #f0efeb` 悬停 / 选中底色
- 阴影一律不用：分层靠 hairline 与底色差

## Typography

- serif（ui-serif / New York / 宋体）：面板大标题、计划标题、统计大数字
- sans（-apple-system / 苹方）：正文、按钮、表单
- mono（SF Mono）：日期、统计元信息、分组标签（大写 + 0.7px tracking，仅限 ≤4 词短标签）
- 字阶：h1 26 / 计划题 15.5 / 正文 14 / 元信息 12–12.5 / 微标签 11

## Components

- 按钮 `.btn`：默认 hairline；`.primary` 黑底白字；`.ghost` / `.slim` 变体
- 完成圆钮 `.check`：1.4px 圆环；`.high` 红环；`.checked` 黑底白勾
- 分段控件 `.seg`、行式输入 `.composer`、搜索框 `.searchbox`
- 分组 `.group`：mono 大写标签 + 计数胶囊
- 行 `.todo-row` / `.plan-item` / `.checkin-row`：hairline 分隔，悬停显删除钮
- 提示条 `.notice`（warn / error）、统计卡 `.stat`、热力点 `.heat-dot`
- 圆角：卡片 8px，控件 6–7px

## Layout

- 左侧 208px 白底侧栏 + 右侧内容区（max-width 780px 居中，padding 34px 40px 60px）
- 纵向节奏：panel-head → 摘要 / 副标题 → composer → toolbar → notice → groups

## Motion

- 无入场编排；状态过渡 ≤ 200ms ease-out，仅用于 hover / 勾选 / 进度条
- `prefers-reduced-motion: reduce` 时全部过渡改为即时
