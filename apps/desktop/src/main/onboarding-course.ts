import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TodoDeskCore } from '../../../../packages/core/src';

/** 只补入尚未收录的随包课程；已有课程的讲义、确认、阅读及计划绑定均由原业务流程维护。 */
export function ensureOnboardingCourse(core: TodoDeskCore, sourceDir: string): void {
  const manifest: { slug: string } = JSON.parse(readFileSync(join(sourceDir, 'course.json'), 'utf8'));
  if (core.courses.listCourses().some((course) => course.slug === manifest.slug)) return;
  core.courses.importCourse(sourceDir);
}
