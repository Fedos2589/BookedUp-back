import { groupConflict, sessionConflict } from './group-conflicts.js';
import type { Group, OneOffSession } from './slots.js';

const anna = '00000000-0000-7000-8000-00000000000a';
const timeZone = 'Europe/Moscow';

const group = (overrides: Partial<Group>): Group => ({
  id: '00000000-0000-7000-8000-0000000000f1',
  staffId: anna,
  title: 'Football',
  description: null,
  weekdays: [2, 4],
  startMinute: 15 * 60,
  durationMinutes: 60,
  capacity: 12,
  ...overrides,
});

const session = (startsAt: string, endsAt: string): OneOffSession => ({
  id: '00000000-0000-7000-8000-0000000000e1',
  staffId: anna,
  title: 'Masterclass',
  description: null,
  startsAt: new Date(startsAt),
  endsAt: new Date(endsAt),
  capacity: 30,
});

const nothing = { groups: [], sessions: [], cancellations: [] };

describe('groupConflict', () => {
  const tennis = group({ id: '00000000-0000-7000-8000-0000000000f2', title: 'Tennis', weekdays: [4, 6] });

  it('finds a group that meets at the same time on a shared weekday', () => {
    const candidate = group({ startMinute: 15 * 60 + 30 });

    expect(groupConflict(candidate, { ...nothing, groups: [tennis] }, timeZone)).toEqual({
      kind: 'group',
      id: tennis.id,
      title: 'Tennis',
      date: null,
    });
  });

  it('lets groups on different weekdays, or one after another, be', () => {
    const others = { ...nothing, groups: [tennis] };

    expect(groupConflict(group({ weekdays: [2, 5] }), others, timeZone)).toBeUndefined();
    expect(groupConflict(group({ startMinute: 16 * 60 }), others, timeZone)).toBeUndefined();
  });

  it('finds Sunday 23:00 for two hours overlapping Monday 00:30 (the week is a ring)', () => {
    const lateSunday = group({ weekdays: [7], startMinute: 23 * 60, durationMinutes: 120 });
    const earlyMonday = group({ id: tennis.id, title: 'Tennis', weekdays: [1], startMinute: 30 });

    expect(groupConflict(lateSunday, { ...nothing, groups: [earlyMonday] }, timeZone)?.id).toBe(tennis.id);
  });

  it('does not compare a group with itself', () => {
    const candidate = group({});

    expect(groupConflict(candidate, { ...nothing, groups: [candidate] }, timeZone)).toBeUndefined();
  });

  it('finds a one-off session over one of its meetings, unless that date is cancelled', () => {
    // Tue 2030-01-08 15:00 Moscow is 12:00 UTC.
    const masterclass = session('2030-01-08T12:30:00Z', '2030-01-08T14:00:00Z');
    const candidate = group({});

    expect(groupConflict(candidate, { ...nothing, sessions: [masterclass] }, timeZone)).toEqual({
      kind: 'oneOffSession',
      id: masterclass.id,
      title: 'Masterclass',
      startsAt: '2030-01-08T12:30:00.000Z',
    });
    const cancelled = [{ groupId: candidate.id, date: '2030-01-08' }];
    expect(
      groupConflict(candidate, { ...nothing, sessions: [masterclass], cancellations: cancelled }, timeZone),
    ).toBeUndefined();
  });
});

describe('sessionConflict', () => {
  it('finds the group meeting it would overlap, with its date', () => {
    const football = group({});

    expect(
      sessionConflict(
        session('2030-01-10T11:00:00Z', '2030-01-10T12:30:00Z'),
        { ...nothing, groups: [football] },
        timeZone,
      ),
    ).toEqual({
      kind: 'group',
      id: football.id,
      title: 'Football',
      date: '2030-01-10',
    });
    expect(
      sessionConflict(
        session('2030-01-10T13:00:00Z', '2030-01-10T14:00:00Z'),
        { ...nothing, groups: [football] },
        timeZone,
      ),
    ).toBeUndefined();
  });

  it('finds a group from the night before that runs past midnight into it', () => {
    // Sun 23:00 for two hours; Mon 00:30–01:00 Moscow is Sun 21:30–22:00 UTC.
    const lateSunday = group({ weekdays: [7], startMinute: 23 * 60, durationMinutes: 120 });

    expect(
      sessionConflict(
        session('2030-01-06T21:30:00Z', '2030-01-06T22:00:00Z'),
        { ...nothing, groups: [lateSunday] },
        timeZone,
      ),
    ).toEqual({ kind: 'group', id: lateSunday.id, title: 'Football', date: '2030-01-06' });
  });

  it('lets a session take a cancelled meeting', () => {
    const football = group({});
    const cancelled = [{ groupId: football.id, date: '2030-01-10' }];

    expect(
      sessionConflict(
        session('2030-01-10T11:00:00Z', '2030-01-10T12:30:00Z'),
        { ...nothing, groups: [football], cancellations: cancelled },
        timeZone,
      ),
    ).toBeUndefined();
  });

  it('finds another one-off session it would overlap, not itself', () => {
    const masterclass = session('2030-01-10T11:00:00Z', '2030-01-10T12:00:00Z');
    const later = {
      ...session('2030-01-10T11:30:00Z', '2030-01-10T13:00:00Z'),
      id: '00000000-0000-7000-8000-0000000000e2',
    };

    expect(sessionConflict(later, { ...nothing, sessions: [masterclass, later] }, timeZone)).toEqual({
      kind: 'oneOffSession',
      id: masterclass.id,
      title: 'Masterclass',
      startsAt: '2030-01-10T11:00:00.000Z',
    });
    expect(sessionConflict(masterclass, { ...nothing, sessions: [masterclass] }, timeZone)).toBeUndefined();
  });
});
