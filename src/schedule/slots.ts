import { cancelledDatesOf, groupOccurrences } from './group-occurrences.js';
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
// durationMinutes, cut into slots of slotMinutes (hours mode). A window may run past midnight.
export interface WeeklyWindow {
  staffId: string;
  weekday: number; // ISO: 1 is Monday, 7 is Sunday
  startMinute: number;
  durationMinutes: number;
  slotMinutes: number;
  title: string | null;
}

// Hours mode: a date whose windows replace the weekly ones that start on it; none is a day off.
export interface DayWindow {
  startMinute: number;
  durationMinutes: number;
  slotMinutes: number;
}

export interface DayOverride {
  staffId: string;
  date: LocalDate;
  windows: readonly DayWindow[];
}

// Groups mode: one slot a meeting, for up to `capacity` people.
export interface Group {
  id: string;
  staffId: string;
  title: string;
  description: string | null;
  weekdays: readonly number[]; // ISO: 1 is Monday, 7 is Sunday
  startMinute: number;
  durationMinutes: number;
  capacity: number;
}

export interface GroupCancellation {
  groupId: string;
  date: LocalDate;
}

export interface OneOffSession {
  id: string;
  staffId: string;
  title: string;
  description: string | null;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
}

// Time a master can't be booked: time off.
export interface Busy {
  staffId: string;
  startsAt: Date;
  endsAt: Date;
}

// An active booking (the caller leaves cancelled ones out). With a group or a one-off session it
// is a seat in that meeting; with neither it takes a master's own hours.
export interface Booking extends Busy {
  groupId: string | null;
  oneOffSessionId: string | null;
}

// What a slot is besides its time: who and how many it is for. `booked` is filled in from bookings.
interface Seats {
  staffId: string;
  title: string | null;
  description: string | null;
  capacity: number;
  booked: number;
  groupId: string | null;
  oneOffSessionId: string | null;
}

export interface Slot extends Seats {
  startsAt: Date;
  endsAt: Date;
  full: boolean; // booked >= capacity: still shown, can't be booked
}

export interface SlotQuery {
  timeZone: string;
  // Only the sources of each master's mode: the caller leaves the other mode's out.
  weekly: readonly WeeklyWindow[];
  dayOverrides: readonly DayOverride[];
  groups: readonly Group[];
  cancellations: readonly GroupCancellation[];
  oneOffSessions: readonly OneOffSession[];
  busy: readonly Busy[];
  bookings: readonly Booking[];
  // The days asked for, on the business's clock, both included. A slot belongs to the day it starts.
  from: LocalDate;
  to: LocalDate;
  notBefore: Date;
}

// A slot while it is worked out: instants as numbers, and the day it starts on the business's clock.
interface Candidate extends Seats {
  start: number;
  end: number;
  date: LocalDate;
}

const oneSeat = (staffId: string, title: string | null): Seats => ({
  staffId,
  title,
  description: null,
  capacity: 1,
  booked: 0,
  groupId: null,
  oneOffSessionId: null,
});

// Slots start on the clock (10:00, 11:00 …) and last slotMinutes of real time. A start the
// clocks jump over is skipped; a start that happens twice is the first one.
function* slotsOfDay(
  window: DayWindow,
  date: LocalDate,
  seats: Seats,
  instantOf: (wall: number) => number | undefined,
): Generator<Candidate> {
  const nextDate = addDays(date, 1);
  const end = window.startMinute + window.durationMinutes;
  for (let minute = window.startMinute; minute + window.slotMinutes <= end; minute += window.slotMinutes) {
    const start = instantOf(wallOfDate(date) + minute * MINUTE);
    if (start === undefined) continue;
    const slotDate = minute < MINUTES_PER_DAY ? date : nextDate;
    yield { ...seats, start, end: start + window.slotMinutes * MINUTE, date: slotDate };
  }
}

const dayKey = (staffId: string, date: LocalDate) => `${staffId} ${date}`;

// Weekly windows, except on a date a day override replaces; the override's windows instead.
function* hoursSlots({ timeZone, weekly, dayOverrides, from, to }: SlotQuery): Generator<Candidate> {
  const instantOf = clockOf(timeZone);
  const overridden = new Set(dayOverrides.map(({ staffId, date }) => dayKey(staffId, date)));
  // From the day before: a window that runs past midnight puts slots on the first day asked.
  for (let date = addDays(from, -1); date <= to; date = addDays(date, 1)) {
    const weekday = isoWeekday(date);
    for (const window of weekly.filter((each) => each.weekday === weekday))
      if (!overridden.has(dayKey(window.staffId, date)))
        yield* slotsOfDay(window, date, oneSeat(window.staffId, window.title), instantOf);
  }
  for (const { staffId, date, windows } of dayOverrides)
    for (const window of windows) yield* slotsOfDay(window, date, oneSeat(staffId, null), instantOf);
}

function* groupSlots({ timeZone, groups, cancellations, from, to }: SlotQuery): Generator<Candidate> {
  for (const group of groups) {
    const cancelled = cancelledDatesOf(group.id, cancellations);
    const seats = {
      staffId: group.staffId,
      title: group.title,
      description: group.description,
      capacity: group.capacity,
      booked: 0,
      groupId: group.id,
      oneOffSessionId: null,
    };
    for (const meeting of groupOccurrences(group, cancelled, timeZone, addDays(from, -1), to))
      yield { ...seats, ...meeting };
  }
}

function* sessionSlots({ timeZone, oneOffSessions }: SlotQuery): Generator<Candidate> {
  for (const { id, staffId, title, description, startsAt, endsAt, capacity } of oneOffSessions) {
    const start = startsAt.getTime();
    const seats = { staffId, title, description, capacity, booked: 0, groupId: null, oneOffSessionId: id };
    yield { ...seats, start, end: endsAt.getTime(), date: dateOfWall(wallAt(timeZone, start)) };
  }
}

// Whether a slot overlaps any interval of its own master; touching is not overlapping.
function overlapsAny(intervals: readonly (Busy & { meeting?: string | null })[]): (slot: Candidate) => boolean {
  const byStaff = new Map<string, { start: number; end: number; meeting: string | null }[]>();
  for (const { staffId, startsAt, endsAt, meeting } of intervals) {
    const own = byStaff.get(staffId) ?? [];
    own.push({ start: startsAt.getTime(), end: endsAt.getTime(), meeting: meeting ?? null });
    byStaff.set(staffId, own);
  }
  // Seats of one meeting share its time; anything else overlapping holds the master's time.
  return (slot) =>
    (byStaff.get(slot.staffId) ?? []).some(
      ({ start, end, meeting }) =>
        slot.start < end && start < slot.end && (meeting === null || meeting !== meetingOf(slot)),
    );
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

// A meeting is its group (or one-off session) at its start; its seats are the bookings with both.
const meetingKey = (meeting: string, start: number) => `${meeting} ${start}`;
const meetingOf = ({ groupId, oneOffSessionId }: { groupId: string | null; oneOffSessionId: string | null }) =>
  groupId ?? oneOffSessionId;

// How many seats are booked in each meeting.
function seatsBooked(bookings: readonly Booking[]): Map<string, number> {
  const booked = new Map<string, number>();
  for (const booking of bookings) {
    const meeting = meetingOf(booking);
    if (meeting === null) continue;
    const key = meetingKey(meeting, booking.startsAt.getTime());
    booked.set(key, (booked.get(key) ?? 0) + 1);
  }
  return booked;
}

// What a client may book: the slots of each master's mode on the days asked, minus busy time and
// hours already booked, from notBefore on, earliest first. A meeting with every seat booked stays,
// marked full.
export function freeSlots(query: SlotQuery): Slot[] {
  // Every booking that holds time (the caller leaves the others out) is busy time for the slots that
  // aren't its own meeting's: the same rule as the `appointments_no_overlap` constraint.
  const busy = overlapsAny([
    ...query.busy,
    ...query.bookings.map((booking) => ({ ...booking, meeting: meetingOf(booking) })),
  ]);
  const booked = seatsBooked(query.bookings);
  const notBefore = query.notBefore.getTime();
  const all = [...hoursSlots(query), ...groupSlots(query), ...sessionSlots(query)].sort(
    (a, b) => a.start - b.start || a.staffId.localeCompare(b.staffId),
  );
  return withoutOverlaps(all)
    .filter(({ date }) => query.from <= date && date <= query.to)
    .filter((slot) => slot.start >= notBefore)
    .filter((slot) => !busy(slot))
    .map(({ start, end, date: _date, ...seats }) => {
      const meeting = meetingOf(seats);
      const taken = meeting === null ? 0 : (booked.get(meetingKey(meeting, start)) ?? 0);
      return {
        ...seats,
        booked: taken,
        full: taken >= seats.capacity,
        startsAt: new Date(start),
        endsAt: new Date(end),
      };
    });
}
