import { groupOccurrences, type Meets } from './group-occurrences.js';
import { addDays, dateOfWall, type LocalDate, wallAt } from './local-time.js';
import type { Group, GroupCancellation, OneOffSession } from './slots.js';
import { firstOverlap } from './weekly-overlap.js';

// What a group or a one-off session would overlap in groups mode: a master runs one at a time.
// A group against a group is a weekly question (no date); against a session, a dated one.
export type Conflict =
  | { kind: 'group'; id: string; title: string; date: LocalDate | null }
  | { kind: 'oneOffSession'; id: string; title: string; startsAt: string };

export interface GroupsSchedule {
  groups: readonly Group[];
  sessions: readonly OneOffSession[];
  cancellations: readonly GroupCancellation[];
}

const byWeekday = ({ weekdays, startMinute, durationMinutes }: Meets) =>
  weekdays.map((weekday) => ({ weekday, startMinute, durationMinutes }));

const meetSameTime = (a: Meets, b: Meets) =>
  byWeekday(a).some((one) => byWeekday(b).some((other) => firstOverlap([one, other]) !== undefined));

const cancelledOf = (groupId: string, cancellations: readonly GroupCancellation[]) =>
  new Set(cancellations.filter((each) => each.groupId === groupId).map(({ date }) => date));

// The meeting of `group` that overlaps [startsAt, endsAt), if any. Meetings from the day before
// count: a group past midnight runs into the next day.
function meetingOver(
  group: Group,
  { startsAt, endsAt }: Pick<OneOffSession, 'startsAt' | 'endsAt'>,
  cancellations: readonly GroupCancellation[],
  timeZone: string,
) {
  const [start, end] = [startsAt.getTime(), endsAt.getTime()];
  const dayOf = (instant: number) => dateOfWall(wallAt(timeZone, instant));
  return groupOccurrences(
    group,
    cancelledOf(group.id, cancellations),
    timeZone,
    addDays(dayOf(start), -1),
    dayOf(end),
  ).find((meeting) => meeting.start < end && start < meeting.end);
}

// The first thing a group (new or changed) would overlap among the master's other groups and
// their one-off sessions, or undefined. The group itself, by id, is not an «other».
export function groupConflict(candidate: Group, others: GroupsSchedule, timeZone: string): Conflict | undefined {
  const group = others.groups.find((other) => other.id !== candidate.id && meetSameTime(candidate, other));
  if (group) return { kind: 'group', id: group.id, title: group.title, date: null };
  const session = others.sessions.find((each) => meetingOver(candidate, each, others.cancellations, timeZone));
  if (session)
    return { kind: 'oneOffSession', id: session.id, title: session.title, startsAt: session.startsAt.toISOString() };
  return undefined;
}

// The first group meeting or other one-off session a one-off session would overlap, or
// undefined. Groups first: a session over a meeting is the case a master can fix by cancelling.
// A candidate already in `sessions` (by id) is not an «other».
export function sessionConflict(
  candidate: Pick<OneOffSession, 'startsAt' | 'endsAt'> & { id?: string },
  { groups, sessions, cancellations }: GroupsSchedule,
  timeZone: string,
): Conflict | undefined {
  for (const group of groups) {
    const meeting = meetingOver(group, candidate, cancellations, timeZone);
    if (meeting) return { kind: 'group', id: group.id, title: group.title, date: meeting.date };
  }
  const session = sessions.find(
    (other) => other.id !== candidate.id && other.startsAt < candidate.endsAt && candidate.startsAt < other.endsAt,
  );
  if (session)
    return { kind: 'oneOffSession', id: session.id, title: session.title, startsAt: session.startsAt.toISOString() };
  return undefined;
}
