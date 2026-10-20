// 教学课程服务（v6）：课程资产导入（staging 校验→消毒→资产先就位→再入库→原子换入）、
// 既有计划绑定（只引用不创建）、每日讲义阅读与答题、版本绑定的样课确认、
// 完整版生成请求队列（创建≠执行，外部 agent 认领处理）。
//
// 安全红线：
// 1. 路径穿越：包内 html 路径必须是安全相对路径（拒绝绝对路径/..//反斜杠），且沿途任何组件
//    不得是符号链接（symlink 越界拒绝；基准目录自身同样是符号链接时也拒绝——目录符号链接对
//    mkdirSync/existsSync/cpSync 完全透明，不查根会让写入穿透到包外/库外）；拷贝与读取均解析后前缀校验；
// 2. HTML 消毒：导入时剥 <script>/<style 内联事件>/<iframe>/<object>/<embed>/javascript: 与 data: 协议、
//    on*= 事件属性，并中和外部资源（http/https/协议相对 src、srcset）——讲义须离线自包含；
//    包内相对 .css 样式表在消毒前内联为 <style>（课程排版得以保留），@import 与外部 url() 一律移除；
//    App 侧渲染再加 iframe sandbox + CSP 双保险；
// 3. code_refs 是纯文本元数据（路径/符号/作用），任何环节不执行命令、不打开文件；
// 4. 课程资产存 dirname(db)/courses/<slug>/（应用数据推导，非 .app/桌面固定路径）；
// 5. 样课确认绑定 content_hash：样课变更 → 确认过期、生成请求拒绝执行；重复导入幂等；
// 6. 完整包（含非样课天）对已走样课流程的课程导入，必须存在已认领（claimed）的生成请求，
//    且请求哈希与当前确认一致——直接 import 不能绕过用户确认与请求队列；
//    唯一例外：课程已 complete 后的同版本同内容重导（幂等重试/丢文件修复），见 importCourse；
// 7. 导入顺序：资产先复制到暂存目录、库后写入、最后原子换入——任一步失败不残留孤儿
//    （库有行而磁盘无文件），换入失败回滚库到导入前快照；
// 8. 重导保留进度：同哈希天保留已读状态与答题记录；样课包重导只更新样课天，不删除
//    已生成的其他天；幂等判定除哈希外还核磁盘文件存在且内容一致（缺失/失配自动修复）；
// 9. 内容生成不算掌握：quiz_answers 仅学习痕迹，与 study_assessments/get_mastery 完全分离。
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { DbAdapter } from '../db';
import { inTx } from '../db';
import type {
  Course,
  CourseOverview,
  CourseImportResult,
  CoursePackageManifest,
  CourseRequest,
  CourseLesson,
  LessonCodeRef,
  LessonQuizQuestion,
} from '../types';
import { nowIso } from '../utils/date';

export const COURSES_DIR_NAME = 'courses';
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** 相对路径安全：无 ..、无绝对、无反斜杠、无前导 / */
const SAFE_REL_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*\.(?:html|css|png|jpg|jpeg|svg|gif|webp)$/i;

/** 按教学内容比较版本，排除阅读、答题记录和文件路径，规范默认值及对象键顺序。 */
function lessonContentKey(lesson: CoursePackageManifest['lessons'][number] | CourseLesson): string {
  return JSON.stringify({
    title: lesson.title,
    is_sample: lesson.is_sample === true,
    estimated_minutes: lesson.estimated_minutes ?? 45,
    concepts: (lesson.concepts ?? []).map((c) => ({ name: c.name, explanation: c.explanation })),
    code_refs: (lesson.code_refs ?? []).map((c, i) => ({ path: c.path, symbol: c.symbol, role: c.role, order: c.order ?? i + 1 })),
    quiz: (lesson.quiz ?? []).map((q) => ({ question: q.question, options: q.options, answer_index: q.answer_index, explanation: q.explanation })),
  });
}

const sameLessonContent = (old: CourseLesson, lesson: CoursePackageManifest['lessons'][number], hash: string): boolean =>
  old.content_hash === hash && lessonContentKey(old) === lessonContentKey(lesson);

/** 课程资产根目录：dirname(db)/courses（与 tools 同一应用数据推导规则） */
export function coursesRootForDb(dbPath: string): string {
  return join(resolve(dbPath, '..'), COURSES_DIR_NAME);
}

/** 断言目录自身不是符号链接（lstat 只看最终组件；中间组件按系统语义跟随，如 macOS 的 /var）。
 *  「指向目录的符号链接」对 mkdirSync/existsSync/cpSync 完全透明，根自身是链接时所有写入
 *  都会穿透到目标之外——基准目录/staging 根/课程资产根都必须先过这一关。
 *  不存在视为安全：将由 mkdirSync 新建，新建出来的不可能是符号链接。 */
function assertDirNotSymlink(absDir: string, label: string): void {
  let st;
  try {
    st = lstatSync(absDir);
  } catch {
    return; // 不存在：将由调用方新建
  }
  if (st.isSymbolicLink()) throw new Error(`${label}自身是符号链接（symlink 越界风险），拒绝：${absDir}`);
}

/** 断言 base 下的相对路径沿途任何组件都不是符号链接（防 symlink 越界读包外/库外文件）；
 *  base 自身也须不是符号链接（否则一切检查都落在链接目标里，形同虚设） */
function assertNoSymlinkBelow(base: string, rel: string): void {
  let cur = resolve(base);
  assertDirNotSymlink(cur, '基准目录');
  for (const part of rel.split('/')) {
    if (!part || part === '.' || part === '..') throw new Error(`路径不安全：${rel}`);
    cur = join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      throw new Error(`路径不存在：${rel}`);
    }
    if (st.isSymbolicLink()) throw new Error(`路径含符号链接（symlink 越界风险），拒绝：${rel}`);
  }
}

/** 断言 base 下的相对目录路径沿途任何组件都不是符号链接（组件须已存在；合并目标目录专用：
 *  「指向目录的符号链接」对 mkdirSync/existsSync 完全透明，不检查的话写入会穿透到目标之外） */
function assertNoSymlinkDirBelow(base: string, relDir: string): void {
  let cur = resolve(base);
  assertDirNotSymlink(cur, '基准目录');
  for (const part of relDir.split('/')) {
    if (!part || part === '.' || part === '..') throw new Error(`路径不安全：${relDir}`);
    cur = join(cur, part);
    if (lstatSync(cur).isSymbolicLink()) {
      throw new Error(`目标路径含符号链接（symlink 越界风险），拒绝合并：${relDir}`);
    }
  }
}

// ---------- HTML 消毒 ----------

/** 剥离脚本与危险属性、中和外部资源：导入时执行一次（App 渲染另有 iframe sandbox + CSP 双保险） */
export function sanitizeLessonHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<script\b[^>]*\/>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[\s\S]*?<\/embed>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*>/gi, '')
    // 事件属性 on*="..."
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // 危险协议 href/src（保留相对/#）
    .replace(/(href|src)\s*=\s*(["'])\s*(?:javascript|data|vbscript|file):[^"']*\2/gi, '$1=$2#$2')
    // 外部资源一律中和（http/https/协议相对 //）：讲义须离线自包含
    .replace(/\ssrc\s*=\s*(["'])\s*(?:https?:)?\/\/[^"']*\1/gi, ' src=$1#$1')
    .replace(/\ssrcset\s*=\s*(["'])[^"']*\1/gi, '')
    // 内联 style 中的 expression/url(javascript:)
    .replace(/style\s*=\s*(["'])\s*[^"']*(?:expression|javascript:)[^"']*\1/gi, '');
}

/** CSS 消毒：@import 一律删除（可能引入外部资源）；url() 仅保留包内相对引用，
 *  外部/协议相对/绝对/危险协议一律中和为 url(#)（srcdoc + CSP 下本就不可加载，此处双保险） */
export function sanitizeCssText(css: string): string {
  return css
    .replace(/@import\b[^;{]*(?:;|$)/gi, '')
    .replace(/url\(\s*(['"]?)\s*(?:(?:https?:)?\/\/|[a-zA-Z][a-zA-Z0-9+.-]*:|\/)[^)"']*\1\s*\)/gi, 'url(#)');
}

/** 内联包内样式表：`<link rel="stylesheet" href=相对路径.css>`（相对讲义文件解析、
 *  解析后仍在包内、沿途无符号链接、扩展名 .css）替换为消毒后的 `<style>`——
 *  讲义保持离线自包含且课程排版不丢；外部/绝对/协议样式与不可解析的 link 不在此处理
 *  （随后的 sanitizeLessonHtml 会把剩余 <link> 一律剥除）。读不到/不安全时原样返回交给兜底。 */
export function inlineLessonStylesheets(stageRoot: string, lessonHtmlRel: string, html: string): string {
  return html.replace(/<link\b[^>]*>/gi, (tag) => {
    const relM = /rel\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
    const hrefM = /href\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
    if (!relM || !/\bstylesheet\b/i.test(relM[2] ?? relM[3] ?? '') || !hrefM) return tag;
    const href = (hrefM[2] ?? hrefM[3] ?? '').trim();
    if (!href || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) || href.startsWith('//') || href.startsWith('/')) return tag;
    // href 相对讲义文件所在目录解析；剥掉 ?query/#frag 后必须落在包内且为安全相对 .css
    const baseDir = resolve(stageRoot, lessonHtmlRel, '..');
    const abs = resolve(baseDir, href.split('?')[0].split('#')[0]);
    if (abs !== stageRoot && !abs.startsWith(stageRoot + sep)) return tag;
    const inPkg = relative(stageRoot, abs).split(sep).join('/');
    if (!SAFE_REL_RE.test(inPkg) || !inPkg.toLowerCase().endsWith('.css')) return tag;
    try {
      assertNoSymlinkBelow(stageRoot, inPkg);
      if (!existsSync(abs)) return tag;
      const css = sanitizeCssText(readFileSync(abs, 'utf8'));
      return `<style>/* 内联自课程包 ${inPkg}：@import 与外部 url() 已移除（讲义离线自包含） */\n${css}</style>`;
    } catch {
      return tag;
    }
  });
}

// ---------- manifest 校验 ----------

export function validateCourseManifest(raw: unknown): CoursePackageManifest {
  const m = raw as CoursePackageManifest;
  if (!m || typeof m !== 'object') throw new Error('course.json 必须是对象');
  if (m.schema_version !== undefined && m.schema_version !== 1 && m.schema_version !== 2) {
    throw new Error('schema_version 只能是 1 或 2');
  }
  if (m.schema_version === 2 && !m.overview) throw new Error('v2 课程包必须单独提供 overview.html，不得把课程总览放进 D1');
  if (typeof m.slug !== 'string' || !SLUG_RE.test(m.slug)) throw new Error(`slug "${m.slug}" 无效：小写 slug（字母数字 . _ -），≤64 字符`);
  if (typeof m.title !== 'string' || !m.title.trim() || m.title.length > 120) throw new Error('title 不能为空且 ≤120 字符');
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(m.version)) throw new Error(`version "${m.version}" 必须是语义化 x.y.z`);
  if (m.plan_id != null && !Number.isInteger(m.plan_id)) throw new Error('plan_id 必须是整数或省略');
  if (m.overview !== undefined && (!m.overview || typeof m.overview !== 'object' ||
    typeof m.overview.html !== 'string' || !SAFE_REL_RE.test(m.overview.html) || !/\.html$/i.test(m.overview.html))) {
    throw new Error('overview.html 必须是包内安全相对 HTML 路径');
  }
  if (!Array.isArray(m.lessons) || m.lessons.length === 0) throw new Error('lessons 不能为空');
  const days = new Set<number>();
  let samples = 0;
  m.lessons.forEach((l, i) => {
    if (!Number.isInteger(l.day) || l.day < 1 || l.day > 365) throw new Error(`lessons[${i}].day 必须是 1~365 整数`);
    if (days.has(l.day)) throw new Error(`lessons[${i}].day=${l.day} 重复`);
    days.add(l.day);
    if (typeof l.title !== 'string' || !l.title.trim()) throw new Error(`lessons[${i}].title 不能为空`);
    if (typeof l.html !== 'string' || !SAFE_REL_RE.test(l.html)) {
      throw new Error(`lessons[${i}].html "${l.html}" 路径不安全：须为包内安全相对路径（html/css/图片扩展名，无 .. 无绝对路径）`);
    }
    if (m.overview?.html === l.html) throw new Error('课程总览与每日讲义不能共用同一个 HTML 文件');
    if (l.is_sample) samples += 1;
    if (l.quiz) {
      if (!Array.isArray(l.quiz)) throw new Error(`lessons[${i}].quiz 必须是数组`);
      l.quiz.forEach((q, qi) => {
        if (typeof q.question !== 'string' || !q.question.trim()) throw new Error(`lessons[${i}].quiz[${qi}].question 不能为空`);
        if (!Array.isArray(q.options) || q.options.length < 2) throw new Error(`lessons[${i}].quiz[${qi}].options 至少 2 项`);
        if (!Number.isInteger(q.answer_index) || q.answer_index < 0 || q.answer_index >= q.options.length) {
          throw new Error(`lessons[${i}].quiz[${qi}].answer_index 越界`);
        }
      });
    }
  });
  // 恰好一个样课：样课包（仅样课一天）与完整包（保留样课标记）都必须带标记——
  // 无标记包（哪怕一天）不得以「空真」混入样课流程，否则完整包门槛可被绕过
  if (samples !== 1) {
    throw new Error('课程包必须恰好包含一个样课（is_sample）：样课包仅含样课一天，完整包须保留样课标记（首天）');
  }
  return m;
}

// ---------- 服务 ----------

export interface CourseServiceDeps {
  db: DbAdapter;
  /** 数据库路径（推导课程资产根目录） */
  dbPath: string;
}

export function createCourseService(deps: CourseServiceDeps) {
  const { db, dbPath } = deps;
  const root = coursesRootForDb(dbPath);
  const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

  const mapCourse = (r: Record<string, unknown>): Course => ({
    id: Number(r.id),
    slug: String(r.slug),
    title: String(r.title),
    goal: String(r.goal ?? ''),
    status: r.status as Course['status'],
    plan_id: r.plan_id === null || r.plan_id === undefined ? null : Number(r.plan_id),
    sample_content_hash: (r.sample_content_hash as string | null) ?? null,
    sample_confirmed_at: (r.sample_confirmed_at as string | null) ?? null,
    version: String(r.version),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  });

  const mapLesson = (r: Record<string, unknown>): CourseLesson => ({
    id: Number(r.id),
    course_id: Number(r.course_id),
    day: Number(r.day),
    title: String(r.title),
    html_rel: String(r.html_rel),
    content_hash: String(r.content_hash),
    revision: Number(r.revision ?? 1),
    is_sample: Number(r.is_sample) === 1,
    status: r.status as CourseLesson['status'],
    estimated_minutes: Number(r.estimated_minutes ?? 45),
    concepts: JSON.parse(String(r.concepts ?? '[]')),
    code_refs: JSON.parse(String(r.code_refs ?? '[]')),
    quiz: JSON.parse(String(r.quiz ?? '[]')),
    quiz_answers: JSON.parse(String(r.quiz_answers ?? '[]')),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  });

  const mapOverview = (r: Record<string, unknown>): CourseOverview => ({
    course_id: Number(r.course_id),
    html_rel: String(r.html_rel),
    content_hash: String(r.content_hash),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  });

  const getCourse = (id: number): Course => {
    const row = db.prepare('SELECT * FROM courses WHERE id = ?').get(id);
    if (!row) throw new Error(`课程 ${id} 不存在`);
    return mapCourse(row);
  };
  const listCourses = (): Course[] => db.prepare('SELECT * FROM courses ORDER BY created_at DESC, id DESC').all().map(mapCourse);

  const listLessons = (courseId: number): CourseLesson[] =>
    db.prepare('SELECT * FROM course_lessons WHERE course_id = ? ORDER BY day ASC').all(courseId).map(mapLesson);

  const getOverview = (courseId: number): CourseOverview | null => {
    getCourse(courseId);
    const row = db.prepare('SELECT * FROM course_overviews WHERE course_id = ?').get(courseId);
    return row ? mapOverview(row) : null;
  };

  const getLesson = (courseId: number, day: number): CourseLesson => {
    const row = db.prepare('SELECT * FROM course_lessons WHERE course_id = ? AND day = ?').get(courseId, day);
    if (!row) throw new Error(`课程 ${courseId} 第 ${day} 天讲义不存在（待生成）`);
    return mapLesson(row);
  };

  /** 安全读取已消毒的课程 HTML；总览与每日讲义共用路径防护。 */
  const readCourseHtml = (htmlRel: string): string => {
    const abs = resolve(root, htmlRel);
    if (abs !== root && !abs.startsWith(root + sep)) throw new Error('路径越界：拒绝读取');
    assertNoSymlinkBelow(root, htmlRel);
    if (!existsSync(abs)) throw new Error(`课程文件缺失：${htmlRel}（重新导入同一课程包可自动修复）`);
    return readFileSync(abs, 'utf8');
  };
  const readLessonHtml = (lesson: CourseLesson): string => readCourseHtml(lesson.html_rel);
  const readOverviewHtml = (overview: CourseOverview): string => readCourseHtml(overview.html_rel);

  // ---------- 导入（staging 校验 → 消毒 → 资产先暂存 → 入库 → 原子换入；幂等且可修复） ----------

  const importCourse = (stagingDir: string): CourseImportResult => {
    const manifestPath = join(stagingDir, 'course.json');
    if (!existsSync(manifestPath)) throw new Error('包根缺少 course.json');
    const manifest = validateCourseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));

    // 绑定的计划必须已存在（只引用，绝不创建）
    if (manifest.plan_id != null) {
      const plan = db.prepare('SELECT id FROM study_plans WHERE id = ?').get(manifest.plan_id);
      if (!plan) throw new Error(`plan_id ${manifest.plan_id} 不存在：课程只能绑定既有学习计划`);
    }

    // 逐讲义校验：存在性 + 词法防穿越 + 沿途无符号链接 + 包内样式内联 + 消毒 + 哈希
    const stageRoot = resolve(stagingDir);
    const prepared = manifest.lessons.map((l) => {
      const abs = resolve(stageRoot, l.html);
      if (abs !== stageRoot && !abs.startsWith(stageRoot + sep)) {
        throw new Error(`lessons html "${l.html}" 路径穿越，拒绝`);
      }
      assertNoSymlinkBelow(stageRoot, l.html);
      if (!existsSync(abs)) throw new Error(`讲义文件缺失：${l.html}`);
      const html = readFileSync(abs, 'utf8');
      // 包内 .css 先内联（保留课程排版、保持离线自包含），再整体消毒（剩余 link/脚本/外部资源剥除）
      const sanitized = sanitizeLessonHtml(inlineLessonStylesheets(stageRoot, l.html, html));
      return { lesson: l, sanitized, hash: sha256(sanitized) };
    });
    const preparedOverview = manifest.overview ? (() => {
      const rel = manifest.overview!.html;
      const abs = resolve(stageRoot, rel);
      if (!abs.startsWith(stageRoot + sep)) throw new Error(`overview.html "${rel}" 路径穿越，拒绝`);
      assertNoSymlinkBelow(stageRoot, rel);
      const sanitized = sanitizeLessonHtml(inlineLessonStylesheets(stageRoot, rel, readFileSync(abs, 'utf8')));
      return { html: rel, sanitized, hash: sha256(sanitized) };
    })() : null;
    const sampleHash = prepared.find((p) => p.lesson.is_sample)?.hash ?? null;
    // 样课包 = 仅样课一天（且带 is_sample 标记；manifest 已保证恰好一个标记，此处显式声明语义）；
    // 含任何非样课天即为完整包
    const sampleOnly = manifest.lessons.length === 1 && manifest.lessons[0].is_sample === true;

    const now = nowIso();
    const existingRow = db.prepare('SELECT * FROM courses WHERE slug = ?').get(manifest.slug);
    const prev = existingRow ? mapCourse(existingRow) : null;
    const prevLessons = prev ? listLessons(prev.id) : [];
    const prevOverview = prev ? getOverview(prev.id) : null;
    if (preparedOverview && prevLessons.some((l) => l.html_rel === `${manifest.slug}/${preparedOverview.html}`)) {
      throw new Error('课程总览与已有每日讲义不能共用同一个 HTML 文件');
    }
    if (!sampleOnly && prevOverview && !preparedOverview) {
      throw new Error('完整包缺少独立课程总览：请在 course.json 中保留 overview.html');
    }
    if (sampleOnly && prevOverview && !preparedOverview) {
      try { readOverviewHtml(prevOverview); }
      catch { throw new Error('已有课程总览文件缺失：请在重导的样课包中加入 overview.html 以修复'); }
    }

    // plan 绑定不可变更：已有绑定的课程换绑其他计划一律拒绝——
    // 否则换绑短计划即可掩护短包通过 complete 的计划天数核验
    if (prev && prev.plan_id != null && manifest.plan_id != null && manifest.plan_id !== prev.plan_id) {
      throw new Error(`plan_id 不可变更：课程已绑定学习计划 ${prev.plan_id}，不得改绑计划 ${manifest.plan_id}（省略 plan_id 表示沿用原绑定）`);
    }

    // 完整包门槛：任何完整包（含非样课天）都必须走「样课导入 → 用户阅读确认 → 生成请求 → agent 认领」。
    // 全新课程首导完整包（无论是否带样课标记）同样拒绝——课程必须从样课包开始；
    // 已有样课的课程，完整包仅在存在已认领（claimed）且哈希与当前确认一致的请求时放行；
    // 例外见下方 completedSameContent：已完成课程的完全同内容重导不要求 claimed（请求已 done）。
    // 已有课程但无样课记录（历史残留/数据异常）同样拒绝——样课流程的证据链不完整。
    if (!sampleOnly && !prev) {
      throw new Error('完整包导入被拒：课程必须先导入样课包（仅样课一天），由用户在 App 阅读并确认后再请求完整版');
    }

    // 已完成课程的同内容重导判定（必须先于 claimed 门槛）：请求 done 后库中不再有 claimed 记录，
    // 门槛若先于幂等检查会误拒两类合法操作——a) 同版本同哈希的幂等重试；b) 磁盘文件缺失/失配后的
    // 同包修复。仅当课程已 complete 且包与已导入内容完全一致（同版本、同天数集合、每天同哈希、
    // 样课哈希仍与用户确认一致）才放行；任何内容/版本变化都不满足，仍须「新确认+新请求+认领」。
    const pkgSample = prepared.find((p) => p.lesson.is_sample) ?? null;
    const completedSameContent =
      prev != null &&
      !sampleOnly &&
      prev.status === 'complete' &&
      prev.version === manifest.version &&
      prev.sample_confirmed_at != null &&
      prev.sample_content_hash != null &&
      pkgSample != null &&
      pkgSample.hash === prev.sample_content_hash &&
      prevLessons.length === prepared.length &&
      prevLessons.every((pl) => {
        const m = prepared.find((p) => p.lesson.day === pl.day);
        return m != null && sameLessonContent(pl, m.lesson, m.hash);
      }) && (preparedOverview == null || (prevOverview?.content_hash === preparedOverview.hash));

    if (prev && !sampleOnly) {
      if (!prevLessons.some((l) => l.is_sample)) {
        throw new Error('完整包导入被拒：课程缺少样课记录（数据异常）——须从样课包重新建立确认链后才能导入完整包');
      }
      if (!completedSameContent) {
        const claimed = db
          .prepare("SELECT * FROM course_requests WHERE course_id = ? AND status = 'claimed' ORDER BY id DESC LIMIT 1")
          .get(prev.id);
        const okClaimed =
          claimed &&
          prev.sample_confirmed_at != null &&
          prev.sample_content_hash != null &&
          String(claimed.sample_content_hash) === prev.sample_content_hash;
        if (!okClaimed) {
          throw new Error(
            '完整包导入被拒：该课程走样课流程，须先由用户在 App 阅读后在对话中确认样课、创建生成请求并由 agent 认领（claim_course_request）后，才能导入完整包',
          );
        }
        // 完整包样课正文须与用户确认版本逐字节一致：请求哈希只证明「认领有效」，
        // 包内样课被偷换须在导入时即拒绝（不得拖到 complete 才发现，更不得冲掉用户确认）
        if (!pkgSample || pkgSample.hash !== prev.sample_content_hash) {
          throw new Error('完整包导入被拒：包内样课正文与用户确认的样课版本不一致（须与已确认样课逐字节一致）');
        }
      }
    }

    // 幂等：除内容与资产外还要核对计划绑定；未绑定课程补绑计划不能被同包早退吞掉。
    if (prev) {
      const sameLessons =
        prevLessons.length === prepared.length &&
        prevLessons.every((pl) => {
          const match = prepared.find((p) => p.lesson.day === pl.day);
          if (!match || !sameLessonContent(pl, match.lesson, match.hash)) return false;
          const abs = resolve(root, pl.html_rel);
          if (!existsSync(abs)) return false;
          try {
            return sha256(readFileSync(abs, 'utf8')) === pl.content_hash;
          } catch {
            return false;
          }
        });
      const sameBinding = manifest.plan_id == null || prev.plan_id === manifest.plan_id;
      const sameOverview = preparedOverview == null || (prevOverview?.content_hash === preparedOverview.hash && (() => {
        try { return sha256(readOverviewHtml(prevOverview)) === prevOverview.content_hash; }
        catch { return false; }
      })());
      if (sameLessons && sameOverview && prev.version === manifest.version && sameBinding) {
        return { course: prev, lessons: prevLessons, idempotent: true, confirmation_expired: false };
      }
    }

    // 1) 资产先复制到暂存目录（不碰库；复制中途失败也清理半成品暂存目录——
    //    失败即止，不留库侧孤儿，也不残留 .staging-* 目录）
    const staged = join(root, `.staging-${manifest.slug}-${process.pid}-${Date.now()}`);
    try {
      stageAssets(stagingDir, staged, prepared, preparedOverview);
      // 2) 库写入（事务；失败回滚并清理暂存，磁盘与库都保持导入前状态）
      const { id: courseId, confirmationExpired } = writeCourseRows(prev?.id ?? null, prev, prevLessons, manifest, prepared, preparedOverview, sampleHash, sampleOnly, now);

      // 3) 资产换入：样课包重导走「合并」（不删除已生成的其他天文件）；完整包走「整目录换入」。
      //    换入失败把库回滚到导入前快照（新课程直接删除，杜绝「库有行、磁盘无文件」）。
      try {
        if (sampleOnly) mergeAssetsIn(manifest.slug, staged);
        else swapAssetsIn(manifest.slug, staged);
      } catch (swapErr) {
        rollbackCourseRows(courseId, prev, prevLessons, prevOverview);
        throw swapErr;
      }
      return { course: getCourse(courseId), lessons: listLessons(courseId), idempotent: false, confirmation_expired: confirmationExpired };
    } catch (e) {
      rmSync(staged, { recursive: true, force: true });
      throw e;
    }
  };

  /** 资产暂存：拷贝包内安全资源到指定暂存目录（root/.staging-<slug>-…，由调用方创建并负责失败清理），
   *  讲义写消毒版；沿途符号链接一律跳过 */
  function stageAssets(
    stagingDir: string,
    staged: string,
    prepared: Array<{ lesson: CoursePackageManifest['lessons'][number]; sanitized: string }>,
    preparedOverview: { html: string; sanitized: string } | null,
  ): void {
    // 课程资产根自身不得是符号链接：mkdirSync(recursive) 对目录符号链接完全透明，
    // 不先查根的话后续所有暂存/合并/换入写入都会穿透到库目录之外
    assertDirNotSymlink(root, '课程资产根目录');
    mkdirSync(root, { recursive: true });
    rmSync(staged, { recursive: true, force: true });
    mkdirSync(staged, { recursive: true });
    const copyDirSafe = (srcDir: string, rel: string) => {
      for (const name of readdirSync(srcDir)) {
        const srcAbs = join(srcDir, name);
        const relPath = rel ? `${rel}/${name}` : name;
        const st = lstatSync(srcAbs); // lstat：符号链接不跟随，直接跳过（防 symlink 越界拷出包外内容）
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          if (name === 'node_modules' || name === '.git') continue;
          copyDirSafe(srcAbs, relPath);
          continue;
        }
        if (!SAFE_REL_RE.test(relPath) && !relPath.endsWith('.md')) continue;
        const destAbs = resolve(staged, relPath);
        if (!destAbs.startsWith(resolve(staged) + sep) && destAbs !== resolve(staged)) continue;
        mkdirSync(resolve(destAbs, '..'), { recursive: true });
        cpSync(srcAbs, destAbs);
      }
    };
    copyDirSafe(stagingDir, '');
    // 用消毒版 HTML 覆盖讲义文件
    for (const p of prepared) {
      const destAbs = resolve(staged, p.lesson.html);
      if (!destAbs.startsWith(resolve(staged) + sep)) continue;
      mkdirSync(resolve(destAbs, '..'), { recursive: true });
      writeFileSync(destAbs, p.sanitized, 'utf8');
    }
    if (preparedOverview) {
      const destAbs = resolve(staged, preparedOverview.html);
      mkdirSync(resolve(destAbs, '..'), { recursive: true });
      writeFileSync(destAbs, preparedOverview.sanitized, 'utf8');
    }
  }

  /** 换入：旧目录先挪到 .trash 再 rename 暂存目录（同盘 rename 原子），失败把旧目录还原 */
  function swapAssetsIn(slug: string, staged: string): void {
    const dest = join(root, slug);
    const trash = join(root, `.trash-${slug}-${process.pid}-${Date.now()}`);
    const hadDest = existsSync(dest);
    if (hadDest) renameSync(dest, trash);
    try {
      renameSync(staged, dest);
    } catch (e) {
      if (hadDest) {
        rmSync(dest, { recursive: true, force: true });
        renameSync(trash, dest);
      }
      throw e;
    }
    if (hadDest) rmSync(trash, { recursive: true, force: true });
  }

  /** 合并换入（样课包重导专用）：两阶段原子合并，保证「文件与库一致」——
   *  阶段1 把暂存树逐文件拷到目标旁的临时名（目标零改动）；阶段2 逐文件同目录 rename 落位
   *  （旧文件先挪 .bak）。任一步失败：恢复/清理到导入前状态再抛错（库由 rollbackCourseRows 回滚），
   *  绝不留下磁盘半更新。绝不能整目录换入，否则会误删已生成的 Day2..N 讲义文件。
   *  symlink 防越界：目标目录及其下任何中间目录组件、暂存树内任何条目都不得是符号链接——
   *  否则写入/搬运会穿透到课程目录之外。 */
  function mergeAssetsIn(slug: string, staged: string): void {
    const dest = join(root, slug);
    mkdirSync(dest, { recursive: true });
    // 目标目录组件（root/<slug>…）不得含符号链接：mkdirSync 对「指向目录的符号链接」不报错，
    // 不检查的话后续所有写入都会穿透到包外
    assertNoSymlinkDirBelow(root, slug);
    const destAbs = resolve(dest);
    const files: Array<{ rel: string }> = [];
    const collect = (dir: string, rel: string) => {
      for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        const relPath = rel ? `${rel}/${name}` : name;
        const st = lstatSync(abs);
        // 暂存树由 stageAssets 生成（符号链接本就不会拷入）；此处再验一次——
        // 竞态下混入的符号链接会把「复制」变成「穿透搬运」，绝不让它进入目标目录
        if (st.isSymbolicLink()) throw new Error(`暂存树含符号链接（symlink 越界风险），拒绝合并：${relPath}`);
        if (st.isDirectory()) { collect(abs, relPath); continue; }
        files.push({ rel: relPath });
      }
    };
    collect(staged, '');
    const plan = files.map((f, i) => {
      const finalAbs = resolve(dest, f.rel);
      if (!finalAbs.startsWith(destAbs + sep)) throw new Error(`合并路径越界：${f.rel}`);
      const base = f.rel.split('/').pop() ?? 'f';
      return {
        rel: f.rel,
        final: finalAbs,
        tmp: join(resolve(finalAbs, '..'), `.merge-tmp-${i}-${base}`),
        bak: join(resolve(finalAbs, '..'), `.merge-bak-${i}-${base}`),
        hadFinal: existsSync(finalAbs),
      };
    });
    const createdDirs: string[] = [];
    for (const p of plan) {
      const dir = resolve(p.final, '..');
      if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); createdDirs.push(dir); }
    }
    // 落位目录的每个中间组件（root/<slug>/<子目录>…）都不得是符号链接
    for (const p of plan) {
      const relDir = p.rel.split('/').slice(0, -1).join('/');
      assertNoSymlinkDirBelow(root, relDir ? `${slug}/${relDir}` : slug);
    }
    // 阶段 1：暂存文件就位到临时名（失败即止，目标目录原样）。
    // 临时名先清理残留（上次崩溃可能留下同名文件/目录），否则会被永久卡住
    try {
      for (const p of plan) {
        rmSync(p.tmp, { recursive: true, force: true });
        cpSync(join(staged, p.rel), p.tmp);
      }
    } catch (e) {
      for (const p of plan) rmSync(p.tmp, { recursive: true, force: true });
      throw e;
    }
    // 阶段 2：逐文件原子落位（final→bak，tmp→final）；失败恢复到导入前状态
    const done: typeof plan = [];
    try {
      for (const p of plan) {
        if (p.hadFinal) renameSync(p.final, p.bak);
        try {
          renameSync(p.tmp, p.final);
        } catch (e) {
          if (p.hadFinal) renameSync(p.bak, p.final); // 该文件自身先恢复
          throw e;
        }
        done.push(p);
      }
    } catch (e) {
      for (const p of plan) {
        try {
          if (p.hadFinal) {
            if (existsSync(p.bak)) renameSync(p.bak, p.final); // 恢复旧内容（原子覆盖新内容）
          } else if (done.includes(p) && existsSync(p.final)) {
            rmSync(p.final, { force: true }); // 导入前不存在的文件移除
          }
        } catch { /* 尽力恢复 */ }
        try { rmSync(p.tmp, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
        try { rmSync(p.bak, { recursive: true, force: true }); } catch { /* 预置同名目录等极端情况 */ }
      }
      for (const d of [...createdDirs].reverse()) { try { rmdirSync(d); } catch { /* 非空/已删则保留 */ } }
      throw e;
    }
    // 阶段 3：全部成功——清理备份与暂存目录
    for (const p of plan) rmSync(p.bak, { recursive: true, force: true });
    rmSync(staged, { recursive: true, force: true });
  }

  /** 库写入：新课程插入；已有课程更新元数据并按「样课包只更新样课天 / 完整包全量替换（携带同哈希进度）」写讲义 */
  function writeCourseRows(
    courseId: number | null,
    prev: Course | null,
    prevLessons: CourseLesson[],
    manifest: CoursePackageManifest,
    prepared: Array<{ lesson: CoursePackageManifest['lessons'][number]; hash: string }>,
    preparedOverview: { html: string; hash: string } | null,
    sampleHash: string | null,
    sampleOnly: boolean,
    now: string,
  ): { id: number; confirmationExpired: boolean } {
    let confirmationExpired = false;
    db.exec('BEGIN');
    try {
      let id = courseId;
      if (prev) {
        // 样课内容变化 → 已有确认过期（置回 imported，清除确认）；无样课的完整包不清除既有绑定
        if (prev.sample_confirmed_at && prev.sample_content_hash && sampleHash && prev.sample_content_hash !== sampleHash) {
          confirmationExpired = true;
          db.prepare("UPDATE courses SET sample_content_hash = NULL, sample_confirmed_at = NULL, status = 'imported' WHERE id = ?").run(prev.id);
        }
        const effHash = sampleHash ?? prev.sample_content_hash ?? null;
        db.prepare(
          'UPDATE courses SET title = ?, goal = ?, plan_id = COALESCE(?, plan_id), sample_content_hash = ?, version = ?, updated_at = ? WHERE id = ?',
        ).run(manifest.title, manifest.goal ?? '', manifest.plan_id ?? null, effHash, manifest.version, now, prev.id);
      } else {
        const res = db
          .prepare('INSERT INTO courses (slug, title, goal, status, plan_id, sample_content_hash, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(manifest.slug, manifest.title, manifest.goal ?? '', 'imported', manifest.plan_id ?? null, sampleHash, manifest.version, now, now);
        id = Number(res.lastInsertRowid);
      }

      // 样课包重导：只更新包内天（不删除已生成的其他天）；完整包：全量替换
      if (!sampleOnly) db.prepare('DELETE FROM course_lessons WHERE course_id = ?').run(id);
      const oldByDay = new Map(prevLessons.map((pl) => [pl.day, pl]));
      for (const p of prepared) {
        const quiz: LessonQuizQuestion[] = (p.lesson.quiz ?? []).map((q, qi) => ({ id: `q${qi + 1}`, ...q }));
        const codeRefs: LessonCodeRef[] = (p.lesson.code_refs ?? []).map((c, i) => ({ path: c.path, symbol: c.symbol, role: c.role, order: c.order ?? i + 1 }));
        // 重导保留进度：同哈希天保留已读状态与答题记录；内容变更的天从 generated 重新开始
        const old = oldByDay.get(p.lesson.day);
        const sameContent = old != null && old.content_hash === p.hash;
        const revision = old ? old.revision + (sameLessonContent(old, p.lesson, p.hash) ? 0 : 1) : 1;
        const status = sameContent && old.status === 'read' ? 'read' : 'generated';
        const carriedAnswers = sameContent ? JSON.stringify(old.quiz_answers) : '[]';
        const oldRow = sampleOnly ? db.prepare('SELECT id FROM course_lessons WHERE course_id = ? AND day = ?').get(id, p.lesson.day) : null;
        if (sampleOnly && oldRow) {
          db.prepare(
            `UPDATE course_lessons SET title = ?, html_rel = ?, content_hash = ?, is_sample = ?, status = ?, estimated_minutes = ?, concepts = ?, code_refs = ?, quiz = ?, quiz_answers = ?, revision = ?, updated_at = ? WHERE id = ?`,
          ).run(
            p.lesson.title,
            `${manifest.slug}/${p.lesson.html}`,
            p.hash,
            p.lesson.is_sample ? 1 : 0,
            status,
            p.lesson.estimated_minutes ?? 45,
            JSON.stringify(p.lesson.concepts ?? []),
            JSON.stringify(codeRefs),
            JSON.stringify(quiz),
            carriedAnswers,
            revision,
            now,
            Number(oldRow.id),
          );
        } else {
          db.prepare(
            `INSERT INTO course_lessons (course_id, day, title, html_rel, content_hash, is_sample, status, estimated_minutes, concepts, code_refs, quiz, quiz_answers, revision, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            id,
            p.lesson.day,
            p.lesson.title,
            `${manifest.slug}/${p.lesson.html}`,
            p.hash,
            p.lesson.is_sample ? 1 : 0,
            status,
            p.lesson.estimated_minutes ?? 45,
            JSON.stringify(p.lesson.concepts ?? []),
            JSON.stringify(codeRefs),
            JSON.stringify(quiz),
            carriedAnswers,
            revision,
            now,
            now,
          );
        }
      }
      if (preparedOverview) {
        db.prepare(`INSERT INTO course_overviews (course_id, html_rel, content_hash, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(course_id) DO UPDATE SET html_rel = excluded.html_rel,
            content_hash = excluded.content_hash, updated_at = excluded.updated_at`)
          .run(id, `${manifest.slug}/${preparedOverview.html}`, preparedOverview.hash, now, now);
      }
      db.exec('COMMIT');
      return { id: id!, confirmationExpired };
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch { /* 保留原始错误 */ }
      throw e;
    }
  }

  /** 换入失败后的库回滚：新课程整课删除；更新则恢复课程行与讲义行快照 */
  function rollbackCourseRows(courseId: number, prev: Course | null, prevLessons: CourseLesson[], prevOverview: CourseOverview | null): void {
    try {
      db.exec('BEGIN');
      db.prepare('DELETE FROM course_lessons WHERE course_id = ?').run(courseId);
      db.prepare('DELETE FROM course_overviews WHERE course_id = ?').run(courseId);
      if (!prev) {
        db.prepare('DELETE FROM courses WHERE id = ?').run(courseId);
      } else {
        for (const pl of prevLessons) {
          db.prepare(
            `INSERT INTO course_lessons (course_id, day, title, html_rel, content_hash, is_sample, status, estimated_minutes, concepts, code_refs, quiz, quiz_answers, revision, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            pl.course_id, pl.day, pl.title, pl.html_rel, pl.content_hash, pl.is_sample ? 1 : 0, pl.status, pl.estimated_minutes,
            JSON.stringify(pl.concepts), JSON.stringify(pl.code_refs), JSON.stringify(pl.quiz), JSON.stringify(pl.quiz_answers), pl.revision, pl.created_at, pl.updated_at,
          );
        }
        db.prepare(
          'UPDATE courses SET title = ?, goal = ?, status = ?, plan_id = ?, sample_content_hash = ?, sample_confirmed_at = ?, version = ?, updated_at = ? WHERE id = ?',
        ).run(prev.title, prev.goal, prev.status, prev.plan_id, prev.sample_content_hash, prev.sample_confirmed_at, prev.version, prev.updated_at, prev.id);
        if (prevOverview) {
          db.prepare('INSERT INTO course_overviews (course_id, html_rel, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run(prevOverview.course_id, prevOverview.html_rel, prevOverview.content_hash, prevOverview.created_at, prevOverview.updated_at);
        }
      }
      db.exec('COMMIT');
    } catch { /* 回滚尽力而为；幂等导入的文件核验可发现并修复不一致 */ }
  }

  // ---------- 阅读 / 答题 ----------

  const markLessonRead = (courseId: number, day: number): CourseLesson => {
    db.prepare("UPDATE course_lessons SET status = 'read', updated_at = ? WHERE course_id = ? AND day = ?").run(nowIso(), courseId, day);
    return getLesson(courseId, day);
  };

  /** 答题（学习痕迹，非掌握证据）：幂等——同题重答覆盖并保留 at 时间戳；选项越界视为无效 */
  const submitQuiz = (courseId: number, day: number, answers: Array<{ question_id: string; picked: number }>): CourseLesson => {
    const lesson = getLesson(courseId, day);
    const byId = new Map(lesson.quiz.map((q) => [q.id, q]));
    const clean = answers.filter((a) => {
      const q = byId.get(a.question_id);
      return q != null && Number.isInteger(a.picked) && a.picked >= 0 && a.picked < q.options.length;
    });
    if (clean.length === 0) throw new Error('answers 为空或全部无效');
    const byQ = new Map(clean.map((a) => [a.question_id, a]));
    // 以旧作答为基、仅覆盖本次重答项（未重答题保留原 picked/at）
    const prev = new Map(lesson.quiz_answers.map((a) => [a.question_id, a]));
    const merged = lesson.quiz.map((q) => {
      if (byQ.has(q.id)) return { question_id: q.id, picked: byQ.get(q.id)!.picked, at: nowIso() };
      const old = prev.get(q.id);
      return old ?? null;
    }).filter(Boolean) as CourseLesson['quiz_answers'];
    db.prepare('UPDATE course_lessons SET quiz_answers = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(merged), nowIso(), lesson.id);
    return getLesson(courseId, day);
  };

  // ---------- 样课确认（版本绑定） ----------

  /** 记录用户的明确确认：须已在 App 阅读；绑定当前样课 content_hash，变更后须重新阅读确认。
   *  对话确认由专用 MCP 工具承接，通用本体动作不能自动代确认。 */
  const confirmSample = (courseId: number, expectedHash?: string): Course => {
    const course = getCourse(courseId);
    const sampleRow = db.prepare('SELECT * FROM course_lessons WHERE course_id = ? AND is_sample = 1').get(courseId);
    if (!sampleRow) throw new Error('课程没有样课：课程包必须以样课（is_sample）开头导入');
    const sample = mapLesson(sampleRow);
    if (expectedHash != null && expectedHash !== sample.content_hash) {
      throw new Error('样课版本已变更：请在 App 阅读当前样课后，在对话中重新确认');
    }
    if (sample.status !== 'read') {
      throw new Error('样课尚未阅读：请先在 App 打开样课讲义阅读（自动记录已读），再确认绑定版本');
    }
    if (course.sample_confirmed_at && course.sample_content_hash === sample.content_hash) {
      return course; // 幂等：同版本重复确认
    }
    const now = nowIso();
    db.prepare("UPDATE courses SET status = 'sample_confirmed', sample_content_hash = ?, sample_confirmed_at = ?, updated_at = ? WHERE id = ?").run(sample.content_hash, now, now, courseId);
    return getCourse(courseId);
  };

  // ---------- 完整版生成请求队列 ----------

  /** 创建完整版生成请求：仅样课已确认且 hash 未过期时允许；幂等（已有 pending 不重复建） */
  const createGenerationRequest = (courseId: number, requestedBy = 'app'): CourseRequest => {
    const course = getCourse(courseId);
    if (!course.sample_confirmed_at || !course.sample_content_hash) {
      throw new Error('样课尚未确认：用户须先在 App 阅读样课，再在对话中确认，才能请求完整版');
    }
    const pending = db.prepare("SELECT * FROM course_requests WHERE course_id = ? AND status IN ('pending','claimed') ORDER BY id LIMIT 1").get(courseId);
    if (pending) return mapReq(pending); // 幂等
    const res = db
      .prepare("INSERT INTO course_requests (course_id, kind, status, sample_content_hash, requested_by, created_at) VALUES (?, 'full_generation', 'pending', ?, ?, ?)")
      .run(courseId, course.sample_content_hash, requestedBy, nowIso());
    return mapReq(db.prepare('SELECT * FROM course_requests WHERE id = ?').get(Number(res.lastInsertRowid))!);
  };

  const mapReq = (r: Record<string, unknown>): CourseRequest => ({
    id: Number(r.id),
    course_id: Number(r.course_id),
    kind: r.kind as CourseRequest['kind'],
    status: r.status as CourseRequest['status'],
    sample_content_hash: String(r.sample_content_hash),
    requested_by: String(r.requested_by),
    claimed_by: (r.claimed_by as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    created_at: String(r.created_at),
    claimed_at: (r.claimed_at as string | null) ?? null,
    completed_at: (r.completed_at as string | null) ?? null,
  });

  const listRequests = (filter: { status?: CourseRequest['status']; course_id?: number } = {}): CourseRequest[] => {
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.course_id != null) {
      where.push('course_id = ?');
      params.push(filter.course_id);
    }
    return db.prepare(`SELECT * FROM course_requests WHERE ${where.join(' AND ')} ORDER BY id DESC`).all(...params).map(mapReq);
  };

  /** agent 认领（pending→claimed）：样课哈希与课程当前确认一致才放行（批准过期拒绝） */
  const claimRequest = (requestId: number, claimedBy: string): CourseRequest => {
    const row = db.prepare('SELECT * FROM course_requests WHERE id = ?').get(requestId);
    if (!row) throw new Error(`请求 ${requestId} 不存在`);
    const req = mapReq(row);
    if (req.status === 'claimed' && req.claimed_by === claimedBy) return req; // 幂等
    if (req.status !== 'pending') throw new Error(`请求 ${requestId} 状态为 ${req.status}，不能认领`);
    const course = getCourse(req.course_id);
    if (!course.sample_confirmed_at || course.sample_content_hash !== req.sample_content_hash) {
      db.prepare("UPDATE course_requests SET status = 'failed', error = '样课已变更，确认过期：请求拒绝执行，请用户重新确认', completed_at = ? WHERE id = ?").run(nowIso(), requestId);
      throw new Error('样课已变更（确认过期）：拒绝执行；请让用户在 App 重新阅读后，在对话中确认并重新发起');
    }
    db.prepare("UPDATE course_requests SET status = 'claimed', claimed_by = ?, claimed_at = ? WHERE id = ? AND status = 'pending'").run(claimedBy, nowIso(), requestId);
    return mapReq(db.prepare('SELECT * FROM course_requests WHERE id = ?').get(requestId)!);
  };

  /** agent 完成（claimed→done）：核确认哈希未过期 + 完整天数（1..N 连续且含样课），须先以完整包 importCourse */
  const completeRequest = (requestId: number, claimedBy: string): CourseRequest => {
    const row = db.prepare('SELECT * FROM course_requests WHERE id = ?').get(requestId);
    if (!row) throw new Error(`请求 ${requestId} 不存在`);
    const req = mapReq(row);
    if (req.status === 'done') return req; // 幂等
    if (req.status !== 'claimed') throw new Error(`请求 ${requestId} 未被认领（状态 ${req.status}），先 claimRequest`);
    if (req.claimed_by !== claimedBy) throw new Error(`请求 ${requestId} 由 ${req.claimed_by} 认领，${claimedBy} 不能完成`);
    const lessons = listLessons(req.course_id);
    const course = getCourse(req.course_id);
    const hasSample = lessons.some((l) => l.is_sample);
    if (lessons.length < 2 || !hasSample) {
      throw new Error('完整版未导入：请先用 import_course 导入含全部天数的完整包（保留样课标记），再 complete');
    }
    // 确认哈希：样课确认仍有效且与请求批准一致（导入途中样课被重确认/过期 → 拒绝完成）
    if (!course.sample_confirmed_at || course.sample_content_hash !== req.sample_content_hash) {
      throw new Error('样课确认已过期或与请求批准不一致：请让用户重新确认样课并重新发起生成请求');
    }
    // 完整天数：绑定了计划的课程须覆盖计划的全部天数（N 天计划 = 第 1..N 天讲义齐备）；
    // 未绑计划退化为连续性校验（第 1..N 天无缺口）。
    // 绑定计划已删除（或已无任何天）时必须拒绝——不得退化为连续性校验，否则删计划即可掩护短包 complete
    const days = lessons.map((l) => l.day).sort((a, b) => a - b);
    const contiguous = days.every((d, i) => d === i + 1);
    let expectedDays = 0;
    if (course.plan_id != null) {
      const planRow = db.prepare('SELECT id FROM study_plans WHERE id = ?').get(course.plan_id);
      expectedDays = Number(
        (db.prepare('SELECT COUNT(DISTINCT date) AS n FROM plan_items WHERE plan_id = ?').get(course.plan_id) as { n?: number } | undefined)?.n ?? 0,
      );
      if (!planRow || expectedDays === 0) {
        throw new Error(`绑定计划已删除或无有效天数（plan_id=${course.plan_id}）：无法核验完整天数，拒绝 complete；须由用户重建学习计划后重新发起`);
      }
    }
    if (expectedDays > 0 && (days.length !== expectedDays || !contiguous)) {
      throw new Error(
        `完整版天数不完整：绑定计划共 ${expectedDays} 天，当前讲义仅 ${days.length} 天（${days.join('、')}），须补齐第 1..${expectedDays} 天再 complete`,
      );
    }
    if (!contiguous) {
      throw new Error(`完整版天数不完整：须为第 1..N 天连续讲义（当前 ${days.join('、')}），请补齐缺的天再 complete`);
    }
    db.prepare("UPDATE course_requests SET status = 'done', completed_at = ? WHERE id = ?").run(nowIso(), requestId);
    db.prepare("UPDATE courses SET status = 'complete', updated_at = ? WHERE id = ?").run(nowIso(), req.course_id);
    return mapReq(db.prepare('SELECT * FROM course_requests WHERE id = ?').get(requestId)!);
  };

  /** 删除课程及其从属数据；资产先隔离，数据库失败则归还，提交后再清理隔离目录。 */
  const remove = (courseId: number, expectedSlug: string) => {
    let assets: string | null = null;
    let isolated: string | null = null;
    let result: { course_id: number; slug: string; title: string; deleted_lessons: number; deleted_requests: number; detached_drafts: number };
    try {
      result = inTx(db, () => {
        const course = getCourse(courseId);
        if (course.slug !== expectedSlug) throw new Error('课程标识与确认目标不一致，拒绝删除');
        if (!SLUG_RE.test(course.slug)) throw new Error('课程标识不安全，拒绝删除');
        assertDirNotSymlink(root, '课程资产根目录');
        assets = resolve(root, course.slug);
        assertDirNotSymlink(assets, '课程资产目录');
        const deletedLessons = listLessons(courseId).length;
        const deletedRequests = listRequests({ course_id: courseId }).length;
        if (existsSync(assets)) {
          isolated = join(root, `.deleted-${courseId}-${randomUUID()}`);
          renameSync(assets, isolated);
        }
        const detached = db.prepare('UPDATE study_plan_drafts SET course_id = NULL WHERE course_id = ?').run(courseId);
        // 讲义（含已读、自测）、总览和请求经外键级联删除，计划与待办有独立删除入口。
        db.prepare('DELETE FROM courses WHERE id = ?').run(courseId);
        return { course_id: courseId, slug: course.slug, title: course.title, deleted_lessons: deletedLessons, deleted_requests: deletedRequests, detached_drafts: detached.changes };
      });
    } catch (error) {
      if (isolated && assets && existsSync(isolated)) renameSync(isolated, assets);
      throw error;
    }
    let cleanupWarning: string | undefined;
    if (isolated) {
      try { rmSync(isolated, { recursive: true, force: true }); }
      catch { cleanupWarning = `课程记录已删除，隔离资产暂未清理：${isolated}`; }
    }
    return { ...result, assets_removed: !cleanupWarning, cleanup_warning: cleanupWarning };
  };

  return {
    importCourse,
    listCourses,
    getCourse,
    listLessons,
    getOverview,
    getLesson,
    readOverviewHtml,
    readLessonHtml,
    markLessonRead,
    submitQuiz,
    confirmSample,
    createGenerationRequest,
    listRequests,
    claimRequest,
    completeRequest,
    remove,
    coursesRoot: root,
  };
}

export type CourseService = ReturnType<typeof createCourseService>;
