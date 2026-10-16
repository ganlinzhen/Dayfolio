// 新建和行内编辑共用日期与时段输入。
export interface TodoScheduleValue {
  due: string;
  dateOnly: boolean;
  start: string;
  end: string;
  endDate?: string;
}

export default function TodoSchedule({ value, onChange, editing = false }: {
  value: TodoScheduleValue;
  onChange: (value: TodoScheduleValue) => void;
  editing?: boolean;
}) {
  const prefix = editing ? '编辑' : '';
  return (
    <div className="todo-schedule">
      <input className="chip-date" type="date" aria-label={`${prefix}安排日期`} value={value.due}
        onChange={(e) => onChange({ ...value, due: e.target.value })} />
      <select className="chip-select" aria-label={`${prefix}时间安排`} value={value.dateOnly ? 'date' : 'time'}
        onChange={(e) => onChange({ ...value, dateOnly: e.target.value === 'date' })}>
        <option value="time">时间段</option>
        <option value="date">仅日期</option>
      </select>
      <span className="sub">结束日期</span>
      <input className="chip-date" type="date" title="结束日期（可选）" aria-label={`${prefix}结束日期（可选）`} value={value.endDate ?? ''}
        onChange={(e) => onChange({ ...value, endDate: e.target.value })} />
      {!value.dateOnly && <>
        <input className="chip-date todo-time" type="time" aria-label={`${prefix}开始时间`} value={value.start}
          onChange={(e) => onChange({ ...value, start: e.target.value })} />
        <span className="sub" aria-hidden="true">至</span>
        <input className="chip-date todo-time" type="time" aria-label={`${prefix}结束时间`} value={value.end}
          onChange={(e) => onChange({ ...value, end: e.target.value })} />
      </>}
    </div>
  );
}
