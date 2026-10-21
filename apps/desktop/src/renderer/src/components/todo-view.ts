import type { Todo } from './TodoPanel';
import type { TodoScheduleValue } from './TodoSchedule';

export type DateFilter = 'all' | 'today' | 'overdue' | 'week' | 'unscheduled';
export type TodoSort = 'date' | 'priority' | 'newest';
export const GROUP_ORDER = ['已逾期', '今天', '未来 3 天', '稍后', '无日期', '已完成'];

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d + days).toLocaleDateString('sv-SE');
}

export function matchesDate(todo: Todo, filter: DateFilter, today: string): boolean {
  if (filter === 'all') return true;
  if (filter === 'unscheduled') return !todo.due_date;
  if (filter === 'overdue') return todo.is_overdue;
  if (!todo.due_date) return false;
  const end = todo.end_date ?? todo.due_date;
  if (filter === 'today') return todo.due_date <= today && end >= today;
  return todo.due_date <= addDays(today, 6) && end >= today;
}

export function groupOf(todo: Todo, today: string): string {
  if (todo.status === 'done') return '已完成';
  if (!todo.due_date) return '无日期';
  if (todo.is_overdue) return '已逾期';
  if (matchesDate(todo, 'today', today)) return '今天';
  return todo.due_date <= addDays(today, 3) ? '未来 3 天' : '稍后';
}

const priorityRank = { high: 0, medium: 1, low: 2 };
// 排序只发生在日期分组内部；明确的时段早于同日的仅日期安排。
export function sortTodos(items: Todo[], sort: TodoSort): Todo[] {
  return [...items].sort((a, b) => {
    if (sort === 'newest') return b.id - a.id;
    const byPriority = priorityRank[a.priority] - priorityRank[b.priority];
    const byDate = (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999')
      || (a.start_time ?? '24:00').localeCompare(b.start_time ?? '24:00');
    return (sort === 'priority' ? byPriority || byDate : byDate || byPriority) || a.id - b.id;
  });
}

export function scheduleInput(value: TodoScheduleValue) {
  if (!value.dateOnly && (!value.due || !value.start)) throw new Error('请填写安排日期和开始时间，或切换为「仅日期」。');
  if (value.endDate && (!value.due || value.endDate < value.due)) throw new Error('结束日期不能早于安排日期。');
  if (!value.dateOnly && value.end && `${value.endDate || value.due}T${value.end}` <= `${value.due}T${value.start}`) {
    throw new Error('结束时间须晚于开始时间；跨午夜请设置结束日期。');
  }
  return {
    due_date: value.due || null, end_date: value.endDate || null,
    start_time: value.dateOnly ? null : value.start, end_time: value.dateOnly ? null : value.end || null,
  };
}

export function scheduleOf(todo: Todo): TodoScheduleValue {
  return { due: todo.due_date ?? '', endDate: todo.end_date ?? '', dateOnly: !todo.start_time, start: todo.start_time ?? '', end: todo.end_time ?? '' };
}

export function scheduleChanged(todo: Todo, value: TodoScheduleValue): boolean {
  const original = scheduleOf(todo);
  return (['due', 'endDate', 'dateOnly', 'start', 'end'] as const).some(key => (original[key] ?? '') !== (value[key] ?? ''));
}

export function visibleTags(tags: string[]): string[] {
  return [...new Set(tags.filter(tag => !/^plan:\d+$/.test(tag)))];
}

export function mergeTags(text: string, original: string[] = []): string[] {
  return [...new Set([...original.filter(tag => /^plan:\d+$/.test(tag)), ...text.split(/[,，]/).map(tag => tag.trim()).filter(Boolean)])];
}
