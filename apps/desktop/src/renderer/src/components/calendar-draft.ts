import { addDay, clockLabel } from './calendar-view';

export const CALENDAR_HOUR_HEIGHT = 60;
export const CALENDAR_STEP = 15;
export interface CalendarDraft { day: string; start: number; end: number }
export const slotMinute = (offset: number) => Math.max(0, Math.min(1440 - CALENDAR_STEP, Math.floor(offset / CALENDAR_HOUR_HEIGHT * 60 / CALENDAR_STEP) * CALENDAR_STEP));
export const draftEnd = (start: number, minute: number) => Math.min(1440, Math.max(start + CALENDAR_STEP, Math.round(minute / CALENDAR_STEP) * CALENDAR_STEP));
export const draftTimes = ({ day, start, end }: CalendarDraft) => ({ date: day, start: clockLabel(start), end: end === 1440 ? '00:00' : clockLabel(end), endDate: end === 1440 ? addDay(day, 1) : '' });
