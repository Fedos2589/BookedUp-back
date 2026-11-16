import { groupOccurrences, type Meets } from './group-occurrences.js';
import { addDays, dateOfWall, wallAt } from './local-time.js';

interface Seat {
  id: string;
  startsAt: Date;
  endsAt: Date;
}

// Which of a group's seats the group, as changed, can't honour: no meeting at their time any more,
// or more seats on a meeting than it has places for (all of that meeting's seats: which to cancel
// is for the owner to say). Cancelled dates aren't looked at — a seat on one is refused earlier.
export function strandedBookings(group: Meets & { capacity: number }, seats: readonly Seat[], timeZone: string) {
  if (seats.length === 0) return [];
  const days = seats.map(({ startsAt }) => dateOfWall(wallAt(timeZone, startsAt.getTime()))).sort();
  const meetings = groupOccurrences(group, new Set(), timeZone, addDays(days[0]!, -1), days[days.length - 1]!);
  const seatsOf = new Map<number, Seat[]>();
  const stranded: string[] = [];
  for (const seat of seats) {
    const meeting = meetings.find(
      ({ start, end }) => start === seat.startsAt.getTime() && end === seat.endsAt.getTime(),
    );
    if (!meeting) stranded.push(seat.id);
    else seatsOf.set(meeting.start, [...(seatsOf.get(meeting.start) ?? []), seat]);
  }
  for (const meeting of seatsOf.values())
    if (meeting.length > group.capacity) stranded.push(...meeting.map(({ id }) => id));
  return stranded;
}
