import { type DayOverride, freeSlots, type Group, type OneOffSession, type WeeklyWindow } from './slots.js';

const anna = '00000000-0000-7000-8000-00000000000a';
const boris = '00000000-0000-7000-8000-00000000000b';

const weekly = (window: Partial<WeeklyWindow>): WeeklyWindow => ({
  staffId: anna,
  weekday: 1,
  startMinute: 10 * 60,
  durationMinutes: 60,
  slotMinutes: 60,
  title: null,
  ...window,
});

const at = (iso: string) => new Date(iso);
// What a slot of hours mode carries besides its time.
const oneSeat = { description: null, capacity: 1, booked: 0, groupId: null, oneOffSessionId: null };
const starts = (slots: { startsAt: Date }[]) => slots.map((slot) => slot.startsAt.toISOString());

const base = {
  timeZone: 'Europe/Moscow',
  weekly: [] as WeeklyWindow[],
  dayOverrides: [] as DayOverride[],
  groups: [] as Group[],
  cancellations: [] as { groupId: string; date: string }[],
  oneOffSessions: [] as OneOffSession[],
  busy: [],
  from: '2026-11-16', // a Monday
  to: '2026-11-16',
  notBefore: at('2026-01-01T00:00:00Z'),
};

describe('freeSlots', () => {
  it('cuts a weekly window into slots in the business time zone', () => {
    const slots = freeSlots({ ...base, weekly: [weekly({ durationMinutes: 180 })] });

    expect(slots).toEqual([
      {
        staffId: anna,
        startsAt: at('2026-11-16T07:00:00Z'),
        endsAt: at('2026-11-16T08:00:00Z'),
        title: null,
        ...oneSeat,
      },
      {
        staffId: anna,
        startsAt: at('2026-11-16T08:00:00Z'),
        endsAt: at('2026-11-16T09:00:00Z'),
        title: null,
        ...oneSeat,
      },
      {
        staffId: anna,
        startsAt: at('2026-11-16T09:00:00Z'),
        endsAt: at('2026-11-16T10:00:00Z'),
        title: null,
        ...oneSeat,
      },
    ]);
  });

  it('drops the tail of a window that a whole slot does not fit into', () => {
    const slots = freeSlots({ ...base, weekly: [weekly({ durationMinutes: 150 })] });

    expect(starts(slots)).toEqual(['2026-11-16T07:00:00.000Z', '2026-11-16T08:00:00.000Z']);
  });

  it('gives a named window as one slot with its title', () => {
    const slots = freeSlots({
      ...base,
      weekly: [weekly({ startMinute: 17 * 60, durationMinutes: 90, slotMinutes: 90, title: 'Football' })],
    });

    expect(slots).toEqual([
      {
        staffId: anna,
        startsAt: at('2026-11-16T14:00:00Z'),
        endsAt: at('2026-11-16T15:30:00Z'),
        title: 'Football',
        ...oneSeat,
      },
    ]);
  });

  it('repeats a window on its weekday only, from and to included', () => {
    const slots = freeSlots({
      ...base,
      weekly: [weekly({ weekday: 1 }), weekly({ weekday: 5 })],
      from: '2026-11-16',
      to: '2026-11-23',
    });

    expect(starts(slots)).toEqual([
      '2026-11-16T07:00:00.000Z', // Mon
      '2026-11-20T07:00:00.000Z', // Fri
      '2026-11-23T07:00:00.000Z', // next Mon
    ]);
  });

  it('runs a window past midnight into the next day, and counts each slot on the day it starts', () => {
    // Sunday 22:00–02:00: the slots of the night of Nov 15 to 16 start on both days.
    const night = weekly({ weekday: 7, startMinute: 22 * 60, durationMinutes: 240, slotMinutes: 120 });

    expect(starts(freeSlots({ ...base, weekly: [night], from: '2026-11-15', to: '2026-11-15' }))).toEqual([
      '2026-11-15T19:00:00.000Z',
    ]);
    expect(starts(freeSlots({ ...base, weekly: [night], from: '2026-11-16', to: '2026-11-16' }))).toEqual([
      '2026-11-15T21:00:00.000Z',
    ]);
  });

  it('leaves out every slot that overlaps busy time of the same master, not one that only touches it', () => {
    const slots = freeSlots({
      ...base,
      weekly: [weekly({ durationMinutes: 240 }), weekly({ staffId: boris })],
      busy: [
        { staffId: anna, startsAt: at('2026-11-16T07:30:00Z'), endsAt: at('2026-11-16T08:10:00Z') },
        { staffId: anna, startsAt: at('2026-11-16T10:00:00Z'), endsAt: at('2026-11-16T12:00:00Z') },
        // Ends as Boris's slot starts.
        { staffId: boris, startsAt: at('2026-11-16T06:00:00Z'), endsAt: at('2026-11-16T07:00:00Z') },
      ],
    });

    expect(slots.map(({ staffId, startsAt }) => [staffId, startsAt.toISOString()])).toEqual([
      [boris, '2026-11-16T07:00:00.000Z'],
      [anna, '2026-11-16T09:00:00.000Z'],
    ]);
  });

  it('orders slots that start together by master, whatever order the windows came in', () => {
    const slots = freeSlots({ ...base, weekly: [weekly({ staffId: boris }), weekly({ staffId: anna })] });

    expect(slots.map((slot) => slot.staffId)).toEqual([anna, boris]);
  });

  it('leaves out slots that start before notBefore', () => {
    const slots = freeSlots({
      ...base,
      weekly: [weekly({ durationMinutes: 180 })],
      notBefore: at('2026-11-16T08:00:00Z'),
    });

    expect(starts(slots)).toEqual(['2026-11-16T08:00:00.000Z', '2026-11-16T09:00:00.000Z']);
  });

  it('finds a clock change that falls on the day before in UTC (Australia/Sydney)', () => {
    // 2026-04-05, 03:00 AEDT (+11) becomes 02:00 AEST (+10) — at 16:00 UTC on the 4th.
    const slots = freeSlots({
      ...base,
      timeZone: 'Australia/Sydney',
      weekly: [weekly({ weekday: 7, startMinute: 60, durationMinutes: 180 })],
      from: '2026-04-05',
      to: '2026-04-05',
    });

    expect(starts(slots)).toEqual([
      '2026-04-04T14:00:00.000Z', // 01:00 AEDT
      '2026-04-04T15:00:00.000Z', // 02:00 AEDT, the first one
      '2026-04-04T17:00:00.000Z', // 03:00 AEST
    ]);
  });

  describe('on a daylight saving change (Europe/Berlin)', () => {
    const berlin = { ...base, timeZone: 'Europe/Berlin' };

    it('skips the hour the clocks jump over, and the next slot starts on time by the clock', () => {
      // 2026-03-29: 02:00 CET becomes 03:00 CEST.
      const slots = freeSlots({
        ...berlin,
        weekly: [weekly({ weekday: 7, startMinute: 60, durationMinutes: 240 })],
        from: '2026-03-29',
        to: '2026-03-29',
      });

      expect(slots.map((slot) => [slot.startsAt.toISOString(), slot.endsAt.toISOString()])).toEqual([
        ['2026-03-29T00:00:00.000Z', '2026-03-29T01:00:00.000Z'], // 01:00 CET
        ['2026-03-29T01:00:00.000Z', '2026-03-29T02:00:00.000Z'], // 03:00 CEST
        ['2026-03-29T02:00:00.000Z', '2026-03-29T03:00:00.000Z'], // 04:00 CEST
      ]);
    });

    it('drops a slot that the hour lost would make overlap the one before it', () => {
      // 01:45 CET lasts 45 real minutes and ends at 03:30 CEST, past the 03:15 start.
      const slots = freeSlots({
        ...berlin,
        weekly: [weekly({ weekday: 7, startMinute: 60, durationMinutes: 240, slotMinutes: 45 })],
        from: '2026-03-29',
        to: '2026-03-29',
      });

      expect(slots.map((slot) => [slot.startsAt.toISOString(), slot.endsAt.toISOString()])).toEqual([
        ['2026-03-29T00:00:00.000Z', '2026-03-29T00:45:00.000Z'], // 01:00 CET
        ['2026-03-29T00:45:00.000Z', '2026-03-29T01:30:00.000Z'], // 01:45 CET
        ['2026-03-29T02:00:00.000Z', '2026-03-29T02:45:00.000Z'], // 04:00 CEST
      ]);
    });

    it('drops it also when the two slots come from different windows', () => {
      // 01:30–02:30 and 03:00–04:00 on the clock: the first slot ends at 03:30 CEST.
      const slots = freeSlots({
        ...berlin,
        weekly: [
          weekly({ weekday: 7, startMinute: 90, durationMinutes: 60 }),
          weekly({ weekday: 7, startMinute: 180, durationMinutes: 60 }),
          weekly({ staffId: boris, weekday: 7, startMinute: 180, durationMinutes: 60 }),
        ],
        from: '2026-03-29',
        to: '2026-03-29',
      });

      expect(slots.map(({ staffId, startsAt }) => [staffId, startsAt.toISOString()])).toEqual([
        [anna, '2026-03-29T00:30:00.000Z'],
        [boris, '2026-03-29T01:00:00.000Z'],
      ]);
    });

    it('takes the first of a repeated hour, and no two slots overlap', () => {
      // 2026-10-25: 03:00 CEST becomes 02:00 CET, so 02:00–03:00 happens twice.
      const slots = freeSlots({
        ...berlin,
        weekly: [weekly({ weekday: 7, startMinute: 60, durationMinutes: 180 })],
        from: '2026-10-25',
        to: '2026-10-25',
      });

      expect(slots.map((slot) => [slot.startsAt.toISOString(), slot.endsAt.toISOString()])).toEqual([
        ['2026-10-24T23:00:00.000Z', '2026-10-25T00:00:00.000Z'], // 01:00 CEST
        ['2026-10-25T00:00:00.000Z', '2026-10-25T01:00:00.000Z'], // 02:00 CEST, the first one
        ['2026-10-25T02:00:00.000Z', '2026-10-25T03:00:00.000Z'], // 03:00 CET
      ]);
    });
  });

  describe('day overrides (hours mode)', () => {
    it('replace the weekly slots that start on their date', () => {
      const slots = freeSlots({
        ...base,
        weekly: [weekly({ durationMinutes: 180 }), weekly({ staffId: boris })],
        dayOverrides: [
          {
            staffId: anna,
            date: '2026-11-16',
            windows: [{ startMinute: 12 * 60, durationMinutes: 60, slotMinutes: 60 }],
          },
        ],
      });

      expect(slots.map(({ staffId, startsAt }) => [staffId, startsAt.toISOString()])).toEqual([
        [boris, '2026-11-16T07:00:00.000Z'],
        [anna, '2026-11-16T09:00:00.000Z'], // 12:00 Moscow, from the override
      ]);
      expect(slots[1]).toMatchObject(oneSeat);
    });

    it('with no windows are a day off', () => {
      const slots = freeSlots({
        ...base,
        weekly: [weekly({ durationMinutes: 180 })],
        dayOverrides: [{ staffId: anna, date: '2026-11-16', windows: [] }],
      });

      expect(slots).toEqual([]);
    });

    it('keep the night slots of the day before; their own slots that would overlap them go', () => {
      // Sunday 23:00 for two hours, hourly; Monday overridden with 00:00–02:00, hourly.
      const slots = freeSlots({
        ...base,
        weekly: [weekly({ weekday: 7, startMinute: 23 * 60, durationMinutes: 120 })],
        dayOverrides: [
          { staffId: anna, date: '2026-11-16', windows: [{ startMinute: 0, durationMinutes: 120, slotMinutes: 60 }] },
        ],
        from: '2026-11-15',
        to: '2026-11-16',
      });

      expect(starts(slots)).toEqual([
        '2026-11-15T20:00:00.000Z', // Sun 23:00, weekly
        '2026-11-15T21:00:00.000Z', // Mon 00:00, weekly from Sunday
        '2026-11-15T22:00:00.000Z', // Mon 01:00, the override
      ]);
    });
  });

  describe('groups mode', () => {
    const football: Group = {
      id: '00000000-0000-7000-8000-0000000000f1',
      staffId: anna,
      title: 'Football, kids 7–10',
      description: 'Bring water',
      weekdays: [2, 4],
      startMinute: 15 * 60,
      durationMinutes: 60,
      capacity: 12,
    };
    const week = { from: '2026-11-16', to: '2026-11-22' };

    it('gives a group as one slot a meeting, with its capacity, description and id', () => {
      const slots = freeSlots({ ...base, ...week, groups: [football] });

      expect(slots).toEqual(
        ['2026-11-17T12:00:00Z', '2026-11-19T12:00:00Z'].map((start) => ({
          staffId: anna,
          startsAt: at(start),
          endsAt: new Date(at(start).getTime() + 3_600_000),
          title: 'Football, kids 7–10',
          description: 'Bring water',
          capacity: 12,
          booked: 0,
          groupId: football.id,
          oneOffSessionId: null,
        })),
      );
    });

    it('leaves a cancelled date of a group out', () => {
      const slots = freeSlots({
        ...base,
        ...week,
        groups: [football],
        cancellations: [{ groupId: football.id, date: '2026-11-17' }],
      });

      expect(starts(slots)).toEqual(['2026-11-19T12:00:00.000Z']);
    });

    it('gives a one-off session as one slot with its id', () => {
      const session: OneOffSession = {
        id: '00000000-0000-7000-8000-0000000000e1',
        staffId: anna,
        title: 'Masterclass',
        description: null,
        startsAt: at('2026-11-18T15:00:00Z'),
        endsAt: at('2026-11-18T17:30:00Z'),
        capacity: 30,
      };

      expect(freeSlots({ ...base, ...week, oneOffSessions: [session] })).toEqual([
        {
          staffId: anna,
          startsAt: session.startsAt,
          endsAt: session.endsAt,
          title: 'Masterclass',
          description: null,
          capacity: 30,
          booked: 0,
          groupId: null,
          oneOffSessionId: session.id,
        },
      ]);
    });

    it('takes time off out of group slots too', () => {
      const slots = freeSlots({
        ...base,
        ...week,
        groups: [football],
        busy: [{ staffId: anna, startsAt: at('2026-11-19T00:00:00Z'), endsAt: at('2026-11-20T00:00:00Z') }],
      });

      expect(starts(slots)).toEqual(['2026-11-17T12:00:00.000Z']);
    });
  });
});
