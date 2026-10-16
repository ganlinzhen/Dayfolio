import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ensureOnboardingCourse } from '../../../apps/desktop/src/main/onboarding-course';
import { mkCore } from './helpers';

const source = fileURLToPath(new URL('../../../apps/onboarding/', import.meta.url));

describe('正式 App 随包上手课程', () => {
  it('空库自动收录样课与独立总览，不创建计划或待办，也不代确认', () => {
    const { core, cleanup } = mkCore();
    try {
      ensureOnboardingCourse(core, source);
      const courses = core.courses.listCourses();
      expect(courses).toHaveLength(1);
      const course = courses[0];
      expect(course).toMatchObject({ slug: 'tododesk-tour', plan_id: null, sample_confirmed_at: null });
      expect(core.courses.listLessons(course.id)).toHaveLength(1);
      expect(core.courses.getLesson(course.id, 1).estimated_minutes).toBe(5);
      expect(core.courses.readOverviewHtml(core.courses.getOverview(course.id)!)).toContain('你会学到什么');
      expect(core.plans.list()).toHaveLength(0);
      expect(core.todos.list({})).toHaveLength(0);
    } finally { cleanup(); }
  });

  it('升级时为已有数据补入课程，重启或随包内容变化不覆盖既有内容与进度', () => {
    const { core, dbPath, cleanup } = mkCore();
    try {
      const todo = core.todos.add({ title: '保留我的任务' });
      ensureOnboardingCourse(core, source);
      const course = core.courses.listCourses()[0];
      core.courses.markLessonRead(course.id, 1);
      core.commands.human.confirmCourseSample(course.id);
      const before = core.courses.getLesson(course.id, 1);
      const confirmed = core.courses.listCourses()[0].sample_confirmed_at;
      const changedSource = join(dirname(dbPath), 'new-bundle');
      mkdirSync(changedSource);
      cpSync(source, changedSource, { recursive: true });
      const lessonFile = join(changedSource, 'lessons/0001-quick-tour.html');
      writeFileSync(lessonFile, readFileSync(lessonFile, 'utf8') + '<p>新的随包正文</p>');
      ensureOnboardingCourse(core, changedSource);
      ensureOnboardingCourse(core, source);
      expect(core.courses.listCourses()).toHaveLength(1);
      expect(core.courses.getLesson(course.id, 1)).toEqual(before);
      expect(core.courses.readLessonHtml(before)).not.toContain('新的随包正文');
      expect(core.courses.listCourses()[0].sample_confirmed_at).toBe(confirmed);
      expect(core.todos.list({}).map((item) => item.id)).toContain(todo.id);
    } finally { cleanup(); }
  });
});
