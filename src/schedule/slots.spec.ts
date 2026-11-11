import { freeSlots, type OneOffWindow, type WeeklyWindow } from './slots.js';

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
const starts = (slots: { startsAt: Date }[]) => slots.map((slot) => slot.startsAt.toISOString());

const base = {
  timeZone: 'Europe/Moscow',
  weekly: [] as WeeklyWindow[],
  oneOff: [] as OneOffWindow[],
  busy: [],
  from: '2026-11-16', // a Monday
  to: '2026-11-16',
  notBefore: at('2026-01-01T00:00:00Z'),
};

describe('freeSlots', () => {
  it('cuts a weekly window into slots in the business time zone', () => {
    const slots = freeSlots({ ...base, weekly: [weekly({ durationMinutes: 180 })] });

    expect(slots).toEqual([
      { staffId: anna, startsAt: at('2026-11-16T07:00:00Z'), endsAt: at('2026-11-16T08:00:00Z'), title: null },
      { staffId: anna, startsAt: at('2026-11-16T08:00:00Z'), endsAt: at('2026-11-16T09:00:00Z'), title: null },
      { staffId: anna, startsAt: at('2026-11-16T09:00:00Z'), endsAt: at('2026-11-16T10:00:00Z'), title: null },
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
      { staffId: anna, startsAt: at('2026-11-16T14:00:00Z'), endsAt: at('2026-11-16T15:30:00Z'), title: 'Football' },
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

  it('cuts a one-off window into slots from its start', () => {
    const slots = freeSlots({
      ...base,
      oneOff: [
        {
          staffId: anna,
          startsAt: at('2026-11-16T15:00:00Z'),
          endsAt: at('2026-11-16T17:30:00Z'),
          slotMinutes: 60,
          title: 'Extra training',
        },
      ],
    });

    expect(slots).toEqual([
      {
        staffId: anna,
        startsAt: at('2026-11-16T15:00:00Z'),
        endsAt: at('2026-11-16T16:00:00Z'),
        title: 'Extra training',
      },
      {
        staffId: anna,
        startsAt: at('2026-11-16T16:00:00Z'),
        endsAt: at('2026-11-16T17:00:00Z'),
        title: 'Extra training',
      },
    ]);
  });

  it('takes the one-off slots that start on the days asked, by the business clock', () => {
    // 22:30 UTC on the 16th is 01:30 on the 17th in Moscow.
    const late = { staffId: anna, slotMinutes: 60, title: null };
    const slots = freeSlots({
      ...base,
      oneOff: [
        { ...late, startsAt: at('2026-11-15T21:30:00Z'), endsAt: at('2026-11-15T22:30:00Z') },
        { ...late, startsAt: at('2026-11-16T22:30:00Z'), endsAt: at('2026-11-16T23:30:00Z') },
      ],
    });

    expect(starts(slots)).toEqual(['2026-11-15T21:30:00.000Z']);
  });

  it('lets a one-off window take its time over the weekly slots of the same master', () => {
    const slots = freeSlots({
      ...base,
      weekly: [weekly({ durationMinutes: 180 }), weekly({ staffId: boris, startMinute: 11 * 60 })],
      oneOff: [
        {
          staffId: anna,
          startsAt: at('2026-11-16T08:30:00Z'),
          endsAt: at('2026-11-16T09:30:00Z'),
          slotMinutes: 60,
          title: 'Masterclass',
        },
      ],
    });

    expect(slots.map(({ staffId, startsAt, title }) => [staffId, startsAt.toISOString(), title])).toEqual([
      [anna, '2026-11-16T07:00:00.000Z', null],
      [boris, '2026-11-16T08:00:00.000Z', null],
      [anna, '2026-11-16T08:30:00.000Z', 'Masterclass'],
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
});
