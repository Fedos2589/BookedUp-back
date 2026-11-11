import {
  addDays,
  clockOf,
  dateOfWall,
  isoWeekday,
  type LocalDate,
  MINUTE,
  MINUTES_PER_DAY,
  wallAt,
  wallOfDate,
} from './local-time.js';

// When a master takes clients, every week: from startMinute (on the business's clock) for
// durationMinutes, cut into slots of slotMinutes. A window may run past midnight. A title names
// what the time is for («Football») — a window as long as its slot is one named session.
export interface WeeklyWindow {
  staffId: string;
  weekday: number; // ISO: 1 is Monday, 7 is Sunday
  startMinute: number;
  durationMinutes: number;
  slotMinutes: number;
  title: string | null;
}

// The same, once, between two instants.
export interface OneOffWindow {
  staffId: string;
  startsAt: Date;
  endsAt: Date;
  slotMinutes: number;
  title: string | null;
}

// Time a master can't be booked: time off now, bookings from E6.
export interface Busy {
  staffId: string;
  startsAt: Date;
  endsAt: Date;
}

export interface Slot {
  staffId: string;
  startsAt: Date;
  endsAt: Date;
  title: string | null;
}

export interface SlotQuery {
  timeZone: string;
  weekly: readonly WeeklyWindow[];
  oneOff: readonly OneOffWindow[];
  busy: readonly Busy[];
  // The days asked for, on the business's clock, both included. A slot belongs to the day it starts.
  from: LocalDate;
  to: LocalDate;
  notBefore: Date;
}

// A slot while it is worked out: instants as numbers, and the day it starts on the business's clock.
interface Candidate {
  staffId: string;
  start: number;
  end: number;
  title: string | null;
  date: LocalDate;
}

// Slots start on the clock (10:00, 11:00 …) and last slotMinutes of real time. A start the
// clocks jump over is skipped; a start that happens twice is the first one.
function* weeklySlots({ timeZone, weekly, from, to }: SlotQuery): Generator<Candidate> {
  const instantOf = clockOf(timeZone);
  // From the day before: a window that runs past midnight puts slots on the first day asked.
  for (let date = addDays(from, -1); date <= to; date = addDays(date, 1)) {
    const weekday = isoWeekday(date);
    const nextDate = addDays(date, 1);
    for (const window of weekly.filter((each) => each.weekday === weekday)) {
      const end = window.startMinute + window.durationMinutes;
      for (let minute = window.startMinute; minute + window.slotMinutes <= end; minute += window.slotMinutes) {
        const start = instantOf(wallOfDate(date) + minute * MINUTE);
        if (start === undefined) continue;
        yield slotOf(window, start, minute < MINUTES_PER_DAY ? date : nextDate);
      }
    }
  }
}

function* oneOffSlots({ timeZone, oneOff }: SlotQuery): Generator<Candidate> {
  for (const window of oneOff) {
    const step = window.slotMinutes * MINUTE;
    for (let start = window.startsAt.getTime(); start + step <= window.endsAt.getTime(); start += step)
      yield slotOf(window, start, dateOfWall(wallAt(timeZone, start)));
  }
}

const slotOf = (
  { staffId, slotMinutes, title }: Pick<WeeklyWindow, 'staffId' | 'slotMinutes' | 'title'>,
  start: number,
  date: LocalDate,
): Candidate => ({ staffId, start, end: start + slotMinutes * MINUTE, title, date });

// Whether a slot overlaps any interval of its own master; touching is not overlapping.
function overlapsAny(intervals: readonly Busy[]): (slot: Candidate) => boolean {
  const byStaff = new Map<string, { start: number; end: number }[]>();
  for (const { staffId, startsAt, endsAt } of intervals) {
    const own = byStaff.get(staffId) ?? [];
    own.push({ start: startsAt.getTime(), end: endsAt.getTime() });
    byStaff.set(staffId, own);
  }
  return (slot) => (byStaff.get(slot.staffId) ?? []).some(({ start, end }) => slot.start < end && start < slot.end);
}

// A master's slots never overlap: when the clocks jump forward, a slot that started before the
// jump lasts past the next start on the clock (01:45 CET + 45 min = 03:30 CEST > 03:15), and
// the later one goes. Earliest first in, so the same grid comes out whatever is booked later.
function withoutOverlaps(sorted: Candidate[]): Candidate[] {
  const lastEnd = new Map<string, number>();
  return sorted.filter((slot) => {
    if (slot.start < (lastEnd.get(slot.staffId) ?? -Infinity)) return false;
    lastEnd.set(slot.staffId, slot.end);
    return true;
  });
}

// What a client may book: the windows' slots on the days asked, minus busy time, from notBefore
// on, earliest first. A one-off window takes its time from the weekly slots under it.
export function freeSlots(query: SlotQuery): Slot[] {
  const underOneOff = overlapsAny(query.oneOff);
  const busy = overlapsAny(query.busy);
  const notBefore = query.notBefore.getTime();
  const weekly = [...weeklySlots(query)].filter((slot) => !underOneOff(slot));
  const all = [...weekly, ...oneOffSlots(query)].sort(
    (a, b) => a.start - b.start || a.staffId.localeCompare(b.staffId),
  );
  return withoutOverlaps(all)
    .filter(({ date }) => query.from <= date && date <= query.to)
    .filter((slot) => slot.start >= notBefore)
    .filter((slot) => !busy(slot))
    .map(({ staffId, start, end, title }) => ({ staffId, startsAt: new Date(start), endsAt: new Date(end), title }));
}
