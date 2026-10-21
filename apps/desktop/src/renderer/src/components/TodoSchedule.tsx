import type { ReactNode } from 'react';
// 新建和行内编辑共用日期与时段输入。
export interface TodoScheduleValue {
  due: string;
  dateOnly: boolean;
  start: string;
  end: string;
  endDate?: string;
}

function ScheduleField({ label, showLabel, children }: { label: string; showLabel: boolean; children: ReactNode }) {
  return showLabel ? <label><span>{label}</span>{children}</label> : <>{children}</>;
}

export default function TodoSchedule({ value, onChange, editing = false, showLabels = false }: {
  value: TodoScheduleValue;
  onChange: (value: TodoScheduleValue) => void;
  editing?: boolean;
  showLabels?: boolean;
}) {
  const prefix = editing ? '编辑' : '';
  const endDateField = <ScheduleField label="结束日期（跨日可选）" showLabel={showLabels}><input className="chip-date" type="date" title="结束日期（可选）" aria-label={`${prefix}结束日期（可选）`} value={value.endDate ?? ''}
    onChange={(e) => onChange({ ...value, endDate: e.target.value })} /></ScheduleField>;
  return (
    <div className="todo-schedule">
      <ScheduleField label="安排日期" showLabel={showLabels}><input className="chip-date" type="date" aria-label={`${prefix}安排日期`} value={value.due}
        onChange={(e) => onChange({ ...value, due: e.target.value })} />
      </ScheduleField>
      <ScheduleField label="时间安排" showLabel={showLabels}><select className="chip-select" aria-label={`${prefix}时间安排`} value={value.dateOnly ? 'date' : 'time'}
        onChange={(e) => onChange({ ...value, dateOnly: e.target.value === 'date' })}>
        <option value="time">时间段</option>
        <option value="date">仅日期</option>
      </select></ScheduleField>
      {!showLabels && <span className="sub">结束日期</span>}
      {!showLabels && endDateField}
      {!value.dateOnly && <>
        <ScheduleField label="开始时间" showLabel={showLabels}><input className="chip-date todo-time" type="time" aria-label={`${prefix}开始时间`} value={value.start}
          onChange={(e) => onChange({ ...value, start: e.target.value })} /></ScheduleField>
        {!showLabels && <span className="sub" aria-hidden="true">至</span>}
        <ScheduleField label="结束时间（可选）" showLabel={showLabels}><input className="chip-date todo-time" type="time" aria-label={`${prefix}结束时间`} value={value.end}
          onChange={(e) => onChange({ ...value, end: e.target.value })} /></ScheduleField>
      </>}
      {showLabels && endDateField}
    </div>
  );
}
