import type { ToolRegistrar, McpContext } from '../shared/context';
import { z } from 'zod';
import { wrap } from '../shared/response';

export function registerTools(server: ToolRegistrar, { core }: McpContext): void {
  server.tool(
    'delete_course',
    '用户明确确认删除某门课程时调用。永久删除该课程的总览、全部讲义、阅读与自测记录、生成请求及课程资产，解除学习草案对课程的引用；保留学习计划及其待办，删除计划请另用 delete_study_plan。不可恢复，请先核对 list_courses 的 ID、slug、标题并与用户确认；expected_slug 必须匹配确认目标',
    { course_id: z.number().int().positive(), expected_slug: z.string().min(1) },
    async ({ course_id, expected_slug }) => wrap(() => core.courses.remove(course_id, expected_slug))(),
  );

  // ---------- 教学课程（v6：导入/阅读/确认/生成请求队列，agent 可发现并处理待执行请求） ----------

  server.tool(
    'import_course',
    '导入教学课程包（staging 目录根须含 course.json、独立总览 HTML 与 D1..Dn 讲义 HTML）。新包请声明 schema_version: 2 和 overview: {"html":"overview.html"}；v2 强制总览单独生成，D1 只写第一天教学内容，不要把总览塞进 D1。无 schema_version 的旧包仍可导入，缺总览时 App 显示待生成；补充总览时带 overview.html 重导样课包即可，不会改写已生成的其他天。安全：路径穿越与符号链接拒绝、HTML 消毒、包内相对 CSS 内联并移除外部资源；幂等（同内容且磁盘文件一致才无变更，缺文件自动修复）；样课变更会使既有确认过期。绑定既有 plan_id 只引用不创建计划（须已存在；已绑定课程不得改绑，省略表示沿用）。课程包必须恰好含一个 is_sample 样课标记（样课包仅样课一天；完整包保留标记）。完整包仅在用户已确认样课、生成请求已被认领且样课正文与确认版本逐字节一致时放行；已完成课程同内容重导可幂等修复',
    { staging_dir: z.string().min(1).describe('课程包 staging 目录绝对路径（包根含 course.json）') },
    async ({ staging_dir }) =>
      wrap(() => {
        const r = core.courses.importCourse(staging_dir);
        return {
          course_id: r.course.id, slug: r.course.slug, status: r.course.status, plan_id: r.course.plan_id,
          has_overview: core.courses.getOverview(r.course.id) != null,
          lessons: r.lessons.map((l) => ({ day: l.day, title: l.title, revision: l.revision, is_sample: l.is_sample, estimated_minutes: l.estimated_minutes })),
          idempotent: r.idempotent,
          confirmation_expired: r.confirmation_expired,
          hint: r.confirmation_expired ? '样课内容已变更：用户先前的确认已过期，请用户在 App 阅读后回到对话重新确认' : undefined,
        };
      })(),
  );

  server.tool(
    'list_courses',
    '查询已导入的课程（含大纲/状态/绑定计划/样课确认状态与待执行请求数）',
    {},
    wrap(() =>
      core.courses.listCourses().map((c) => ({
        ...c,
        has_overview: core.courses.getOverview(c.id) != null,
        pending_requests: core.courses.listRequests({ course_id: c.id, status: 'pending' }).length,
        lesson_days: core.courses.listLessons(c.id).map((l) => l.day),
      })),
    ),
  );

  server.tool(
    'get_course_overview',
    '读取独立课程总览的已消毒 HTML（不属于 D1..Dn，也不计入每日讲义进度）；旧课程尚未生成总览时返回 null',
    { course_id: z.number().int().positive() },
    async ({ course_id }) => wrap(() => {
      const overview = core.courses.getOverview(course_id);
      return overview ? { overview, html: core.courses.readOverviewHtml(overview) } : null;
    })(),
  );

  server.tool(
    'get_course_lessons',
    '查询课程全部讲义元数据（day/标题/revision 逐课版本号/样课/概念/代码导读/答题状态）。revision 从 1 开始，正文或教学资料实际更新才递增；重复导入与阅读答题不递增，由导入服务维护',
    { course_id: z.number().int().positive() },
    async ({ course_id }) => wrap(() => core.courses.listLessons(course_id))(),
  );

  server.tool(
    'get_lesson_html',
    '读取某天讲义的已消毒 HTML 正文（App 同源；路径越界拒绝）',
    { course_id: z.number().int().positive(), day: z.number().int().positive() },
    async ({ course_id, day }) =>
      wrap(() => {
        const lesson = core.courses.getLesson(course_id, day);
        return { lesson, html: core.courses.readLessonHtml(lesson) };
      })(),
  );

  server.tool(
    'submit_lesson_quiz',
    '提交某天自测答案（学习痕迹，非掌握证据——内容生成与答题不算掌握，掌握仍走 record_study_assessment）',
    {
      course_id: z.number().int().positive(),
      day: z.number().int().positive(),
      answers: z.array(z.object({ question_id: z.string(), picked: z.number().int().nonnegative() })).min(1),
    },
    async ({ course_id, day, answers }) => wrap(() => core.courses.submitQuiz(course_id, day, answers))(),
  );

  server.tool(
    'confirm_course_sample',
    '仅当用户在对话中明确同意当前样课后，记录该确认。先通过 get_course_lessons 获取样课 content_hash，用户须已在 App 打开阅读；确认绑定该版本，内容变更后须重新阅读并询问。不得根据导入、已读或旧版同意自动确认。用户若同时要求生成完整版，确认成功后继续 create_course_request → claim → 生成 → import → complete，无需回 App 点击按钮',
    {
      course_id: z.number().int().positive(),
      sample_content_hash: z.string().regex(/^[a-f0-9]{64}$/).describe('用户本次同意的样课 content_hash（来自 get_course_lessons）'),
      confirmed: z.literal(true).describe('用户已在本次对话中明确确认该课程当前样课，才可传 true'),
    },
    async ({ course_id, sample_content_hash }) => wrap(() => {
      const sample = core.courses.listLessons(course_id).find((lesson) => lesson.is_sample);
      if (!sample || sample.content_hash !== sample_content_hash) {
        throw new Error('样课版本已变更或不存在：请用户在 App 阅读当前样课后，在对话中重新确认');
      }
      // 此专用工具承接用户在对话中的明确确认；通用本体动作仍不能代替人工确认。
      return core.commands.human.confirmCourseSample(course_id, sample_content_hash);
    })(),
  );

  server.tool(
    'create_course_request',
    '为已确认样课的课程创建完整版生成请求（排队待执行，非立即生成）。仅样课已确认且未过期时允许；幂等（已有 pending 不重复）。生成由外部 agent 认领处理（list_course_requests → claim → 生成 → import 完整包 → complete）',
    { course_id: z.number().int().positive(), requested_by: z.string().optional() },
    async ({ course_id, requested_by }) => wrap(() => core.courses.createGenerationRequest(course_id, requested_by ?? 'mcp'))(),
  );

  server.tool(
    'list_course_requests',
    '查询课程生成请求队列（默认全部；可按状态过滤）——agent 定期查 pending 即可发现待执行请求',
    { status: z.enum(['pending', 'claimed', 'done', 'failed']).optional(), course_id: z.number().int().positive().optional() },
    async (input) => wrap(() => core.courses.listRequests(input))(),
  );

  server.tool(
    'claim_course_request',
    'agent 认领一个 pending 生成请求（claimed；样课哈希与课程确认一致才放行，批准过期拒绝）。认领后生成完整课程包（在 Dayfolio 外），再 import_course 导入完整包，最后 complete_course_request',
    { request_id: z.number().int().positive(), claimed_by: z.string().min(1) },
    async ({ request_id, claimed_by }) => wrap(() => core.courses.claimRequest(request_id, claimed_by))(),
  );

  server.tool(
    'complete_course_request',
    '完成生成请求（须先 import 完整包；claimed→done；课程标记 complete）。校验：样课确认哈希与请求批准一致（过期拒绝）+ 天数为第 1..N 天连续完整（有缺口拒绝；绑定计划的课程须覆盖计划全部天数，绑定计划已删除亦拒绝——删计划/换绑短计划不能掩护短包）。幂等',
    { request_id: z.number().int().positive(), claimed_by: z.string().min(1) },
    async ({ request_id, claimed_by }) => wrap(() => core.courses.completeRequest(request_id, claimed_by))(),
  );
}
