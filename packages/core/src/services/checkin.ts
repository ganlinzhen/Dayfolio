// 打卡服务：打卡记录（幂等）、连续天数、统计
import type { DbAdapter } from '../db';
import { mapCheckin } from '../db';
import type { Checkin, CheckinRefType } from '../types';
import { addDays, nowIso, todayStr, ensureValidDateStr } from '../utils/date';

export function createCheckinService(db: DbAdapter) {
  /** 打卡（幂等）：同引用同一天只记一条，重复打卡会刷新备注 */
  const checkin = (input: {
    ref_type: CheckinRefType;
    ref_id?: number;
    date?: string;
    note?: string;
  }): Checkin => {
    const refId = input.ref_id ?? 0;
    const date = input.date ?? todayStr();
    ensureValidDateStr(date);
    if(!['todo','plan_item','day'].includes(input.ref_type))throw new Error('打卡引用类型无效');
    if(input.ref_type !== 'day') {
      const table=input.ref_type==='todo'?'todos':'plan_items';
      if(!Number.isSafeInteger(refId) || !db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(refId))throw new Error('REFERENCE_NOT_FOUND：打卡目标不存在');
    }
    db.prepare(
      `INSERT INTO checkins (ref_type, ref_id, date, note, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(ref_type, ref_id, date) DO UPDATE SET note = excluded.note`,
    ).run(input.ref_type, refId, date, input.note ?? '', nowIso());
    return getRecord(input.ref_type, refId, date)!;
  };

  const getRecord = (refType: CheckinRefType, refId: number, date: string): Checkin | null => {
    const row = db
      .prepare('SELECT * FROM checkins WHERE ref_type = ? AND ref_id = ? AND date = ?')
      .get(refType, refId, date);
    return row ? mapCheckin(row) : null;
  };

  const remove = (refType: CheckinRefType, refId: number, date: string): void => {
    db.prepare('DELETE FROM checkins WHERE ref_type = ? AND ref_id = ? AND date = ?').run(refType, refId, date);
  };

  const list = (opts: { from?: string; to?: string; ref_type?: CheckinRefType; limit?: number } = {}): Checkin[] => {
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    if (opts.from) {
      where.push('date >= ?');
      params.push(opts.from);
    }
    if (opts.to) {
      where.push('date <= ?');
      params.push(opts.to);
    }
    if (opts.ref_type) {
      where.push('ref_type = ?');
      params.push(opts.ref_type);
    }
    params.push(opts.limit && opts.limit > 0 ? opts.limit : 200);
    return db
      .prepare(`SELECT * FROM checkins WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map(mapCheckin);
  };

  /** 连续打卡天数：从今天（或昨天）往前数，连续有打卡记录的天数 */  const streak = (): number => {
    const rows = db.prepare('SELECT DISTINCT date FROM checkins').all();
    const dates = new Set(rows.map((r) => String(r.date)));
    let cur = todayStr();
    if (!dates.has(cur)) {
      cur = addDays(cur, -1);
      if (!dates.has(cur)) return 0;
    }
    let count = 0;
    while (dates.has(cur)) {
      count += 1;
      cur = addDays(cur, -1);
    }
    return count;
  };

  /** 打卡记录（附人读描述：每日打卡 / 完成待办：xx / 计划打卡：xx），供界面与 AI 汇报使用 */
  const listDetailed = (opts: { from?: string; to?: string; limit?: number } = {}): Array<Checkin & { description: string }> => {
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    if (opts.from) {
      where.push('c.date >= ?');
      params.push(opts.from);
    }
    if (opts.to) {
      where.push('c.date <= ?');
      params.push(opts.to);
    }
    params.push(opts.limit && opts.limit > 0 ? opts.limit : 200);
    return db
      .prepare(
        `SELECT c.*,
           CASE c.ref_type
             WHEN 'day' THEN '每日打卡'
             WHEN 'todo' THEN '完成待办：' || COALESCE(t.title, '#' || c.ref_id || '（已删除）')
             WHEN 'plan_item' THEN '计划打卡：' || COALESCE(sp.title || ' · ' || pi.content, '#' || c.ref_id || '（已删除）')
           END AS description
         FROM checkins c
         LEFT JOIN todos t ON c.ref_type = 'todo' AND t.id = c.ref_id
         LEFT JOIN plan_items pi ON c.ref_type = 'plan_item' AND pi.id = c.ref_id
         LEFT JOIN study_plans sp ON sp.id = pi.plan_id
         WHERE ${where.join(' AND ')}
         ORDER BY c.created_at DESC, c.id DESC LIMIT ?`,
      )
      .all(...params)
      .map((r) => ({ ...mapCheckin(r), description: String(r.description) }));
  };

  const stats = () => {
    const t = todayStr();
    const countSince = (from: string) =>
      Number(
        db.prepare('SELECT COUNT(DISTINCT date) AS n FROM checkins WHERE date >= ?').get(from)?.n ?? 0,
      );
    return {
      streak: streak(),
      active_days_last_7: countSince(addDays(t, -6)),
      active_days_last_30: countSince(addDays(t, -29)),
      total_checkins: Number(db.prepare('SELECT COUNT(*) AS n FROM checkins').get()?.n ?? 0),
    };
  };

  return { checkin, getRecord, remove, list, listDetailed, streak, stats };
}

export type CheckinService = ReturnType<typeof createCheckinService>;
