// 预览沙盒共享播种（apps/desktop/scripts/demo-seed.ts）定向单测：
// 断言四模块演示数据完整成环、课程资产只落临时库推导目录、演示样课未被确认（红线）、
// 播种入口的路径防御拒绝真实区。课程内容复用 apps/onboarding，不依赖真实用户资产。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedDemo } from '../../../apps/desktop/scripts/demo-seed';
import { mkCore } from './helpers';

const courseSource = new URL('../../../apps/onboarding/', import.meta.url).pathname;

describe('预览演示播种（四模块闭环）', () => {
  it('新闻 + 知识库 + 自媒体 + 演示样课全部落临时库；样课未确认；资产根随临时 DB', () => {
    const { core, dbPath, cleanup } = mkCore();
    try {
      const work = dirname(dbPath);
      const r = seedDemo(core, work, courseSource);

      // 新闻：2 旧（1 收藏）+ 2 agent（其一为 X 本地快照形态）+ 已完成/待执行任务
      expect(r.news).toMatchObject({ legacy: 2, agent: 2, starred: 1 });
      expect(core.news.list({ filter: 'starred', limit: 100 }).every((n) => n.title.includes('演示'))).toBe(true);
      expect(core.news.getTask(r.news.completedTaskId).status).toBe('completed');
      expect(core.news.getTask(r.news.pendingTaskId).status).toBe('pending');
      const snapItems = core.news.list({ limit: 100 }).filter((n) => n.content_kind === 'html');
      expect(snapItems).toHaveLength(1);
      expect(snapItems[0].html_rel).toMatch(/\.html$/);
      expect(existsSync(join(dirname(dbPath), 'news', snapItems[0].html_rel!))).toBe(true); // 快照文件随临时库落盘

      // 知识库：演示 vault 3 篇，wikilink 互联，读取走只读索引
      expect(r.vault.notes).toBe(3);
      const detail = core.vaults.getNote(r.vault.id, 'knowledge/resources/fa/演示·知识库价值公式.md') as unknown as { note: { title: string }; backlinks: unknown[] };
      expect(detail.note.title).toContain('演示');
      expect(detail.backlinks.length).toBe(1); // 首页 → 本卡的反链

      // 自媒体：一母多版；小红书版 approve→排期→手动发布占位→指标；公众号版停在待审
      const cals = core.media.listCalendar({}) as Array<{ id: number; status: string; content_version_id?: number }>;
      const published = cals.find((c) => c.id === r.media.calendarId);
      expect(published?.status).toBe('published');
      const metrics = core.media.listMetrics({ calendar_id: r.media.calendarId }) as Array<{ views: number | null }>;
      expect(metrics[0]?.views).toBe(1500);
      const contentDetail = core.media.getContent(r.media.contentId) as { versions?: Array<{ id: number; status: string }>; materials?: unknown[] };
      const vOk = contentDetail.versions?.find((v) => v.id === r.media.approvedVersionId);
      const vPending = contentDetail.versions?.find((v) => v.id === r.media.pendingVersionId);
      expect(vOk?.status).toBe('approved');
      expect(vPending?.status).toBe('in_review');
      expect(contentDetail.materials?.length ?? 0).toBe(1);

      // 课程：内置演示样课导入成功，绑定演示计划，**未确认**；资产根 = dirname(临时 DB)/courses
      expect(r.course.lessons).toBe(1);
      expect(r.course.sampleConfirmed).toBe(false);
      const course = core.courses.listCourses().find((c) => (c as { slug?: string }).slug === 'tododesk-tour');
      expect(course).toBeTruthy();
      expect((course as { status?: string }).status).toBe('imported');
      const lesson = core.courses.getLesson(r.course.id, 1);
      const html = core.courses.readLessonHtml(lesson);
      expect(html).toContain('Dayfolio 上手之旅');
      expect(html).toContain('当前对话中的助手直接核实并提交');
      expect(html).toContain('课程等请求仍等待外部助手执行');
      expect(html).toContain('<style>'); // 仓库课程样式经真实导入后内联
      const overview = core.courses.getOverview(r.course.id);
      expect(overview).not.toBeNull();
      expect(core.courses.readOverviewHtml(overview!)).toContain('你会学到什么');
      expect(JSON.parse(readFileSync(join(courseSource, 'course.json'), 'utf8')).plan_id).toBeUndefined(); // 演示绑定只写临时副本
      const assetFile = join(dirname(dbPath), 'courses', 'tododesk-tour', 'lessons', '0001-quick-tour.html');
      expect(existsSync(assetFile)).toBe(true); // 资产在临时库推导目录，绝不在真实 Application Support
      expect(assetFile.startsWith(tmpdir())).toBe(true);
      // 演示计划存在且属于临时库
      expect(core.plans.get(r.course.planId).title).toContain('演示');
    } finally {
      cleanup();
    }
  });

  it('路径防御：work 指向真实数据区时拒绝播种', () => {
    const { core, cleanup } = mkCore();
    try {
      // 真实 HOME 本身（存在）→ 拒绝
      expect(() => seedDemo(core, homedir(), courseSource)).toThrow(/拒绝执行/);
      // 造一个位于 HOME 内的「数据区」目录（临时 HOME 下，存在即可）→ 拒绝
      const fakeZone = join(homedir(), 'Library', 'Application Support');
      mkdirSync(fakeZone, { recursive: true });
      expect(() => seedDemo(core, fakeZone, courseSource)).toThrow(/拒绝执行/);
    } finally {
      cleanup();
    }
  });
});
