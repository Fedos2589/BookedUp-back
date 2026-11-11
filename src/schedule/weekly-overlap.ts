import type { WeeklyWindow } from './slots.js';

const WEEK = 7 * 24 * 60;

type Placed = Pick<WeeklyWindow, 'weekday' | 'startMinute' | 'durationMinutes'>;

const startInWeek = (window: Placed) => (window.weekday - 1) * 24 * 60 + window.startMinute;

// Whether two windows share a minute. The week is a ring: Sunday night runs into Monday, so b is
// compared also a week earlier and a week later.
function overlap(a: Placed, b: Placed): boolean {
  const aStart = startInWeek(a);
  return [-WEEK, 0, WEEK].some((shift) => {
    const bStart = startInWeek(b) + shift;
    return aStart < bStart + b.durationMinutes && bStart < aStart + a.durationMinutes;
  });
}

// The places in the list of the first two windows that overlap, or undefined.
export function firstOverlap(windows: readonly Placed[]): [number, number] | undefined {
  for (let i = 0; i < windows.length; i++)
    for (let j = i + 1; j < windows.length; j++) if (overlap(windows[i], windows[j])) return [i, j];
  return undefined;
}
