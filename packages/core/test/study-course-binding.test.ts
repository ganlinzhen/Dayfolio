import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openNodeSqliteDb } from '../src/adapters/node-sqlite';
import type { TodoDeskCore } from '../src';
import { mkCore } from './helpers';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach((cleanup) => cleanup()));

function setup() {
  const ctx = mkCore();
  cleanups.push(ctx.cleanup);
  const stage = mkdtempSync(join(tmpdir(), 'dayfolio-course-binding-'));
  cleanups.push(() => rmSync(stage, { recursive: true, force: true }));
  mkdirSync(join(stage, 'lessons'));
  writeFileSync(join(stage, 'lessons/d1.html'), '<h1>关联测试样课</h1>');
  writeFileSync(join(stage, 'course.json'), JSON.stringify({
    slug: 'course-binding', title: '关联测试课程', version: '1.0.0',
    lessons: [{ day: 1, title: '第一课', html: 'lessons/d1.html', is_sample: true }],
  }));
  const course = ctx.core.courses.importCourse(stage).course;
  const db = openNodeSqliteDb(ctx.dbPath);
  cleanups.push(() => db.close());
  return { ...ctx, db, course };
}

function schedule(core: TodoDeskCore, courseId: number) {
  const draft = core.study.draftDateless({
    title: '课程学习计划', course_id: courseId,
    knowledge_points: [{ key: 'intro', name: '入门', est_minutes: 30 }],
  });
  core.study.scheduleDraft(draft.id, '2026-12-01', 60);
  return draft;
}

describe('草案确认与课程绑定', () => {
  it('排期不绑定；确认后课程指向正式计划，重复确认不重复建计划或待办', () => {
    const { core, course } = setup();
    const draft = schedule(core, course.id);
    expect(core.courses.getCourse(course.id).plan_id).toBeNull();
    const result = core.study.confirmDraft(draft.id);
    expect(result.draft.plan_id).toBe(result.plan.id);
    expect(core.courses.getCourse(course.id)).toMatchObject({ plan_id: result.plan.id, status: 'imported', sample_confirmed_at: null });
    expect(core.study.confirmDraft(draft.id).plan.id).toBe(result.plan.id);
    expect(core.plans.list()).toHaveLength(1);
    expect(core.todos.list()).toHaveLength(1);
  });

  it('已确认的旧草案可补齐缺失绑定，保留计划、待办、打卡与课程阅读确认', () => {
    const { core, db, course } = setup();
    core.courses.markLessonRead(course.id, 1);
    core.commands.human.confirmCourseSample(course.id);
    const draft = schedule(core, course.id);
    const { plan } = core.study.confirmDraft(draft.id);
    core.plans.updateItemStatus(plan.items[0].id, 'done');
    // 仅在隔离库模拟旧版已建计划但漏写 courses.plan_id 的数据。
    db.prepare('UPDATE courses SET plan_id = NULL WHERE id = ?').run(course.id);
    const before = {
      plan: core.plans.get(plan.id), todos: core.todos.list({ status: 'all' }),
      lessons: core.courses.listLessons(course.id), course: core.courses.getCourse(course.id),
      checkins: db.prepare('SELECT * FROM checkins').all(),
    };
    const repaired = core.study.confirmDraft(draft.id);
    expect(repaired.plan).toEqual(before.plan);
    expect(core.todos.list({ status: 'all' })).toEqual(before.todos);
    expect(core.courses.listLessons(course.id)).toEqual(before.lessons);
    expect(db.prepare('SELECT * FROM checkins').all()).toEqual(before.checkins);
    expect(core.courses.getCourse(course.id)).toEqual({ ...before.course, plan_id: plan.id, updated_at: expect.any(String) });
    expect(core.plans.list()).toHaveLength(1);
  });

  it('课程已绑定其他计划时拒绝确认，回滚新计划、待办和草案状态', () => {
    const { core, course } = setup();
    const first = schedule(core, course.id);
    const bound = core.study.confirmDraft(first.id).plan;
    const second = schedule(core, course.id);
    expect(() => core.study.confirmDraft(second.id)).toThrow('不得改绑');
    expect(core.study.getDraft(second.id)).toMatchObject({ status: 'draft', plan_id: null });
    expect(core.courses.getCourse(course.id).plan_id).toBe(bound.id);
    expect(core.plans.list()).toHaveLength(1);
    expect(core.todos.list()).toHaveLength(1);
  });

  it('课程绑定写入失败时不留下已确认草案或新计划待办', () => {
    const { core, db, course } = setup();
    const draft = schedule(core, course.id);
    db.exec("CREATE TRIGGER reject_course_binding BEFORE UPDATE OF plan_id ON courses BEGIN SELECT RAISE(ABORT, '模拟关联失败'); END");
    expect(() => core.study.confirmDraft(draft.id)).toThrow('模拟关联失败');
    expect(core.study.getDraft(draft.id)).toMatchObject({ status: 'draft', plan_id: null, confirmed_at: null });
    expect(core.courses.getCourse(course.id).plan_id).toBeNull();
    expect(core.plans.list()).toHaveLength(0);
    expect(core.todos.list()).toHaveLength(0);
    db.exec('DROP TRIGGER reject_course_binding');
    expect(core.study.confirmDraft(draft.id).plan.id).toBe(core.courses.getCourse(course.id).plan_id);
  });

  it('修复旧草案时遇到其他计划绑定则拒绝，保留原计划和现有关联', () => {
    const { core, db, course } = setup();
    const draft = schedule(core, course.id);
    const original = core.study.confirmDraft(draft.id).plan;
    const other = core.plans.create({ title: '其他计划', start_date: '2026-12-03', items: [{ date: '2026-12-03', content: '其他任务' }] });
    db.prepare('UPDATE courses SET plan_id = ? WHERE id = ?').run(other.id, course.id);
    expect(() => core.study.confirmDraft(draft.id)).toThrow('不得改绑');
    expect(core.plans.get(original.id)).toEqual(original);
    expect(core.courses.getCourse(course.id).plan_id).toBe(other.id);
    expect(core.plans.list()).toHaveLength(2);
    expect(core.todos.list()).toHaveLength(2);
  });
});
