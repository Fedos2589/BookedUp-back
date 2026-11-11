import {
  addDays,
  dateOfWall,
  instantOf,
  isoWeekday,
  type LocalDate,
  MINUTE,
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

interface Candidate extends Slot {
  date: LocalDate;
}

// Slots start on the clock (10:00, 11:00 …) and last slotMinutes of real time. A start the
// clocks jump over is skipped; a start that happens twice is the first one.
function* weeklySlots({ timeZone, weekly, from, to }: SlotQuery): Generator<Candidate> {
  // From the day before: a window that runs past midnight puts slots on the first day asked.
  for (let date = addDays(from, -1); date <= to; date = addDays(date, 1)) {
    const weekday = isoWeekday(date);
    for (const window of weekly.filter((each) => each.weekday === weekday)) {
      const end = window.startMinute + window.durationMinutes;
      for (let minute = window.startMinute; minute + window.slotMinutes <= end; minute += window.slotMinutes) {
        const wall = wallOfDate(date) + minute * MINUTE;
        const start = instantOf(timeZone, wall);
        if (start === undefined) continue;
        yield slotOf(window, start, dateOfWall(wall));
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
): Candidate => ({
  staffId,
  startsAt: new Date(start),
  endsAt: new Date(start + slotMinutes * MINUTE),
  title,
  date,
});

const overlaps = (a: Busy, b: Busy) => a.staffId === b.staffId && a.startsAt < b.endsAt && b.startsAt < a.endsAt;

// A master's slots never overlap: when the clocks jump forward, a slot that started before the
// jump lasts past the next start on the clock (01:45 CET + 45 min = 03:30 CEST > 03:15), and
// the later one goes. Earliest first in, so the same grid comes out whatever is booked later.
function withoutOverlaps(sorted: Candidate[]): Candidate[] {
  const lastEnd = new Map<string, number>();
  return sorted.filter((slot) => {
    if (slot.startsAt.getTime() < (lastEnd.get(slot.staffId) ?? -Infinity)) return false;
    lastEnd.set(slot.staffId, slot.endsAt.getTime());
    return true;
  });
}

// What a client may book: the windows' slots on the days asked, minus busy time, from notBefore
// on, earliest first. A one-off window takes its time from the weekly slots under it.
export function freeSlots(query: SlotQuery): Slot[] {
  const weekly = [...weeklySlots(query)].filter((slot) => !query.oneOff.some((window) => overlaps(slot, window)));
  const all = [...weekly, ...oneOffSlots(query)].sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.staffId.localeCompare(b.staffId),
  );
  return withoutOverlaps(all)
    .filter(({ date }) => query.from <= date && date <= query.to)
    .filter((slot) => slot.startsAt >= query.notBefore)
    .filter((slot) => !query.busy.some((busy) => overlaps(slot, busy)))
    .map(({ date: _date, ...slot }) => slot);
}
