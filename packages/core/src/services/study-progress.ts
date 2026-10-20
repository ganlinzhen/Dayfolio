import type { DbAdapter } from '../db';
import { readSnapshot } from '../db';

export interface ItemLearningProgress {
  item_id: number;
  course_id: number | null;
  course_day: number;
  lesson_status: 'unbound' | 'pending' | 'generated' | 'read';
  quiz_answered: number;
  quiz_total: number;
  assessment_count: number;
  note_count: number;
}

export interface PlanLearningProgress {
  plan_id: number;
  total_items: number;
  read_items: number;
  assessed_items: number;
  noted_items: number;
  items: ItemLearningProgress[];
}

/** 从真实阅读、作答及学习输出聚合，不把打卡或 AI 反馈换算成掌握率。 */
export function getStudyProgress(db: DbAdapter, planId?: number): PlanLearningProgress[] {
  return readSnapshot(db, () => {
    const scope = planId == null ? '' : ' WHERE p.id = ?';
    const params = planId == null ? [] : [planId];
    const plans = db.prepare(`SELECT p.id FROM study_plans p${scope} ORDER BY p.id`).all(...params);
    const rows = db.prepare(`
      WITH dated AS (
        SELECT i.*, DENSE_RANK() OVER (PARTITION BY i.plan_id ORDER BY i.date) AS course_day
        FROM plan_items i JOIN study_plans p ON p.id = i.plan_id${scope}
      ), notes AS (
        SELECT i.plan_id, s.plan_item_id, COUNT(*) AS n FROM study_sessions s
        JOIN plan_items i ON i.id = s.plan_item_id AND (s.plan_id IS NULL OR s.plan_id = i.plan_id)
        WHERE TRIM(s.explanation, char(9) || char(10) || char(13) || ' ') <> '' GROUP BY i.plan_id, s.plan_item_id
      ), assessments AS (
        SELECT i.plan_id, i.id AS item_id, COUNT(*) AS n
        FROM study_assessments a LEFT JOIN study_sessions s ON s.id = a.session_id
        JOIN plan_items i ON i.id = COALESCE(a.plan_item_id, s.plan_item_id)
          AND (a.plan_id IS NULL OR a.plan_id = i.plan_id)
        WHERE TRIM(a.answer) <> '' GROUP BY i.plan_id, i.id
      )
      SELECT d.plan_id, d.id AS item_id, d.course_day, c.id AS course_id,
        l.status AS lesson_status, l.quiz, l.quiz_answers,
        COALESCE(n.n, 0) AS note_count, COALESCE(a.n, 0) AS assessment_count
      FROM dated d
      LEFT JOIN courses c ON c.id = (
        SELECT id FROM courses WHERE plan_id = d.plan_id ORDER BY created_at DESC, id DESC LIMIT 1
      )
      LEFT JOIN course_lessons l ON l.course_id = c.id AND l.day = d.course_day
      LEFT JOIN notes n ON n.plan_id = d.plan_id AND n.plan_item_id = d.id
      LEFT JOIN assessments a ON a.plan_id = d.plan_id AND a.item_id = d.id
      ORDER BY d.plan_id, d.date, d.sort_order, d.id
    `).all(...params);
    const grouped = new Map<number, PlanLearningProgress>(plans.map(p => [Number(p.id), {
      plan_id: Number(p.id), total_items: 0, read_items: 0, assessed_items: 0, noted_items: 0, items: [],
    }]));
    for (const row of rows) {
      const quiz = JSON.parse(String(row.quiz ?? '[]')) as Array<{ id: string }>;
      const answers = JSON.parse(String(row.quiz_answers ?? '[]')) as Array<{ question_id: string }>;
      const answered = new Set(answers.map(a => a.question_id));
      const item: ItemLearningProgress = {
        item_id: Number(row.item_id), course_id: row.course_id == null ? null : Number(row.course_id),
        course_day: Number(row.course_day),
        lesson_status: row.course_id == null ? 'unbound' : row.lesson_status == null ? 'pending' : row.lesson_status as ItemLearningProgress['lesson_status'],
        quiz_answered: quiz.filter(q => answered.has(q.id)).length, quiz_total: quiz.length,
        note_count: Number(row.note_count), assessment_count: Number(row.assessment_count),
      };
      const plan = grouped.get(Number(row.plan_id))!;
      plan.items.push(item);
      plan.total_items++;
      if (item.lesson_status === 'read') plan.read_items++;
      if (item.assessment_count > 0 || (item.quiz_total > 0 && item.quiz_answered === item.quiz_total)) plan.assessed_items++;
      if (item.note_count > 0) plan.noted_items++;
    }
    return [...grouped.values()];
  });
}
