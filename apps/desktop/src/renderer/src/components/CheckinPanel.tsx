// 打卡面板：连续天数、近 28 天热力点、每日打卡（Codex 风格）
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, call } from '../api';
import EmptyState from './EmptyState';
import { IconCheck, IconFlame } from './icons';

interface CheckinRecord {
  id: number;
  ref_type: 'todo' | 'plan_item' | 'day';
  date: string;
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

export default function CheckinPanel() {
  const [records, setRecords] = useState<CheckinRecord[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [note, setNote] = useState('');
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

  const dayCheckin = async () => {
    await call(() => api.checkins.checkin({ ref_type: 'day', note }));
    setNote('');
    await refresh();
  };

  const today = new Date().toLocaleDateString('sv-SE');
  const checkedToday = records.some((r) => r.date === today && r.ref_type === 'day');

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
    <div className="panel">
      <header className="panel-head">
        <h1>打卡</h1>
        <div className="head-meta mono">累计 {stats?.total_checkins ?? 0} 次</div>
      </header>

      <div className="checkin-hero">
        <div className="streak-num serif">{stats?.streak ?? 0}</div>
        <div className="streak-label">连续打卡天数</div>
        <div className="heat-row">
          {heatmap.map((c) => (
            <span key={c.date} className={`heat-dot ${c.active ? 'on' : ''}`} title={c.date} />
          ))}
        </div>
        <div className="sub mono">近 7 天活跃 {stats?.active_days_last_7 ?? 0} 天，近 30 天 {stats?.active_days_last_30 ?? 0} 天</div>
        <div className="day-checkin">
          <input placeholder="今日备注（可选）" aria-label="今日打卡备注" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className={`btn ${checkedToday ? '' : 'primary'}`} disabled={checkedToday} onClick={() => void dayCheckin()}>
            {checkedToday ? '今日已打卡' : '每日打卡'}
          </button>
        </div>
      </div>

      {error && <div className="notice error">{error}</div>}

      <section className="group">
        <div className="group-label mono">最近记录<span className="group-count">{records.length}</span></div>
        {records.length === 0 && (
          <EmptyState
            icon={<IconFlame width={18} height={18} />}
            title="还没有打卡记录"
            hint="完成待办、打卡学习条目，或在上方点「每日打卡」，记录都会出现在这里。"
          />
        )}
        {records.map((r) => (
          <div key={r.id} className="checkin-row">
            <span className={`ref-badge mono ${r.ref_type}`}>{REF_LABEL[r.ref_type]}</span>
            <span className="checkin-desc">{r.description}</span>
            <span className="spacer" />
            {r.note && <span className="sub">{r.note}</span>}
            <span className="todo-meta mono">{r.date}</span>
            <IconCheck className="subtle-icon" width={13} height={13} />
          </div>
        ))}
      </section>
    </div>
  );
}
