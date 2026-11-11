// Wall-clock time in a business's time zone ↔ instants, on Intl alone. A "wall" value is the
// local date and time written as if it were UTC (Date.UTC of its fields): plain arithmetic on it
// moves the clock, not the instant.

export const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const MINUTES_PER_DAY = 24 * 60;

// A calendar day in the business's time zone, 'YYYY-MM-DD'.
export type LocalDate = string;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

// How far the zone's clock is ahead of UTC at an instant, in ms.
function offsetAt(timeZone: string, instant: number): number {
  const field = Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(instant)
      .map((part) => [part.type, Number(part.value)]),
  );
  const wall = Date.UTC(field.year, field.month - 1, field.day, field.hour, field.minute, field.second);
  return wall - Math.floor(instant / 1000) * 1000;
}

export const wallAt = (timeZone: string, instant: number): number => instant + offsetAt(timeZone, instant);

// The instant the zone's clock shows `wall`. When the clocks are turned back the same time
// happens twice — the first one; when they jump forward it does not happen — undefined. The
// offsets a day before and after are the only two a wall time can have (zones change offset at
// most once a day).
export function instantOf(timeZone: string, wall: number): number | undefined {
  const candidates = [offsetAt(timeZone, wall - DAY), offsetAt(timeZone, wall + DAY)]
    .map((offset) => wall - offset)
    .filter((instant) => wallAt(timeZone, instant) === wall);
  return candidates.length ? Math.min(...candidates) : undefined;
}

// instantOf for many walls in one zone: the offset is found once per local day. A day whose
// instants all share one offset (no clock change: 363 days of 365) needs no Intl per wall; a day
// with a change goes through instantOf. A zone is at most 14 hours ahead of UTC and 12 behind,
// so the instants of a local day lie between these two ends, and a zone never changes its
// offset twice within them.
export function clockOf(timeZone: string): (wall: number) => number | undefined {
  const offsets = new Map<number, number | null>();
  const offsetOfDay = (day: number): number | null => {
    let offset = offsets.get(day);
    if (offset === undefined) {
      const first = offsetAt(timeZone, day * DAY - 14 * HOUR);
      const last = offsetAt(timeZone, (day + 1) * DAY + 12 * HOUR);
      offset = first === last ? first : null;
      offsets.set(day, offset);
    }
    return offset;
  };
  return (wall) => {
    const offset = offsetOfDay(Math.floor(wall / DAY));
    return offset === null ? instantOf(timeZone, wall) : wall - offset;
  };
}

export const wallOfDate = (date: LocalDate): number => Date.parse(`${date}T00:00:00Z`);

export const dateOfWall = (wall: number): LocalDate => new Date(wall).toISOString().slice(0, 10);

export const addDays = (date: LocalDate, days: number): LocalDate => dateOfWall(wallOfDate(date) + days * DAY);

// ISO: 1 is Monday, 7 is Sunday.
export const isoWeekday = (date: LocalDate): number => new Date(wallOfDate(date)).getUTCDay() || 7;
