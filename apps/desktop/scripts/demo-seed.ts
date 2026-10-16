// 预览沙盒共享演示数据播种（preview-isolated.mjs 与定向单测共用；esbuild 可打包为 cjs 入口）。
// 四模块闭环（全部写调用方给定的临时库/临时目录，可见名称带「演示」，不伪造正式确认/发布/掌握）：
//   1. 新闻（agent-only）：旧版历史 2 条（含 1 收藏）+ 已完成任务（2 条 agent 新闻）+ 待执行任务；
//   2. 知识库：临时目录内建「演示」测试 vault（3 篇笔记，wikilink 互联）→ 注册 + 只读索引扫描；
//   3. 自媒体：选题（来源关联演示新闻）→ 母稿 → 双平台版本 → 一条走完 提交→（模拟用户历史操作）审核通过→
//      排期→手动发布占位→指标；另一条停在「待人工审核」留给用户体验；素材挂载；
//   4. 课程：以内置的「Dayfolio 上手之旅」演示样课（自包含，不依赖任何外部资产）构造课程包
//      导入临时库，绑定临时演示计划；**不确认样课**（确认入口留给用户）。
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { openNodeSqliteDb } from '../../../packages/core/src/adapters/node-sqlite';
import { addDays, createCore, todayStr, type TodoDeskCore } from '../../../packages/core/src/index';

/** 段级包含（防同级前缀绕过：/tmp/a-evil 不会通过 /tmp/a 的前缀检查） */
const insideSegment = (child: string, parent: string): boolean => {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

export interface DemoSeedResult {
  news: { legacy: number; agent: number; starred: number; completedTaskId: number; pendingTaskId: number };
  vault: { id: number; notes: number };
  media: { topicId: number; contentId: number; approvedVersionId: number; pendingVersionId: number; materialId: number; calendarId: number };
  course: { id: number; planId: number; lessons: number; sampleConfirmed: boolean };
  calendar: { events: number };
}

/** 内置演示课程内容（自包含：预览与冒烟共用同一份，不依赖机器上的任何课程资产） */
const DEMO_COURSE_LESSON_HTML = [
  '<h1>Dayfolio 上手之旅 · 第 1 天</h1>',
  '<link rel="stylesheet" href="../assets/style.css">',
  '<p>欢迎打开 Dayfolio！这是一门内置的演示课程，带你用五分钟认识四个核心能力。</p>',
  '<h2>本地优先</h2>',
  '<p>待办、学习计划、打卡、新闻与知识库全部保存在本机 SQLite 数据库里，不上传、不联网同步。</p>',
  '<h2>学习闭环</h2>',
  '<p>把课程包导入学习计划，逐日阅读讲义、完成练习，再由打卡与间隔复习把知识留住。</p>',
  '<h2>AI 接入</h2>',
  '<p>通过 MCP 协议，外部 AI 客户端可以与你读写同一份数据——采集新闻、生成计划、整理素材都由它代办。</p>',
  '<p><em>这是演示样课：阅读并确认后，完整课程才会生成。</em></p>',
].join('\n');

const DEMO_COURSE_STYLE_CSS = [
  '/* Dayfolio 演示课程样式 */',
  "body { font-family: -apple-system, 'PingFang SC', sans-serif; line-height: 1.7; color: #1a1a19; max-width: 640px; margin: 0 auto; padding: 24px; }",
  'h1 { font-size: 22px; }',
  'h2 { font-size: 17px; margin-top: 24px; }',
].join('\n');

/** 演示 vault 笔记（明确标注「演示」；只建在临时目录，绝不写真实 Obsidian） */
const writeDemoVault = (vaultRoot: string): void => {
  mkdirSync(join(vaultRoot, 'knowledge/moc'), { recursive: true });
  mkdirSync(join(vaultRoot, 'knowledge/resources/fa'), { recursive: true });
  mkdirSync(join(vaultRoot, 'knowledge/inbox-cards'), { recursive: true });
  writeFileSync(join(vaultRoot, 'knowledge/moc/首页.md'), '---\ntitle: 演示·首页\n---\n【演示 vault】导航入口：[[演示·知识库价值公式]]。');
  writeFileSync(
    join(vaultRoot, 'knowledge/resources/fa/演示·知识库价值公式.md'),
    '---\nstatus: active\ntags: [方法论, 演示]\n---\n【演示卡片】核心：价值 = 沉淀 × 复用。\n\n## 边界\n不适用流水记录。返回 [[演示·首页]]。',
  );
  writeFileSync(join(vaultRoot, 'knowledge/inbox-cards/演示·待审草稿.md'), '---\nstatus: draft\n---\n【演示】待加工草稿。');
};

/** 内置演示课程包（slug/标题唯一且带「演示」语义；绝不改真实库或其确认字段） */
const buildCourseStage = (stage: string, planId: number): string => {
  mkdirSync(join(stage, 'lessons'), { recursive: true });
  mkdirSync(join(stage, 'assets'), { recursive: true });
  writeFileSync(join(stage, 'lessons/0001-quick-tour.html'), DEMO_COURSE_LESSON_HTML);
  writeFileSync(join(stage, 'assets/style.css'), DEMO_COURSE_STYLE_CSS);
  writeFileSync(
    join(stage, 'course.json'),
    JSON.stringify({
      slug: 'tododesk-tour',
      title: 'Dayfolio 上手之旅',
      goal: '五分钟认识 Dayfolio 的四个核心能力（预览演示）',
      version: '1.0.0',
      plan_id: planId,
      lessons: [{ day: 1, title: 'Dayfolio 上手之旅 · 第 1 天', html: 'lessons/0001-quick-tour.html', is_sample: true }],
    }),
  );
  return stage;
};

export function seedDemo(core: TodoDeskCore, work: string): DemoSeedResult {
  // ---------- 防御性断言（realpath + 段级包含）：所有路径必须位于同一新建临时目录，
  // 拒绝真实 HOME / 真实 vault / 真实资产路径；同级前缀目录（如 td-preview-x-evil）不得通过 ----------
  const realWork = realpathSync(resolve(work));
  const realTmp = realpathSync(resolve(tmpdir()));
  const realHome = realpathSync(homedir());
  if (!insideSegment(realWork, realTmp) || insideSegment(realWork, realHome) || realWork === realHome) {
    throw new Error(`演示播种拒绝执行：work 不在安全临时区（realpath=${realWork}）`);
  }
  for (const forbidden of [
    join(realHome, 'Library', 'Application Support'),
    join(realHome, 'Desktop', 'knowledge-base'),
  ]) {
    if (insideSegment(realWork, forbidden) || realWork === forbidden) {
      throw new Error(`演示播种拒绝执行：work 命中真实数据区（${forbidden}）`);
    }
  }
  const vaultRoot = join(work, 'demo-vault');
  const courseStage = join(work, 'course-stage');
  const workLex = resolve(work);
  for (const p of [vaultRoot, courseStage]) {
    if (!insideSegment(p, workLex)) throw new Error(`演示播种拒绝执行：路径逃逸临时区（${p}）`);
  }

  // ---------- 1. 新闻（agent-only） ----------
  const now = Date.now();
  const legacy = core.db.prepare(
    "INSERT INTO news (source, title, url, summary, published_date, fetched_at, dedup_key, is_starred) VALUES ('zhihu_daily', ?, 'https://old.example.com/starred', '【演示】旧收藏摘要', ?, '2026-10-01T00:00:00.000', 'demo:legacy:starred', 1)",
  );
  legacy.run('【演示】值得收藏的旧闻', new Date(now - 3 * 86400_000).toISOString().slice(0, 10));
  core.db
    .prepare(
      "INSERT INTO news (source, title, url, summary, published_date, fetched_at, dedup_key) VALUES ('hacker_news', ?, 'https://old.example.com/plain', '【演示】旧普通摘要', ?, '2026-10-01T00:00:00.000', 'demo:legacy:plain')",
    )
    .run('【演示】普通旧闻', new Date(now - 2 * 86400_000).toISOString().slice(0, 10));

  const task = core.news.createTask({ title: '【演示】AI 领域动态（已完成）', instructions: '演示规则：只要一手来源', max_items: 5 });
  const claim = core.news.claimTask(task.id, 'demo-agent');
  const submitted = core.news.submitItems(task.id, claim.claim_token, [
    { title: '【演示】agent 新闻一', summary: '【演示】近一小时核实的摘要（原始来源见详情页）。', source_url: 'https://example.com/demo-1', source_name: 'Example News', published_at: new Date(now - 3600_000).toISOString() },
    {
      title: '【演示】X 快照新闻（本地快照展示）',
      summary: '【演示】X 来源无法内嵌，agent 提交本地 HTML 快照演示。',
      source_url: 'https://x.com/demo_author/status/1799999999999999999',
      source_name: 'X',
      published_at: new Date(now - 7200_000).toISOString(),
      html: [
        '<article>',
        '<h3>demo_author @demo_author · 演示推文</h3>',
        '<p>【演示】这是一条 X 推文的本地快照：正文、配图与原帖链接都保存在数据库旁的 news/ 目录，详情页用它代替无法内嵌的 x.com 页面。</p>',
        '<img src="https://pbs.twimg.com/media/demo-placeholder.jpg" alt="演示配图">',
        '<p><a href="https://x.com/demo_author/status/1799999999999999999">原帖链接</a></p>',
        '</article>',
      ].join(''),
    },
  ]);
  core.news.completeTask(task.id, claim.claim_token, '演示完成');
  const pendingTask = core.news.createTask({ title: '【演示】前端生态观察（待执行）', instructions: '演示：等待助手认领' });

  // ---------- 2. 知识库（演示 vault：只读索引） ----------
  writeDemoVault(vaultRoot);
  const vault = core.vaults.register({ root_path: vaultRoot, name: '演示知识库' });
  const scan = core.vaults.scan(vault.id);
  if (scan.discovered !== 3) throw new Error(`演示 vault 扫描异常：${scan.discovered} 篇（预期 3）`);

  // ---------- 3. 自媒体（一母多版 + 人工审核 + 排期发布占位 + 指标 + 素材） ----------
  const topic = core.media.addTopic({ title: '【演示】选题：知识库工作流', angle: '实操向', source: 'news', source_news_id: submitted.items[0].id });
  const content = core.media.addContent({ topic_id: topic.id, title: '【演示】母稿：只读联动实践', master_content: '【演示母稿】先索引、再关联、后复用……' });
  const vXhs = core.media.addVersion(content.id, { platform: 'xiaohongshu', body: '【演示】小红书版：三步搭建知识库工作流' });
  const vWx = core.media.addVersion(content.id, { platform: 'weixin', body: '【演示】公众号版：只读联动的边界与价值' });
  core.commands.human.reviewMediaVersion(vXhs.id, 'submit');
  // 模拟用户在演示沙盒内的历史审核动作（approve 是用户专属动作，此处仅为演示数据）
  core.commands.human.reviewMediaVersion(vXhs.id, 'approve', '演示：用户审核通过');
  const cal = core.media.schedule({ content_version_id: vXhs.id, planned_date: todayStr(), note: '演示排期' });
  core.media.markPublished(cal.id, { publish_url: 'https://example.com/demo/published', note: '演示：手动发布占位（非真实发布）' });
  core.media.addMetric({ calendar_id: cal.id, views: 1500, likes: 120, note: '演示指标' });
  // 第二版本停在待人工审核：留给用户在预览里亲自「通过/拒绝」
  core.commands.human.reviewMediaVersion(vWx.id, 'submit');
  const material = core.media.addMaterial({ title: '【演示】素材：要点清单', kind: 'text', content: '【演示素材】1. 索引 2. 关联 3. 复用', source: 'manual', source_desc: '演示素材' });
  core.media.attachMaterial(content.id, material.id);

  // ---------- 4. 课程：内置演示样课（自包含内容；不确认样课） ----------
  const today = todayStr();
  const dayDate = (offset: number): string => {
    const d = new Date(now + offset * 86400_000);
    return d.toISOString().slice(0, 10);
  };
  const plan = core.plans.create({
    title: '【演示】Dayfolio 五天上手计划', goal: '预览演示：课程与计划联动', start_date: today, daily_minutes: 45,
    items: [0, 1, 2, 3, 4].map((i) => ({ date: dayDate(i), content: `上手演示第${i + 1}天任务` })),
  });
  let imported: ReturnType<typeof core.courses.importCourse> | null = null;
  try {
    imported = core.courses.importCourse(buildCourseStage(courseStage, plan.id));
  } finally {
    rmSync(courseStage, { recursive: true, force: true }); // staging 只是导入源，绝不残留
  }
  const courseRow = core.db.prepare('SELECT sample_confirmed_at FROM courses WHERE id = ?').get(imported.course.id) as { sample_confirmed_at: string | null };

  // ---------- 5. 日历：演示日程（今日页月历，App/MCP 同源） ----------
  core.calendar.add({ title: '【演示】晨会', date: today, start_time: '09:30', end_time: '10:30', color: 'blue', note: '演示定时日程' });
  core.calendar.add({ title: '【演示】家庭日', date: today, color: 'rose' });
  core.calendar.add({ title: '【演示】外出培训', date: addDays(today, 1), end_date: addDays(today, 3), start_time: '09:00', color: 'violet', note: '演示跨天日程' });
  core.calendar.add({ title: '【演示】牙医复诊', date: addDays(today, -2), start_time: '15:30', color: 'amber' });

  return {
    news: { legacy: 2, agent: submitted.items.length, starred: 1, completedTaskId: task.id, pendingTaskId: pendingTask.id },
    vault: { id: vault.id, notes: scan.discovered },
    media: { topicId: topic.id, contentId: content.id, approvedVersionId: vXhs.id, pendingVersionId: vWx.id, materialId: material.id, calendarId: cal.id },
    course: { id: imported.course.id, planId: plan.id, lessons: imported.lessons.length, sampleConfirmed: courseRow.sample_confirmed_at != null },
    calendar: { events: 4 },
  };
}

// ---------- cjs 入口（esbuild 打包后由预览/冒烟运行）：argv = <dbPath> <work> ----------
// 课程内容为内置常量（自包含），无需任何外部资产参数。
const isMain = typeof require !== 'undefined' && require.main === module;
if (isMain) {
  const [dbPath, work] = process.argv.slice(2);
  function failEntry(msg: string, code: number): never {
    console.error(JSON.stringify({ ok: false, error: msg }));
    process.exit(code);
  }
  if (!dbPath || !work) failEntry(`播种入口断言失败：缺少 dbPath/work 参数`, 3);
  // 同目录校验用 lexical 空间（db 由同一 work 字符串拼接；realpath 混用会在 macOS /var vs /private/var 误判）
  const workLex = resolve(work);
  const relDb = relative(workLex, resolve(dbPath));
  if (relDb === '' || relDb.startsWith('..') || isAbsolute(relDb)) {
    failEntry(`播种入口断言失败：dbPath 不在传入 work 内（db=${dbPath} work=${work}）`, 3);
  }
  // 区域校验用 realpath 空间（防符号链接绕过）
  const realWork = realpathSync(workLex);
  const realTmp = realpathSync(resolve(tmpdir()));
  const realHome = realpathSync(homedir());
  if (!insideSegment(realWork, realTmp)) {
    failEntry(`播种入口断言失败：work 不在系统临时区（realpath=${realWork}）`, 3);
  }
  const homeRel = relative(realHome, realWork);
  if (homeRel === '' || (!homeRel.startsWith('..') && !isAbsolute(homeRel))) {
    failEntry(`播种入口断言失败：work 命中真实 HOME`, 3);
  }

  const core = createCore(openNodeSqliteDb(dbPath), { dbPath });
  try {
    const r = seedDemo(core, work);
    if (r.course.sampleConfirmed) throw new Error('红线：演示样课不得处于已确认状态');
    console.log('SEED_OK', JSON.stringify(r));
  } finally {
    core.db.close();
  }
}
