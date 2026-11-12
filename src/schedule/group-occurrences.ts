import { addDays, clockOf, isoWeekday, type LocalDate, MINUTE, wallOfDate } from './local-time.js';

// When a group actually meets: instants as numbers, and the day it starts on the business's clock.
export interface Occurrence {
  start: number;
  end: number;
  date: LocalDate;
}

export interface Meets {
  weekdays: readonly number[]; // ISO: 1 is Monday, 7 is Sunday
  startMinute: number;
  durationMinutes: number;
}

// Every meeting that starts on the days from..to (both included), except cancelled dates. It
// starts on the clock and lasts durationMinutes of real time; a start the clocks jump over is
// skipped (that day it doesn't meet), one that happens twice is the first — like weekly slots.
export function groupOccurrences(
  group: Meets,
  cancelled: ReadonlySet<LocalDate>,
  timeZone: string,
  from: LocalDate,
  to: LocalDate,
): Occurrence[] {
  const instantOf = clockOf(timeZone);
  const occurrences: Occurrence[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    if (!group.weekdays.includes(isoWeekday(date)) || cancelled.has(date)) continue;
    const start = instantOf(wallOfDate(date) + group.startMinute * MINUTE);
    if (start !== undefined) occurrences.push({ start, end: start + group.durationMinutes * MINUTE, date });
  }
  return occurrences;
}
