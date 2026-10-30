import ActionButton from './ActionButton';
import { IconChevronLeft } from './icons';
// 打卡面板：连续天数、近 28 天热力点与打卡记录（Codex 风格）
// 2026-10-14 起手动「每日打卡」入口移除：记录由完成待办/学习条目打卡自动产生
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, call } from '../api';
import EmptyState from './EmptyState';
import { IconCheck, IconFlame } from './icons';

interface CheckinRecord {
  id: number;
  ref_type: 'todo' | 'plan_item' | 'day';
  date: string;
  created_at: string;
  note: string;
  description: string;
}

interface Stats {
  streak: number;
  active_days_last_7: number;
  active_days_last_30: number;
  total_checkins: number;
}

const REF_LABEL: Record<string, string> = { day: '每日', todo: '待办', plan_item: '计划' };

export default function CheckinPanel({ onBack }: { onBack: () => void }) {
  const [records, setRecords] = useState<CheckinRecord[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [list, s] = await Promise.all([
        call<CheckinRecord[]>(() => api.checkins.list({ limit: 60 })),
        call<Stats>(() => api.checkins.stats()),
      ]);
      setRecords(list);
      setStats(s);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 近 28 天热力点（旧→新）
  const heatmap = useMemo(() => {
    const days = new Set(records.map((r) => r.date));
    return Array.from({ length: 28 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (27 - i));
      const ds = d.toLocaleDateString('sv-SE');
      return { date: ds, active: days.has(ds) };
    });
  }, [records]);

  return (
    <div className="panel work-panel" role="region" aria-label="打卡记录">
      <header className="panel-head">
        <ActionButton icon={IconChevronLeft} className="btn" onClick={onBack}>返回待办</ActionButton>
        <span className="panel-context">打卡记录</span>
        <span className="spacer" />
        <div className="head-meta mono">累计 {stats?.total_checkins ?? 0} 次</div>
      </header>

      <div className="checkin-hero">
        <div className="checkin-activity">
          <div className="checkin-streak"><span className="streak-label">连续打卡</span><strong className="streak-num">{stats?.streak ?? 0}</strong><span className="streak-label">天</span></div>
          <div className="heat-row">
            {heatmap.map((c) => (
              <span key={c.date} className={`heat-dot ${c.active ? 'on' : ''}`} title={c.date} />
            ))}
          </div>
          <div className="sub mono">近 7 天活跃 {stats?.active_days_last_7 ?? 0} 天，近 30 天 {stats?.active_days_last_30 ?? 0} 天</div>
        </div>
      </div>

      {error && <div className="notice error">{error}</div>}

      <section className="group">
        <div className="group-label mono">最近记录<span className="group-count">{records.length}</span></div>
        {records.length === 0 && (
          <EmptyState
            icon={<IconFlame width={18} height={18} />}
            title="还没有打卡记录"
            hint="完成待办、打卡学习条目，记录都会自动出现在这里。"
          />
        )}
        {records.map((r) => (
          <div key={r.id} className="todo-card checkin-card">
            <div className="todo-card-main">
              <span className={`ref-badge mono ${r.ref_type}`}>{REF_LABEL[r.ref_type]}</span>
              <span className="checkin-desc">{r.description}</span>
              <IconCheck className="subtle-icon" width={13} height={13} />
            </div>
            <div className="todo-card-meta">
              <time className="todo-meta mono" dateTime={r.created_at}>{r.created_at.replace('T', ' ').slice(0, 19)}</time>
              {r.date !== r.created_at.slice(0, 10) && <span className="sub">补记 {r.date}</span>}
              {r.note && <span className="sub">{r.note}</span>}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
