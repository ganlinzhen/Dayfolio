// 教学课程服务测试：导入校验（schema/路径穿越/符号链接/HTML 消毒/外部资源中和）、
// 导入顺序（资产先就位，失败不留孤儿）、幂等核验磁盘可修复、重导保留进度与已生成天、
// 既有计划绑定（不创建计划且验存在）、阅读/答题（选项越界拒绝）、样课确认版本绑定、
// 生成请求队列（创建≠执行、完整包不绕过确认、complete 核哈希与完整天数）、批准过期拒绝。
// 全部临时库+临时 staging，无网络。
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sanitizeCssText, sanitizeLessonHtml, validateCourseManifest } from '../src/services/course';
import { mkCore } from './helpers';

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((f) => f());
  cleanups.length = 0;
});

const DEFAULT_HTML = `<h1>Day 1</h1><p>安全正文</p><script>alert(1)</script><a href="javascript:evil()">x</a><img src="x" onerror="hack()">`;
const DEFAULT_OVERVIEW = '<h1>课程路线</h1><p>独立课程总览</p><script>alert(1)</script>';

const mkPkg = (dir: string, over: { slug?: string; version?: string; html?: string; sample?: boolean; plan_id?: number | null } = {}) => {
  mkdirSync(join(dir, 'lessons'), { recursive: true });
  const html = over.html ?? DEFAULT_HTML;
  writeFileSync(join(dir, 'lessons', 'd1.html'), html);
  writeFileSync(join(dir, 'overview.html'), DEFAULT_OVERVIEW);
  const manifest = {
    schema_version: 2,
    slug: over.slug ?? 'test-course',
    title: '测试课程',
    version: over.version ?? '1.0.0',
    goal: '学会测试',
    plan_id: over.plan_id ?? undefined,
    overview: { html: 'overview.html' },
    lessons: [
      {
        day: 1,
        title: '第一天',
        html: 'lessons/d1.html',
        is_sample: over.sample ?? true,
        estimated_minutes: 30,
        concepts: [{ name: '概念A', explanation: '解释' }],
        code_refs: [{ path: 'src/a.ts', symbol: 'fnA', role: '入口' }],
        quiz: [
          { question: '1+1=?', options: ['1', '2'], answer_index: 1, explanation: '算术' },
          { question: '概念A 是什么', options: ['A', 'B'], answer_index: 0, explanation: '见正文' },
        ],
      },
    ],
  };
  writeFileSync(join(dir, 'course.json'), JSON.stringify(manifest));
  return dir;
};

/** 多天完整包（day1 样课内容与 DEFAULT_HTML 消毒后逐字节一致，确保哈希不漂移） */
const mkFullPkg = (dir: string, over: { slug?: string; version?: string; days?: number[]; d1Html?: string; plan_id?: number } = {}) => {
  const slug = over.slug ?? 'test-course';
  const days = over.days ?? [1, 2, 3];
  mkdirSync(join(dir, 'lessons'), { recursive: true });
  writeFileSync(join(dir, 'lessons', 'd1.html'), over.d1Html ?? DEFAULT_HTML);
  writeFileSync(join(dir, 'overview.html'), DEFAULT_OVERVIEW);
  for (const d of days.filter((x) => x !== 1)) writeFileSync(join(dir, 'lessons', `d${d}.html`), `<h1>Day ${d}</h1>`);
  writeFileSync(join(dir, 'course.json'), JSON.stringify({
    schema_version: 2,
    slug, title: '测试课程', version: over.version ?? '1.1.0', plan_id: over.plan_id ?? undefined,
    overview: { html: 'overview.html' },
    lessons: days.map((d) => ({ day: d, title: `第${d}天`, html: `lessons/d${d}.html`, is_sample: d === 1 })),
  }));
  return dir;
};

const mkStage = () => {
  const s = mkdtempSync(join(tmpdir(), 'td-course-'));
  cleanups.push(() => rmSync(s, { recursive: true, force: true }));
  return s;
};

/** 用户在 App 的确认路径：先阅读（自动置已读）再确认——core 侧同样强制已读门槛 */
const readAndConfirm = (core: ReturnType<typeof mkCore>['core'], courseId: number) => {
  core.courses.markLessonRead(courseId, 1);
  return core.courses.confirmSample(courseId);
};

describe('manifest 校验与 HTML 消毒', () => {
  it('schema：slug/版本/day 重复/quiz 越界/不安全路径拒绝', () => {
    expect(() => validateCourseManifest({ slug: 'Bad Slug' })).toThrow('slug');
    expect(() => validateCourseManifest({ slug: 'ok', title: 'T', version: 'x', lessons: [] })).toThrow('version');
    expect(() => validateCourseManifest({ slug: 'ok', title: 'T', version: '1.0.0', lessons: [{ day: 1, title: 'a', html: '../escape.html' }] })).toThrow('不安全');
    expect(() => validateCourseManifest({ slug: 'ok', title: 'T', version: '1.0.0', lessons: [{ day: 1, title: 'a', html: 'a.html' }, { day: 1, title: 'b', html: 'b.html' }] })).toThrow('重复');
    expect(() => validateCourseManifest({ slug: 'ok', title: 'T', version: '1.0.0', lessons: [{ day: 1, title: 'a', html: 'a.html', quiz: [{ question: 'q', options: ['a', 'b'], answer_index: 5 }] }] })).toThrow('越界');
    expect(() => validateCourseManifest({ schema_version: 2, slug: 'ok', title: 'T', version: '1.0.0', lessons: [{ day: 1, title: 'a', html: 'a.html', is_sample: true }] })).toThrow('必须单独提供');
  });

  it('消毒：script/iframe/on*=/javascript: 全剥；正常标签保留', () => {
    const out = sanitizeLessonHtml(`<p>ok</p><script>alert(1)</script><iframe src="x"></iframe><a href="javascript:e()">a</a><img onerror="h()" src="ok.png"><b>粗体</b>`);
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('onerror');
    expect(out).toContain('<p>ok</p>');
    expect(out).toContain('<b>粗体</b>');
  });

  it('消毒：外部资源中和——http/https/协议相对 src 置 #，srcset 删除；相对路径保留', () => {
    const out = sanitizeLessonHtml(`<img src="https://evil.com/a.png"><img src="http://evil.com/b.png"><img src="//evil.com/c.png"><img srcset="https://evil.com/d.png 2x"><img src="local.png"><video src="https://cdn.example.net/v.mp4"></video>`);
    expect(out).not.toContain('evil.com');
    expect(out).not.toContain('srcset');
    expect(out).not.toContain('cdn.example.net');
    expect(out).toContain('src="local.png"');
    expect(out.match(/src="#"/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

describe('课程样式内联（包内 .css → 消毒 <style>，讲义保持离线自包含）', () => {
  const mkStyledPkg = (dir: string, css: string) => {
    mkdirSync(join(dir, 'lessons'), { recursive: true });
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'assets', 'style.css'), css);
    writeFileSync(join(dir, 'lessons', 'd1.html'), '<h1>Day 1</h1><link rel="stylesheet" href="../assets/style.css"><p>样式正文</p>');
    writeFileSync(join(dir, 'course.json'), JSON.stringify({
      slug: 'styled-course', title: '样式课程', version: '1.0.0',
      lessons: [{ day: 1, title: '第一天', html: 'lessons/d1.html', is_sample: true }],
    }));
    return dir;
  };

  it('包内相对样式内联为 <style>：课程排版保留、link 不残留、重导幂等', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const s = mkStage();
    mkStyledPkg(s, ':root{--ink:#1f2733}\n.lesson-banner{background:linear-gradient(135deg,#10254d,#1a56db);color:#fff}');
    const r = ctx.core.courses.importCourse(s);
    const html = ctx.core.courses.readLessonHtml(r.lessons[0]);
    expect(html).not.toContain('<link');
    expect(html).toContain('<style>/* 内联自课程包 assets/style.css');
    expect(html).toContain('--ink:#1f2733');
    expect(html).toContain('.lesson-banner');
    // 幂等：哈希在内联后计算，同包重导无变更
    expect(ctx.core.courses.importCourse(s).idempotent).toBe(true);
  });

  it('CSS 消毒：@import 删除；外部/协议相对/绝对/data: url() 中和；相对 url() 保留', () => {
    const css = [
      '@import url("https://evil.com/a.css");',
      'body{background:url(https://evil.com/x.png)}',
      'a{background:url("//evil.com/y.png")}',
      'b{background:url(data:text/html,xx)}',
      'i{background:url(/abs.png)}',
      'u{background:url(img/rel.png)}',
    ].join('\n');
    const out = sanitizeCssText(css);
    expect(out).not.toContain('evil.com');
    expect(out).not.toContain('@import');
    expect(out).not.toContain('data:text/html');
    expect(out).not.toContain('url(/abs.png)');
    expect(out).toContain('url(img/rel.png)');
    expect((out.match(/url\(#\)/g) ?? []).length).toBe(4);
  });

  it('样式里夹带的 @import 与外部引用在导入产物中被移除', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const s = mkStage();
    mkStyledPkg(s, '@import "https://evil.com/x.css";\n.banner{background:url(https://evil.com/b.png)}');
    const r = ctx.core.courses.importCourse(s);
    const html = ctx.core.courses.readLessonHtml(r.lessons[0]);
    expect(html).not.toContain('evil.com');
    expect(html).not.toMatch(/@import\s+(?:url\(|["'])/); // 真实 @import 语句已移除（内联标记注释除外）
  });

  it('外部/协议相对/非样式 link：不内联且被剥除，导入成功', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const s = mkStage();
    mkdirSync(join(s, 'lessons'), { recursive: true });
    writeFileSync(join(s, 'lessons', 'd1.html'), '<h1>Day 1</h1><link rel="stylesheet" href="https://evil.com/x.css"><link rel="stylesheet" href="//evil.com/y.css"><link rel="icon" href="favicon.png"><p>正文</p>');
    writeFileSync(join(s, 'course.json'), JSON.stringify({
      slug: 'ext-link-course', title: '外链课程', version: '1.0.0',
      lessons: [{ day: 1, title: '第一天', html: 'lessons/d1.html', is_sample: true }],
    }));
    const r = ctx.core.courses.importCourse(s);
    const html = ctx.core.courses.readLessonHtml(r.lessons[0]);
    expect(html).not.toContain('<link');
    expect(html).not.toContain('evil.com');
    expect(html).toContain('正文');
  });

  it('link 解析越出包外或指向符号链接：不内联、包外内容绝不落库，导入仍成功', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const outside = mkdtempSync(join(tmpdir(), 'td-course-css-out-'));
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, 'secret.css'), 'body{display:none}');
    const s = mkStage();
    mkdirSync(join(s, 'lessons'), { recursive: true });
    mkdirSync(join(s, 'assets'), { recursive: true });
    // ../../secret.css 越出包根；assets/style.css 是指向包外文件的符号链接
    writeFileSync(join(s, 'lessons', 'd1.html'), '<h1>Day 1</h1><link rel="stylesheet" href="../../secret.css"><link rel="stylesheet" href="../assets/style.css"><p>正文</p>');
    symlinkSync(join(outside, 'secret.css'), join(s, 'assets', 'style.css'));
    writeFileSync(join(s, 'course.json'), JSON.stringify({
      slug: 'escape-css-course', title: '越界样式课程', version: '1.0.0',
      lessons: [{ day: 1, title: '第一天', html: 'lessons/d1.html', is_sample: true }],
    }));
    const r = ctx.core.courses.importCourse(s);
    const html = ctx.core.courses.readLessonHtml(r.lessons[0]);
    expect(html).not.toContain('<link');
    expect(html).not.toContain('display:none');
    expect(html).toContain('正文');
  });
});

describe('课程导入与阅读', () => {
  it('总览独立于 D1：消毒后可单独读取，不计入每日讲义，重导可更新总览而保留样课进度', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const stage = mkStage();
    mkPkg(stage);
    const first = ctx.core.courses.importCourse(stage);
    const overview = ctx.core.courses.getOverview(first.course.id);
    expect(overview).not.toBeNull();
    expect(ctx.core.courses.readOverviewHtml(overview!)).toContain('独立课程总览');
    expect(ctx.core.courses.readOverviewHtml(overview!)).not.toContain('<script');
    expect(ctx.core.courses.listLessons(first.course.id).map((l) => l.day)).toEqual([1]);
    readAndConfirm(ctx.core, first.course.id);
    writeFileSync(join(stage, 'overview.html'), '<h1>新版总览</h1>');
    const updated = ctx.core.courses.importCourse(stage);
    expect(updated.idempotent).toBe(false);
    expect(updated.confirmation_expired).toBe(false);
    expect(updated.course.status).toBe('sample_confirmed');
    expect(updated.lessons[0].status).toBe('read');
    expect(ctx.core.courses.readOverviewHtml(ctx.core.courses.getOverview(first.course.id)!)).toContain('新版总览');
    expect(ctx.core.courses.importCourse(stage).idempotent).toBe(true);
  });

  it('旧课程缺少总览时不从 D1 伪造；新总览与 D1 共用文件会被拒绝', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const stage = mkStage();
    mkPkg(stage);
    const manifest = JSON.parse(readFileSync(join(stage, 'course.json'), 'utf8'));
    delete manifest.overview;
    delete manifest.schema_version; // 旧包无版本号仍可导入，不自动伪造总览
    writeFileSync(join(stage, 'course.json'), JSON.stringify(manifest));
    const legacy = ctx.core.courses.importCourse(stage);
    expect(ctx.core.courses.getOverview(legacy.course.id)).toBeNull();
    manifest.overview = { html: 'lessons/d1.html' };
    writeFileSync(join(stage, 'course.json'), JSON.stringify(manifest));
    expect(() => ctx.core.courses.importCourse(stage)).toThrow('不能共用');
  });

  it('独立总览文件丢失后同包重导可修复；已有总览的完整包不能漏带总览', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const stage = mkStage();
    mkPkg(stage);
    const first = ctx.core.courses.importCourse(stage);
    const overview = ctx.core.courses.getOverview(first.course.id)!;
    rmSync(join(ctx.dbPath, '..', 'courses', overview.html_rel));
    expect(ctx.core.courses.importCourse(stage).idempotent).toBe(false);
    expect(ctx.core.courses.readOverviewHtml(overview)).toContain('独立课程总览');

    readAndConfirm(ctx.core, first.course.id);
    const req = ctx.core.courses.createGenerationRequest(first.course.id);
    ctx.core.courses.claimRequest(req.id, 'agent');
    const full = mkStage();
    mkFullPkg(full);
    const manifest = JSON.parse(readFileSync(join(full, 'course.json'), 'utf8'));
    delete manifest.overview;
    delete manifest.schema_version; // 先通过旧包兼容校验，再验证已有总览不能在完整包中丢失
    writeFileSync(join(full, 'course.json'), JSON.stringify(manifest));
    expect(() => ctx.core.courses.importCourse(full)).toThrow('完整包缺少独立课程总览');
  });

  it('课程总览路径为符号链接时拒绝导入', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const stage = mkStage();
    mkPkg(stage);
    rmSync(join(stage, 'overview.html'));
    symlinkSync(join(stage, 'lessons', 'd1.html'), join(stage, 'overview.html'));
    expect(() => ctx.core.courses.importCourse(stage)).toThrow('符号链接');
    expect(ctx.core.courses.listCourses()).toHaveLength(0);
  });

  it('导入：资产落应用数据课程目录、讲义已消毒、既有计划绑定只引用不创建', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const plan = ctx.core.plans.create({ title: '既有计划', start_date: '2026-10-10', items: [{ date: '2026-10-10', content: '任务' }] });
    const plansBefore = ctx.core.plans.list().length;

    const stage = mkStage();
    mkPkg(stage, { plan_id: plan.id });

    const r = ctx.core.courses.importCourse(stage);
    expect(r.idempotent).toBe(false);
    expect(r.course.slug).toBe('test-course');
    expect(r.course.plan_id).toBe(plan.id);
    expect(ctx.core.plans.list()).toHaveLength(plansBefore); // 绝不创建新计划
    expect(r.lessons[0].is_sample).toBe(true);
    expect(r.lessons[0].quiz).toHaveLength(2);
    expect(r.lessons[0].code_refs[0]).toMatchObject({ path: 'src/a.ts', symbol: 'fnA' });
    // 资产目录在 dirname(db)/courses/ 且内容已消毒
    const html = ctx.core.courses.readLessonHtml(r.lessons[0]);
    expect(html).not.toContain('<script');
    expect(html).toContain('安全正文');
    // 原进度保留：计划打卡不受影响
    expect(ctx.core.plans.get(plan.id).items).toHaveLength(1);
  });

  it('已有未绑定课程同版本重导时可补绑计划，并保留样课确认与阅读进度', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const plan = ctx.core.plans.create({ title: '后创建的计划', start_date: '2026-10-10', items: [{ date: '2026-10-10', content: '学习样课' }] });
    const stage = mkStage();
    mkPkg(stage);
    const first = ctx.core.courses.importCourse(stage);
    readAndConfirm(ctx.core, first.course.id);

    mkPkg(stage, { plan_id: plan.id });
    const linked = ctx.core.courses.importCourse(stage);
    expect(linked.idempotent).toBe(false);
    expect(linked.course.plan_id).toBe(plan.id);
    expect(linked.course.status).toBe('sample_confirmed');
    expect(linked.course.sample_confirmed_at).not.toBeNull();
    expect(linked.lessons[0].status).toBe('read');
    expect(ctx.core.plans.list()).toHaveLength(1);
    expect(ctx.core.courses.importCourse(stage).idempotent).toBe(true);
  });

  it('plan_id 不存在：导入拒绝（只能绑定既有计划）', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const stage = mkStage();
    mkPkg(stage, { plan_id: 999 });
    expect(() => ctx.core.courses.importCourse(stage)).toThrow('plan_id 999 不存在');
    expect(ctx.core.courses.listCourses()).toHaveLength(0);
  });

  it('导入失败不留孤儿：资产目录不可写 → 抛错且库中无课程行（资产先于库写入）', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const stage = mkStage();
    mkPkg(stage);
    // 把 courses 根占位为普通文件：资产暂存必失败
    writeFileSync(join(ctx.dbPath, '..', 'courses'), 'not a dir');
    cleanups.push(() => rmSync(join(ctx.dbPath, '..', 'courses'), { force: true }));
    expect(() => ctx.core.courses.importCourse(stage)).toThrow();
    expect(ctx.core.courses.listCourses()).toHaveLength(0); // 库无孤儿行
  });

  it('staging 拷贝中途失败：抛错且无 .staging-* 残留、库无课程行', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const stage = mkStage();
    mkPkg(stage);
    // 包内放一个不可读的额外资源（不在 manifest 内）：目录递归拷贝进行到一半失败
    const unreadable = join(stage, 'lessons', 'unreadable.png');
    writeFileSync(unreadable, 'x');
    chmodSync(unreadable, 0o000);
    cleanups.push(() => { try { chmodSync(unreadable, 0o644); } catch { /* 已清理 */ } });
    expect(() => ctx.core.courses.importCourse(stage)).toThrow();
    const coursesRoot = join(ctx.dbPath, '..', 'courses');
    const residue = existsSync(coursesRoot) ? readdirSync(coursesRoot).filter((n) => n.startsWith('.staging-')) : [];
    expect(residue).toEqual([]); // 半成品暂存目录必须被清理
    expect(ctx.core.courses.listCourses()).toHaveLength(0);
  });

  it('幂等核验磁盘：资产被删后重导同包 → 非幂等且自动修复文件', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const stage = mkStage();
    mkPkg(stage);
    const r1 = ctx.core.courses.importCourse(stage);
    expect(ctx.core.courses.importCourse(stage).idempotent).toBe(true); // 正常幂等
    rmSync(join(ctx.dbPath, '..', 'courses'), { recursive: true, force: true }); // 磁盘资产丢失
    const r2 = ctx.core.courses.importCourse(stage);
    expect(r2.idempotent).toBe(false); // 同哈希但缺文件 ≠ 幂等
    expect(() => ctx.core.courses.readLessonHtml(r2.lessons[0])).not.toThrow(); // 已修复
  });

  it('重复导入幂等；样课变更 → 确认过期', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const s1 = mkStage();
    mkPkg(s1);
    const r1 = ctx.core.courses.importCourse(s1);
    const r2 = ctx.core.courses.importCourse(s1); // 同包重导
    expect(r2.idempotent).toBe(true);

    // 确认样课 → 变更样课重导 → 确认过期
    const confirmed = readAndConfirm(ctx.core, r1.course.id);
    expect(confirmed.status).toBe('sample_confirmed');
    expect(confirmed.sample_content_hash).toBeTruthy();
    // 幂等确认
    expect(ctx.core.courses.confirmSample(r1.course.id).sample_confirmed_at).toBe(confirmed.sample_confirmed_at);

    const s2 = mkStage();
    mkPkg(s2, { html: '<h1>Day 1 v2</h1><p>内容变了</p>' });
    const r3 = ctx.core.courses.importCourse(s2);
    expect(r3.confirmation_expired).toBe(true);
    expect(ctx.core.courses.getCourse(r1.course.id).sample_confirmed_at).toBeNull(); // 过期
  });

  it('重导保留进度：同哈希升版保留已读与答题；内容变更则重置', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const s1 = mkStage();
    mkPkg(s1, { version: '1.0.0' });
    const r1 = ctx.core.courses.importCourse(s1);
    ctx.core.courses.markLessonRead(r1.course.id, 1);
    ctx.core.courses.submitQuiz(r1.course.id, 1, [{ question_id: 'q1', picked: 1 }, { question_id: 'q2', picked: 0 }]);

    // 同内容升版本：已读与答题保留
    const s2 = mkStage();
    mkPkg(s2, { version: '1.0.1' });
    const r2 = ctx.core.courses.importCourse(s2);
    expect(r2.idempotent).toBe(false);
    expect(r2.lessons[0].status).toBe('read');
    expect(r2.lessons[0].quiz_answers).toHaveLength(2);

    // 内容变更：进度重置（答案与新题目可能不对应）
    const s3 = mkStage();
    mkPkg(s3, { version: '1.0.2', html: '<h1>Day 1 重写</h1>' });
    const r3 = ctx.core.courses.importCourse(s3);
    expect(r3.lessons[0].status).toBe('generated');
    expect(r3.lessons[0].quiz_answers).toHaveLength(0);
  });

  it('样课包重导不删已生成天：完整版就绪后重导样课 → 其他天原样保留', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const s1 = mkStage();
    mkPkg(s1);
    const r1 = ctx.core.courses.importCourse(s1);
    readAndConfirm(ctx.core, r1.course.id);
    const req = ctx.core.courses.createGenerationRequest(r1.course.id, 'app');
    ctx.core.courses.claimRequest(req.id, 'agent-a');
    const full = mkStage();
    mkFullPkg(full);
    ctx.core.courses.importCourse(full);
    expect(ctx.core.courses.completeRequest(req.id, 'agent-a').status).toBe('done');

    // 重导样课包（内容不变、版本不变）：样课天更新，day2/3 保留——库行与磁盘文件都在
    const again = ctx.core.courses.importCourse(s1);
    expect(again.lessons).toHaveLength(3);
    expect(again.lessons.map((l) => l.day)).toEqual([1, 2, 3]);
    for (const l of again.lessons) expect(() => ctx.core.courses.readLessonHtml(l)).not.toThrow();

    // 重导内容变更的样课包：确认过期提示，day2/3 仍保留（含磁盘文件，不得被整目录换入误删）
    const s2 = mkStage();
    mkPkg(s2, { html: '<h1>样课改版</h1>', version: '1.2.0' });
    const r3 = ctx.core.courses.importCourse(s2);
    expect(r3.confirmation_expired).toBe(true);
    expect(r3.lessons).toHaveLength(3);
    expect(r3.lessons.find((l) => l.day === 3)?.title).toBe('第3天');
    for (const l of r3.lessons) expect(() => ctx.core.courses.readLessonHtml(l)).not.toThrow();
    expect(ctx.core.courses.readLessonHtml(r3.lessons[0])).toContain('样课改版'); // 样课天已更新为新版
  });

  it('生成请求队列：未确认拒绝；确认后创建/认领/哈希校验/完整包后完成', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const s1 = mkStage();
    mkPkg(s1);
    const r1 = ctx.core.courses.importCourse(s1);
    const cid = r1.course.id;

    // 未确认 → 拒绝
    expect(() => ctx.core.courses.createGenerationRequest(cid, 'test')).toThrow('样课尚未确认');
    readAndConfirm(ctx.core, cid);
    const req = ctx.core.courses.createGenerationRequest(cid, 'app');
    expect(req.status).toBe('pending');
    expect(ctx.core.courses.createGenerationRequest(cid, 'app').id).toBe(req.id); // 幂等

    // 认领（agent）
    const claimed = ctx.core.courses.claimRequest(req.id, 'agent-a');
    expect(claimed.status).toBe('claimed');
    expect(ctx.core.courses.claimRequest(req.id, 'agent-a').claimed_by).toBe('agent-a'); // 幂等
    expect(() => ctx.core.courses.claimRequest(req.id, 'agent-b')).toThrow('不能认领');

    // 未导入完整包就 complete → 拒绝
    expect(() => ctx.core.courses.completeRequest(req.id, 'agent-a')).toThrow('完整版未导入');
    // 完整包（day1 样课与已确认样课内容逐字节一致 + day2~3）
    const full = mkStage();
    mkFullPkg(full);
    const rFull = ctx.core.courses.importCourse(full);
    expect(rFull.lessons).toHaveLength(3);
    // 完整包含同内容样课 → 确认不过期（hash 一致）

    const done = ctx.core.courses.completeRequest(req.id, 'agent-a');
    expect(done.status).toBe('done');
    expect(ctx.core.courses.getCourse(cid).status).toBe('complete');
    expect(ctx.core.courses.completeRequest(req.id, 'agent-a').status).toBe('done'); // 幂等
  });

  it('完整包不绕过确认与请求：无认领请求直接导入完整包 → 拒绝', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const s1 = mkStage();
    mkPkg(s1);
    const r1 = ctx.core.courses.importCourse(s1);
    readAndConfirm(ctx.core, r1.course.id);

    // 未创建请求 → 完整包导入被拒
    const full = mkStage();
    mkFullPkg(full);
    expect(() => ctx.core.courses.importCourse(full)).toThrow('完整包导入被拒');
    expect(ctx.core.courses.listLessons(r1.course.id)).toHaveLength(1); // 未被部分写入

    // 仅有 pending（未认领）→ 仍拒绝
    const req = ctx.core.courses.createGenerationRequest(r1.course.id, 'app');
    expect(() => ctx.core.courses.importCourse(full)).toThrow('完整包导入被拒');

    // 认领后放行
    ctx.core.courses.claimRequest(req.id, 'agent-a');
    const ok = ctx.core.courses.importCourse(full);
    expect(ok.lessons).toHaveLength(3);
  });

  it('首导完整包拒绝：全新课程必须从样课包开始（带/不带样课标记均拒）', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    // 带样课标记的完整包
    const withSample = mkStage();
    mkFullPkg(withSample, { slug: 'brand-new-a', version: '1.0.0' });
    expect(() => ctx.core.courses.importCourse(withSample)).toThrow('完整包导入被拒');
    expect(() => ctx.core.courses.importCourse(withSample)).toThrow('样课包');
    // 不带样课标记的完整包（manifest 层即拒绝：恰好一个样课规则）
    const noSample = mkStage();
    mkdirSync(join(noSample, 'lessons'), { recursive: true });
    writeFileSync(join(noSample, 'lessons', 'd1.html'), '<h1>无样课 1</h1>');
    writeFileSync(join(noSample, 'lessons', 'd2.html'), '<h1>无样课 2</h1>');
    writeFileSync(join(noSample, 'course.json'), JSON.stringify({
      slug: 'brand-new-b', title: '无样课完整包', version: '1.0.0',
      lessons: [{ day: 1, title: '一', html: 'lessons/d1.html' }, { day: 2, title: '二', html: 'lessons/d2.html' }],
    }));
    expect(() => ctx.core.courses.importCourse(noSample)).toThrow('样课');
    expect(ctx.core.courses.listCourses()).toHaveLength(0);
  });

  it('样课确认须已读：未阅读直接确认 → 拒绝；阅读后确认通过', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const s1 = mkStage();
    mkPkg(s1);
    const r1 = ctx.core.courses.importCourse(s1);
    expect(() => ctx.core.courses.confirmSample(r1.course.id)).toThrow('样课尚未阅读');
    expect(ctx.core.courses.getCourse(r1.course.id).sample_confirmed_at).toBeNull();
    ctx.core.courses.markLessonRead(r1.course.id, 1);
    expect(ctx.core.courses.confirmSample(r1.course.id).status).toBe('sample_confirmed');
  });

  it('complete 核计划天数：五天计划只导两天不得 complete，补齐 1..5 天后通过', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const plan = ctx.core.plans.create({
      title: '五天计划', start_date: '2026-10-10',
      items: [0, 1, 2, 3, 4].map((i) => ({ date: `2026-10-1${i}`, content: `第${i + 1}天任务` })),
    });
    const s1 = mkStage();
    mkPkg(s1, { plan_id: plan.id });
    const r1 = ctx.core.courses.importCourse(s1);
    readAndConfirm(ctx.core, r1.course.id);
    const req = ctx.core.courses.createGenerationRequest(r1.course.id, 'app');
    ctx.core.courses.claimRequest(req.id, 'agent-a');

    // 只导第 1..2 天 → complete 拒绝（计划共 5 天）
    const two = mkStage();
    mkFullPkg(two, { version: '1.1.0', days: [1, 2] });
    ctx.core.courses.importCourse(two);
    expect(() => ctx.core.courses.completeRequest(req.id, 'agent-a')).toThrow('完整版天数不完整');

    // 补齐第 1..5 天 → complete 通过
    const five = mkStage();
    mkFullPkg(five, { version: '1.2.0', days: [1, 2, 3, 4, 5] });
    ctx.core.courses.importCourse(five);
    expect(ctx.core.courses.completeRequest(req.id, 'agent-a').status).toBe('done');
    expect(ctx.core.courses.getCourse(r1.course.id).status).toBe('complete');
  });

  it('样课重导合并失败一致性：拷贝或落位任一阶段失败 → 库与磁盘都回导入前，无半更新残留', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    // 包内多带一个资源文件（style.css）：合并计划含 D1、独立总览和样式，
    // 故障 B 让 D1/总览先落位、style.css 再失败——必须把已落位的文件恢复成旧内容
    const s1 = mkStage();
    mkPkg(s1);
    writeFileSync(join(s1, 'style.css'), 'body{color:#1a1a19}');
    const r1 = ctx.core.courses.importCourse(s1);
    readAndConfirm(ctx.core, r1.course.id);
    const req = ctx.core.courses.createGenerationRequest(r1.course.id, 'app');
    ctx.core.courses.claimRequest(req.id, 'agent-a');
    const full = mkStage();
    mkFullPkg(full);
    writeFileSync(join(full, 'style.css'), 'body{color:#1a1a19}');
    ctx.core.courses.importCourse(full);
    ctx.core.courses.completeRequest(req.id, 'agent-a');

    const cid = r1.course.id;
    const lessonsDir = join(ctx.dbPath, '..', 'courses', 'test-course', 'lessons');
    const d1 = join(lessonsDir, 'd1.html');
    const htmlBefore = readFileSync(d1, 'utf8');
    const overviewBefore = ctx.core.courses.getOverview(cid)!;
    const overviewHtmlBefore = ctx.core.courses.readOverviewHtml(overviewBefore);
    const cssPath = join(ctx.dbPath, '..', 'courses', 'test-course', 'style.css');
    const cssBefore = readFileSync(cssPath, 'utf8');

    // 故障 A（阶段 1 拷贝失败）：目标 lessons 目录只读 → 合并抛错
    chmodSync(lessonsDir, 0o555);
    const s2 = mkStage();
    mkPkg(s2, { html: '<h1>改版样课A</h1>', version: '2.0.0' });
    writeFileSync(join(s2, 'style.css'), 'body{color:#f00}');
    let threwA = false;
    try { ctx.core.courses.importCourse(s2); } catch { threwA = true; }
    chmodSync(lessonsDir, 0o755);
    expect(threwA).toBe(true);
    // 库回滚：3 天、状态/讲义原样
    expect(ctx.core.courses.listLessons(cid).map((l) => l.day)).toEqual([1, 2, 3]);
    expect(ctx.core.courses.getCourse(cid).status).toBe('complete');
    // 磁盘一致：d1 仍旧内容、无 .merge-* 残留
    expect(readFileSync(d1, 'utf8')).toBe(htmlBefore);
    for (const n of readdirSync(lessonsDir)) expect(n.startsWith('.merge-')).toBe(false);

    // 故障 B（阶段 2 落位失败）：在第三个文件（style.css）的备份名位置预置非空目录
    // → D1/总览已落位后，style.css 落位失败 → 回滚必须把 D1 恢复成旧内容
    const blocker = join(ctx.dbPath, '..', 'courses', 'test-course', '.merge-bak-2-style.css');
    mkdirSync(blocker, { recursive: true });
    writeFileSync(join(blocker, 'block'), 'x');
    const s3 = mkStage();
    mkPkg(s3, { html: '<h1>改版样课B</h1>', version: '2.1.0' });
    writeFileSync(join(s3, 'overview.html'), '<h1>失败时不应留下的新总览</h1>');
    writeFileSync(join(s3, 'style.css'), 'body{color:#00f}');
    let threwB = false;
    try { ctx.core.courses.importCourse(s3); } catch { threwB = true; }
    expect(threwB).toBe(true);
    expect(ctx.core.courses.listLessons(cid).map((l) => l.day)).toEqual([1, 2, 3]);
    expect(readFileSync(d1, 'utf8')).toBe(htmlBefore); // 已落位的 d1 被恢复为旧内容（关键断言）
    expect(ctx.core.courses.getOverview(cid)).toEqual(overviewBefore);
    expect(ctx.core.courses.readOverviewHtml(overviewBefore)).toBe(overviewHtmlBefore);
    expect(readFileSync(cssPath, 'utf8')).toBe(cssBefore); // 未落位的 style.css 原样
    expect(existsSync(join(lessonsDir, 'd2.html'))).toBe(true);
    expect(existsSync(join(lessonsDir, 'd3.html'))).toBe(true);
    const residue: string[] = [];
    for (const n of readdirSync(lessonsDir)) if (n.startsWith('.merge-')) residue.push(`lessons/${n}`);
    const courseRoot = join(ctx.dbPath, '..', 'courses', 'test-course');
    for (const n of readdirSync(courseRoot)) if (n.startsWith('.merge-') && n !== '.merge-bak-2-style.css') residue.push(n);
    expect(residue).toEqual([]); // 除测试预置的障碍外，无 .merge-* 残留
    rmSync(blocker, { recursive: true, force: true });

    // 障碍清除后重导成功：一致性修复路径可用
    const s4 = mkStage();
    mkPkg(s4, { html: '<h1>改版样课C</h1>', version: '2.2.0' });
    writeFileSync(join(s4, 'style.css'), 'body{color:#0f0}');
    const ok = ctx.core.courses.importCourse(s4);
    expect(ok.lessons).toHaveLength(3);
    expect(readFileSync(d1, 'utf8')).toContain('改版样课C');
    expect(readFileSync(cssPath, 'utf8')).toContain('#0f0');
  });

  it('complete 严格校验：天数缺口拒绝；样课确认过期拒绝', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const s1 = mkStage();
    mkPkg(s1);
    const r1 = ctx.core.courses.importCourse(s1);
    readAndConfirm(ctx.core, r1.course.id);
    const req = ctx.core.courses.createGenerationRequest(r1.course.id, 'app');
    ctx.core.courses.claimRequest(req.id, 'agent-a');

    // 缺 day2 的「完整包」→ 导入可过（天数字段合法），complete 拒绝
    const gap = mkStage();
    mkFullPkg(gap, { days: [1, 3] });
    ctx.core.courses.importCourse(gap);
    expect(() => ctx.core.courses.completeRequest(req.id, 'agent-a')).toThrow('天数不完整');

    // 样课在 complete 前被变更重导 → 确认过期 → complete 拒绝
    const s2 = mkStage();
    mkPkg(s2, { html: '<h1>样课被换掉</h1>' });
    ctx.core.courses.importCourse(s2);
    expect(() => ctx.core.courses.completeRequest(req.id, 'agent-a')).toThrow('确认已过期');
  });

  it('批准过期：确认后样课变更 → pending/claimed 请求拒绝执行', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const s1 = mkStage();
    mkPkg(s1);
    const r1 = ctx.core.courses.importCourse(s1);
    readAndConfirm(ctx.core, r1.course.id);
    const req = ctx.core.courses.createGenerationRequest(r1.course.id, 'test');

    // 变更样课重导 → 确认过期 → 认领被拒（failed）
    const s2 = mkStage();
    mkPkg(s2, { html: '<h1>改了样课</h1>' });
    ctx.core.courses.importCourse(s2);
    expect(() => ctx.core.courses.claimRequest(req.id, 'agent')).toThrow('确认过期');
    expect(ctx.core.courses.listRequests({ course_id: r1.course.id })[0].status).toBe('failed');
  });

  it('阅读与答题：markRead/quiz 幂等覆盖、无效答案与选项越界拒绝', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const s1 = mkStage();
    mkPkg(s1);
    const r1 = ctx.core.courses.importCourse(s1);
    const cid = r1.course.id;
    expect(ctx.core.courses.getLesson(cid, 1).status).toBe('generated');
    expect(ctx.core.courses.markLessonRead(cid, 1).status).toBe('read');

    const answered = ctx.core.courses.submitQuiz(cid, 1, [{ question_id: 'q1', picked: 1 }, { question_id: 'q2', picked: 0 }]);
    expect(answered.quiz_answers).toHaveLength(2);
    expect(answered.quiz_answers.find((a) => a.question_id === 'q1')?.picked).toBe(1);
    // 重答覆盖
    const re = ctx.core.courses.submitQuiz(cid, 1, [{ question_id: 'q1', picked: 0 }]);
    expect(re.quiz_answers.find((a) => a.question_id === 'q1')?.picked).toBe(0);
    expect(re.quiz_answers.find((a) => a.question_id === 'q2')?.picked).toBe(0); // 未重答保留
    expect(() => ctx.core.courses.submitQuiz(cid, 1, [{ question_id: 'bad', picked: 0 }])).toThrow('无效');
    // 选项越界（picked 超出该题 options 长度）：单独提交拒绝；混在有效答案里被过滤
    expect(() => ctx.core.courses.submitQuiz(cid, 1, [{ question_id: 'q1', picked: 99 }])).toThrow('无效');
    const mixed = ctx.core.courses.submitQuiz(cid, 1, [{ question_id: 'q1', picked: 99 }, { question_id: 'q2', picked: 1 }]);
    expect(mixed.quiz_answers.find((a) => a.question_id === 'q2')?.picked).toBe(1);
    expect(mixed.quiz_answers.some((a) => a.picked === 99)).toBe(false);
    expect(() => ctx.core.courses.getLesson(cid, 99)).toThrow('不存在');
  });

  it('路径穿越：staging 内 html 指向包外 → 拒绝', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const s1 = mkStage();
    mkdirSync(s1, { recursive: true });
    writeFileSync(join(s1, 'course.json'), JSON.stringify({ slug: 'esc', title: 'E', version: '1.0.0', lessons: [{ day: 1, title: 'a', html: '../../../etc/passwd.html' }] }));
    expect(() => ctx.core.courses.importCourse(s1)).toThrow();
  });

  it('符号链接越界：讲义为 symlink 指向包外 → 拒绝；资源 symlink 不被拷贝', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const outside = mkdtempSync(join(tmpdir(), 'td-course-out-'));
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, 'secret.html'), '<h1>包外秘密</h1>');

    // 讲义文件本身是 symlink → 拒绝
    const s1 = mkStage();
    mkdirSync(join(s1, 'lessons'), { recursive: true });
    symlinkSync(join(outside, 'secret.html'), join(s1, 'lessons', 'd1.html'));
    writeFileSync(join(s1, 'course.json'), JSON.stringify({
      slug: 'symlink-course', title: 'S', version: '1.0.0',
      lessons: [{ day: 1, title: 'a', html: 'lessons/d1.html', is_sample: true }],
    }));
    expect(() => ctx.core.courses.importCourse(s1)).toThrow('符号链接');
    expect(ctx.core.courses.listCourses()).toHaveLength(0);

    // 资源 symlink（css 指向包外文件）→ 不拷贝，导入仍成功且无越界内容落盘
    const s2 = mkStage();
    mkPkg(s2, { slug: 'symlink-res' });
    writeFileSync(join(outside, 'evil.css'), 'body{background:url(https://evil.com/x)}');
    symlinkSync(join(outside, 'evil.css'), join(s2, 'evil.css'));
    const r2 = ctx.core.courses.importCourse(s2);
    const dest = join(ctx.dbPath, '..', 'courses', 'symlink-res', 'evil.css');
    expect(() => readFileSync(dest, 'utf8')).toThrow(); // symlink 未被拷贝
    expect(ctx.core.courses.readLessonHtml(r2.lessons[0])).toContain('安全正文'); // 正常讲义不受影响
  });
});

describe('完整包门槛加固：样课标记不可绕过/样课哈希核对/plan 绑定不可变更', () => {
  /** 无 is_sample 标记的包（days 天）：此前 every(is_sample) 空真会被误判为「样课包」 */
  const mkNoMarkerPkg = (dir: string, over: { slug?: string; version?: string; days?: number } = {}) => {
    const days = over.days ?? 2;
    mkdirSync(join(dir, 'lessons'), { recursive: true });
    for (const d of [1, 2, 3].slice(0, days)) writeFileSync(join(dir, 'lessons', `d${d}.html`), `<h1>Day ${d}</h1><p>无标记</p>`);
    writeFileSync(join(dir, 'course.json'), JSON.stringify({
      slug: over.slug ?? 'test-course', title: '无标记包', version: over.version ?? '9.9.9',
      lessons: [1, 2, 3].slice(0, days).map((d) => ({ day: d, title: `第${d}天`, html: `lessons/d${d}.html` })),
    }));
    return dir;
  };

  it('去掉 is_sample 标记不能绕过门槛：无标记包（一天/多天、首导/重导）一律拒绝', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    // 首导：一天无标记包（曾被空真判为样课包直接建课）
    const s1 = mkStage();
    mkNoMarkerPkg(s1, { slug: 'nomark-a', days: 1 });
    expect(() => ctx.core.courses.importCourse(s1)).toThrow('样课');
    // 首导：三天无标记包
    const s2 = mkStage();
    mkNoMarkerPkg(s2, { slug: 'nomark-b', days: 3 });
    expect(() => ctx.core.courses.importCourse(s2)).toThrow('样课');
    expect(ctx.core.courses.listCourses()).toHaveLength(0);

    // 重导：已有样课课程导入无标记多天包（曾在空真下绕过完整包门槛直接写入多天）
    const s3 = mkStage();
    mkPkg(s3);
    const r1 = ctx.core.courses.importCourse(s3);
    readAndConfirm(ctx.core, r1.course.id);
    const req = ctx.core.courses.createGenerationRequest(r1.course.id, 'app');
    ctx.core.courses.claimRequest(req.id, 'agent-a');
    const s4 = mkStage();
    mkNoMarkerPkg(s4, { days: 3 });
    expect(() => ctx.core.courses.importCourse(s4)).toThrow('样课');
    expect(ctx.core.courses.listLessons(r1.course.id)).toHaveLength(1); // 未被写入
  });

  it('数据异常防线：课程无样课记录（旧库残留）时完整包导入仍拒绝', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    // 直接注入一门前置加固时代的「无样课」课程行
    const raw = new DatabaseSync(ctx.dbPath);
    raw.exec(
      `INSERT INTO courses (slug, title, status, version, created_at, updated_at) VALUES ('legacy', '旧课', 'sample_confirmed', '1.0.0', '2026-01-01', '2026-01-01');
       INSERT INTO course_lessons (course_id, day, title, html_rel, content_hash, is_sample, created_at, updated_at)
       VALUES (1, 1, '旧天', 'legacy/d1.html', 'deadbeef', 0, '2026-01-01', '2026-01-01')`,
    );
    raw.close();
    const full = mkStage();
    mkFullPkg(full, { slug: 'legacy' });
    expect(() => ctx.core.courses.importCourse(full)).toThrow('样课');
  });

  it('完整包样课正文与确认哈希不一致：导入拒绝（须与用户确认版本逐字节一致）', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const s1 = mkStage();
    mkPkg(s1);
    const r1 = ctx.core.courses.importCourse(s1);
    readAndConfirm(ctx.core, r1.course.id);
    const req = ctx.core.courses.createGenerationRequest(r1.course.id, 'app');
    ctx.core.courses.claimRequest(req.id, 'agent-a');

    // 认领后导入「day1 内容被偷换」的完整包 → 拒绝；不得等到 complete 才发现
    const tampered = mkStage();
    mkFullPkg(tampered, { d1Html: '<h1>Day 1 被偷换的样课</h1>' });
    expect(() => ctx.core.courses.importCourse(tampered)).toThrow('确认');
    expect(ctx.core.courses.listLessons(r1.course.id)).toHaveLength(1); // 未被替换
    expect(ctx.core.courses.getCourse(r1.course.id).sample_confirmed_at).not.toBeNull(); // 确认未被冲掉

    // day1 与确认逐字节一致的完整包 → 放行
    const good = mkStage();
    mkFullPkg(good);
    expect(ctx.core.courses.importCourse(good).lessons).toHaveLength(3);
  });

  it('plan_id 不可改绑：样课重导与完整包导入换绑其他计划一律拒绝', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const planA = ctx.core.plans.create({ title: '计划A', start_date: '2026-10-10', items: [{ date: '2026-10-10', content: 'A' }] });
    const planB = ctx.core.plans.create({ title: '计划B', start_date: '2026-10-10', items: [{ date: '2026-10-10', content: 'B' }] });
    const s1 = mkStage();
    mkPkg(s1, { plan_id: planA.id });
    const r1 = ctx.core.courses.importCourse(s1);
    expect(r1.course.plan_id).toBe(planA.id);

    // 样课包重导（同内容升版）带 planB → 拒绝
    const s2 = mkStage();
    mkPkg(s2, { plan_id: planB.id, version: '1.0.1' });
    expect(() => ctx.core.courses.importCourse(s2)).toThrow('不可变更');
    expect(ctx.core.courses.getCourse(r1.course.id).plan_id).toBe(planA.id);

    // 完整包导入带 planB → 同样拒绝（否则短计划可掩护短包 complete）
    readAndConfirm(ctx.core, r1.course.id);
    const req = ctx.core.courses.createGenerationRequest(r1.course.id, 'app');
    ctx.core.courses.claimRequest(req.id, 'agent-a');
    const fullB = mkStage();
    mkFullPkg(fullB, { plan_id: planB.id });
    expect(() => ctx.core.courses.importCourse(fullB)).toThrow('不可变更');
    expect(ctx.core.courses.getCourse(r1.course.id).plan_id).toBe(planA.id);
  });

  it('删计划不能使短包 complete：绑定计划被删后 complete 拒绝（不退化为连续性校验）', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const plan = ctx.core.plans.create({
      title: '五天计划', start_date: '2026-10-10',
      items: [0, 1, 2, 3, 4].map((i) => ({ date: `2026-10-1${i}`, content: `第${i + 1}天` })),
    });
    const s1 = mkStage();
    mkPkg(s1, { plan_id: plan.id });
    const r1 = ctx.core.courses.importCourse(s1);
    readAndConfirm(ctx.core, r1.course.id);
    const req = ctx.core.courses.createGenerationRequest(r1.course.id, 'app');
    ctx.core.courses.claimRequest(req.id, 'agent-a');
    // 只导 1..2 天
    const two = mkStage();
    mkFullPkg(two, { days: [1, 2] });
    ctx.core.courses.importCourse(two);
    // 删除绑定计划：此前 expectedDays 归零退化为连续性校验，[1,2] 连续即可 complete —— 必须拒绝
    ctx.core.plans.remove(plan.id);
    expect(() => ctx.core.courses.completeRequest(req.id, 'agent-a')).toThrow('计划已删除');
    expect(ctx.core.courses.getCourse(r1.course.id).status).not.toBe('complete');
  });
});

describe('样课重导合并的 symlink 越界与失败回滚加固', () => {
  /** 走到「已确认+已认领」的课程并导入完整包，为样课重导（mergeAssetsIn）铺垫 */
  const setupMerged = (ctx: ReturnType<typeof mkCore>['core']) => {
    const s1 = mkStage();
    mkPkg(s1);
    const r1 = ctx.courses.importCourse(s1);
    ctx.courses.markLessonRead(r1.course.id, 1);
    ctx.courses.confirmSample(r1.course.id);
    const req = ctx.courses.createGenerationRequest(r1.course.id, 'app');
    ctx.courses.claimRequest(req.id, 'agent-a');
    const full = mkStage();
    mkFullPkg(full);
    ctx.courses.importCourse(full);
    ctx.courses.completeRequest(req.id, 'agent-a');
    return r1.course.id;
  };

  it('目标目录本身为 symlink：拒绝合并，包外目录零写入，库回滚', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const cid = setupMerged(ctx.core);
    const courseDir = join(ctx.dbPath, '..', 'courses', 'test-course');
    const outside = mkdtempSync(join(tmpdir(), 'td-merge-out-'));
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    // 把真实课程目录挪开，原位放 symlink 指向包外
    renameSync(courseDir, `${courseDir}.real`);
    cleanups.push(() => { try { renameSync(`${courseDir}.real`, courseDir); } catch { /* 已还原 */ } });
    symlinkSync(outside, courseDir);

    const s2 = mkStage();
    mkPkg(s2, { html: '<h1>改版样课</h1>', version: '2.0.0' });
    expect(() => ctx.core.courses.importCourse(s2)).toThrow('符号链接');
    // 包外目录零写入（d1 改版绝无落进 symlink 目标）
    expect(readdirSync(outside)).toEqual([]);
    // 库回滚：课程行/讲义行/状态保持导入前
    expect(ctx.core.courses.getCourse(cid).status).toBe('complete');
    expect(ctx.core.courses.listLessons(cid).map((l) => l.day)).toEqual([1, 2, 3]);
  });

  it('目标中间目录为 symlink：拒绝合并，包外目录零写入，库回滚', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const cid = setupMerged(ctx.core);
    const lessonsDir = join(ctx.dbPath, '..', 'courses', 'test-course', 'lessons');
    const outside = mkdtempSync(join(tmpdir(), 'td-merge-out-'));
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    renameSync(lessonsDir, `${lessonsDir}.real`);
    cleanups.push(() => { try { renameSync(`${lessonsDir}.real`, lessonsDir); } catch { /* 已还原 */ } });
    symlinkSync(outside, lessonsDir);

    const s2 = mkStage();
    mkPkg(s2, { html: '<h1>改版样课</h1>', version: '2.0.0' });
    expect(() => ctx.core.courses.importCourse(s2)).toThrow('符号链接');
    expect(readdirSync(outside)).toEqual([]);
    expect(ctx.core.courses.listLessons(cid).map((l) => l.day)).toEqual([1, 2, 3]);
    expect(readFileSync(join(`${lessonsDir}.real`, 'd1.html'), 'utf8')).toContain('Day 1'); // 真实文件未被改动
  });

  it('残留的 .merge-tmp 障碍（目录占位）不卡死重导：自动清理后导入成功', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const cid = setupMerged(ctx.core);
    // 预置上次崩溃可能残留的临时名目录（首文件 d1.html → .merge-tmp-0-d1.html）
    const obstacle = join(ctx.dbPath, '..', 'courses', 'test-course', 'lessons', '.merge-tmp-0-d1.html');
    mkdirSync(obstacle, { recursive: true });
    writeFileSync(join(obstacle, 'junk'), 'x');

    const s2 = mkStage();
    mkPkg(s2, { html: '<h1>改版样课</h1>', version: '2.0.0' });
    const r = ctx.core.courses.importCourse(s2);
    expect(r.lessons.map((l) => l.day)).toEqual([1, 2, 3]);
    expect(ctx.core.courses.readLessonHtml(r.lessons[0])).toContain('改版样课');
    expect(existsSync(obstacle)).toBe(false); // 障碍已被清理，未变成永久卡点
    expect(cid).toBeGreaterThan(0);
  });
});

describe('根符号链接与已完成课程重导（门槛顺序回归）', () => {
  it('staging 根自身是符号链接：导入拒绝，库无课程行，课程资产根未被创建', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const real = mkStage();
    mkPkg(real);
    // 包目录本体完好，但传入导入的路径本身是指向它的符号链接
    const linkParent = mkStage();
    const link = join(linkParent, 'pkg-link');
    symlinkSync(real, link);
    expect(() => ctx.core.courses.importCourse(link)).toThrow('符号链接');
    expect(ctx.core.courses.listCourses()).toHaveLength(0);
    // 拒绝发生在逐讲义校验阶段（早于资产暂存），课程资产根绝不被创建
    expect(existsSync(join(ctx.dbPath, '..', 'courses'))).toBe(false);
  });

  it('课程资产根自身是符号链接：导入拒绝，包外目录零写入，既有课程与磁盘文件原样', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const s1 = mkStage();
    mkPkg(s1);
    const r1 = ctx.core.courses.importCourse(s1);
    const coursesRoot = join(ctx.dbPath, '..', 'courses');
    const outside = mkdtempSync(join(tmpdir(), 'td-root-out-'));
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    // 把真实课程资产根挪开，原位放指向包外的符号链接（mkdirSync 会穿透的那一类）
    renameSync(coursesRoot, `${coursesRoot}.real`);
    cleanups.push(() => {
      try { rmSync(coursesRoot, { force: true }); } catch { /* 非链接则跳过 */ }
      try { renameSync(`${coursesRoot}.real`, coursesRoot); } catch { /* 已还原 */ }
    });
    symlinkSync(outside, coursesRoot);

    // 磁盘资产经链接不可见 → 非幂等 → 走全量暂存 → 资产根符号链接被拒
    expect(() => ctx.core.courses.importCourse(s1)).toThrow('符号链接');
    expect(readdirSync(outside)).toEqual([]); // 包外目录零写入（连 .staging-* 都没有）
    expect(ctx.core.courses.listCourses()).toHaveLength(1); // 库未被写入/破坏
    expect(ctx.core.courses.listLessons(r1.course.id).map((l) => l.day)).toEqual([1]);

    // 还原后原文件完好可读
    rmSync(coursesRoot, { force: true });
    renameSync(`${coursesRoot}.real`, coursesRoot);
    expect(() => ctx.core.courses.readLessonHtml(r1.lessons[0])).not.toThrow();
  });

  it('完成后同内容重导：幂等重试与丢文件修复不再被 claimed 门槛误拒；改内容仍须新确认+认领', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const s1 = mkStage();
    mkPkg(s1);
    const r1 = ctx.core.courses.importCourse(s1);
    readAndConfirm(ctx.core, r1.course.id);
    const req = ctx.core.courses.createGenerationRequest(r1.course.id, 'app');
    ctx.core.courses.claimRequest(req.id, 'agent-a');
    const full = mkStage();
    mkFullPkg(full);
    ctx.core.courses.importCourse(full);
    ctx.core.courses.markLessonRead(r1.course.id, 2);
    ctx.core.courses.completeRequest(req.id, 'agent-a');
    const cid = r1.course.id;

    // 1) 幂等重试：请求已 done（库中无 claimed），同版本同哈希重导必须幂等放行（此前被门槛误拒）
    const again = ctx.core.courses.importCourse(full);
    expect(again.idempotent).toBe(true);

    // 2) 丢文件修复：day2 文件被删后重导同包 → 非幂等但成功修复，进度与请求终态保留
    rmSync(join(ctx.dbPath, '..', 'courses', 'test-course', 'lessons', 'd2.html'));
    const fixed = ctx.core.courses.importCourse(full);
    expect(fixed.idempotent).toBe(false);
    const day2 = fixed.lessons.find((l) => l.day === 2)!;
    expect(day2.status).toBe('read'); // 同哈希保留已读
    expect(() => ctx.core.courses.readLessonHtml(day2)).not.toThrow(); // 文件已修复
    expect(ctx.core.courses.listRequests({ course_id: cid })[0].status).toBe('done'); // 请求未被翻动
    expect(ctx.core.courses.getCourse(cid).status).toBe('complete');

    // 3) 改内容（day3 改版升版）：无 claimed 请求 → 仍拒绝（不得借同内容通道偷运变更）
    const mod = mkStage();
    mkFullPkg(mod, { version: '1.2.0' });
    writeFileSync(join(mod, 'lessons', 'd3.html'), '<h1>Day 3 改版</h1>');
    expect(() => ctx.core.courses.importCourse(mod)).toThrow('完整包导入被拒');

    // 4) 新请求 + 认领后放行（样课未变、确认仍有效，走正常完整包通道）
    const req2 = ctx.core.courses.createGenerationRequest(cid, 'app');
    ctx.core.courses.claimRequest(req2.id, 'agent-a');
    const rmod = ctx.core.courses.importCourse(mod);
    expect(rmod.lessons).toHaveLength(3);
    expect(ctx.core.courses.readLessonHtml(rmod.lessons.find((l) => l.day === 3)!)).toContain('Day 3 改版');
  });

  it('完成前（请求仍 claimed）不改变原门槛：非同内容完整包照常走 claimed 校验', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const s1 = mkStage();
    mkPkg(s1);
    const r1 = ctx.core.courses.importCourse(s1);
    readAndConfirm(ctx.core, r1.course.id);
    const req = ctx.core.courses.createGenerationRequest(r1.course.id, 'app');
    ctx.core.courses.claimRequest(req.id, 'agent-a');
    // 课程尚未 complete：同内容判定不介入，正常认领通道照常工作
    const full = mkStage();
    mkFullPkg(full);
    expect(ctx.core.courses.importCourse(full).lessons).toHaveLength(3);
    expect(ctx.core.courses.completeRequest(req.id, 'agent-a').status).toBe('done');
  });
});

describe('旧计划缺讲义：无课程关联时展示层概念为待完善，计划数据不丢', () => {
  it('无课程关联时计划数据不丢', () => {
    const ctx = mkCore();
    cleanups.push(ctx.cleanup);
    const plan = ctx.core.plans.create({ title: '旧计划', start_date: '2026-10-10', items: [{ date: '2026-10-10', content: '旧任务' }] });
    // 无任何课程导入 → 计划原样
    expect(ctx.core.courses.listCourses()).toHaveLength(0);
    expect(ctx.core.plans.get(plan.id).title).toBe('旧计划');
  });
});

