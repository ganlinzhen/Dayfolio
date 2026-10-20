import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mkCore } from './helpers';
import { todayStr, addDays } from '../src/utils/date';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach(fn => fn()));

function setup() {
  const ctx = mkCore(); cleanups.push(ctx.cleanup);
  const date = todayStr();
  const plan = ctx.core.plans.create({ title: '学习进度验收', start_date: date, create_todos: false, items: [
    { date, content: '第一项', knowledge_key: 'intro' },
    { date, content: '同一天第二项', knowledge_key: 'intro' },
    { date: addDays(date, 1), content: '未生成的第二天', knowledge_key: 'next' },
  ] });
  const stage = mkdtempSync(join(tmpdir(), 'dayfolio-progress-course-'));
  cleanups.push(() => rmSync(stage, { recursive: true, force: true }));
  mkdirSync(join(stage, 'lessons'));
  writeFileSync(join(stage, 'lessons/d1.html'), '<main>进度测试</main>');
  writeFileSync(join(stage, 'course.json'), JSON.stringify({ slug: 'progress-course', title: '进度课程', version: '1.0.0', plan_id: plan.id,
    lessons: [{ day: 1, title: '第一课', html: 'lessons/d1.html', is_sample: true, quiz: [
      { id: 'q1', question: '第一题', options: ['甲', '乙'], answer_index: 0, explanation: '甲' },
      { id: 'q2', question: '第二题', options: ['甲', '乙'], answer_index: 1, explanation: '乙' },
    ] }],
  }));
  const course = ctx.core.courses.importCourse(stage).course;
  return { ...ctx, plan, course };
}

describe('学习进度聚合', () => {
  it('阅读和自测按日期共用，部分作答不算已做；跳过与打卡不伪造学习进度', () => {
    const { core, plan, course } = setup();
    core.plans.updateItemStatus(plan.items[0].id, 'done');
    core.plans.updateItemStatus(plan.items[2].id, 'skipped');
    expect(core.study.getProgress(plan.id)[0]).toMatchObject({ total_items: 3, read_items: 0, assessed_items: 0, noted_items: 0 });
    core.courses.markLessonRead(course.id, 1);
    core.courses.submitQuiz(course.id, 1, [{ question_id: 'q1', picked: 0 }]);
    expect(core.study.getProgress(plan.id)[0]).toMatchObject({ read_items: 2, assessed_items: 0 });
    expect(core.study.getProgress(plan.id)[0].items[2]).toMatchObject({ course_day: 2, lesson_status: 'pending' });
    core.courses.submitQuiz(course.id, 1, [{ question_id: 'q1', picked: 0 }, { question_id: 'q2', picked: 1 }]);
    expect(core.study.getProgress(plan.id)[0]).toMatchObject({ read_items: 2, assessed_items: 2 });
    expect(core.plans.get(plan.id).done_items).toBe(1);
    expect(core.study.getMastery({ plan_id: plan.id }).entries.every(e => e.mastery === 'unknown')).toBe(true);
  });

  it('笔记和测评按条目隔离，可从会话定位测评；同名知识点不互相污染', () => {
    const { core, plan } = setup();
    const session = core.study.recordSession({ plan_item_id: plan.items[0].id, knowledge_key: 'intro', actual_minutes: 5, explanation: '用自己的话解释' });
    core.study.recordSession({ plan_id: plan.id, plan_item_id: plan.items[1].id, knowledge_key: 'intro', actual_minutes: 1, explanation: ' \n\t ' });
    core.study.recordAssessment({ session_id: session.id, knowledge_key: 'intro', question: '为什么', answer: '我的解释', source: 'ai_suggestion' });
    const progress = core.study.getProgress(plan.id)[0];
    expect(progress).toMatchObject({ noted_items: 1, assessed_items: 1 });
    expect(progress.items[0]).toMatchObject({ note_count: 1, assessment_count: 1 });
    expect(progress.items[1]).toMatchObject({ note_count: 0, assessment_count: 0 });
    expect(core.study.getMastery({ plan_id: plan.id }).entries.every(e => e.mastery === 'unknown')).toBe(true);
  });

  it('没有课程时明确未关联，删除课程后保留条目笔记与进度', () => {
    const { core, plan, course } = setup();
    core.study.recordSession({ plan_id: plan.id, plan_item_id: plan.items[0].id, knowledge_key: 'intro', actual_minutes: 5, explanation: '独立笔记' });
    core.courses.remove(course.id, course.slug);
    const progress = core.study.getProgress(plan.id)[0];
    expect(progress.noted_items).toBe(1);
    expect(progress.items.every(i => i.lesson_status === 'unbound' && i.course_id === null)).toBe(true);
  });
});
