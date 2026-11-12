import { groupOccurrences } from './group-occurrences.js';

const tuesdayThursday = { weekdays: [2, 4], startMinute: 15 * 60, durationMinutes: 60 };
const iso = (occurrences: { start: number; end: number; date: string }[]) =>
  occurrences.map(({ start, end, date }) => [new Date(start).toISOString(), new Date(end).toISOString(), date]);

describe('groupOccurrences', () => {
  it('gives a group on each of its weekdays, cancelled dates left out', () => {
    const meetings = groupOccurrences(
      tuesdayThursday,
      new Set(['2026-11-19']),
      'Europe/Moscow',
      '2026-11-16',
      '2026-11-26',
    );

    expect(iso(meetings)).toEqual([
      ['2026-11-17T12:00:00.000Z', '2026-11-17T13:00:00.000Z', '2026-11-17'],
      ['2026-11-24T12:00:00.000Z', '2026-11-24T13:00:00.000Z', '2026-11-24'],
      ['2026-11-26T12:00:00.000Z', '2026-11-26T13:00:00.000Z', '2026-11-26'],
    ]);
  });

  it('skips a start the clocks jump over', () => {
    // 2026-03-29 in Berlin: 02:00 CET becomes 03:00 CEST, so 02:30 never happens.
    const sunday = { weekdays: [7], startMinute: 150, durationMinutes: 60 };

    expect(groupOccurrences(sunday, new Set(), 'Europe/Berlin', '2026-03-29', '2026-03-29')).toEqual([]);
    expect(iso(groupOccurrences(sunday, new Set(), 'Europe/Berlin', '2026-04-05', '2026-04-05'))).toEqual([
      ['2026-04-05T00:30:00.000Z', '2026-04-05T01:30:00.000Z', '2026-04-05'],
    ]);
  });

  it('puts a group that runs past midnight on the day it starts', () => {
    const lateSunday = { weekdays: [7], startMinute: 23 * 60, durationMinutes: 120 };

    expect(iso(groupOccurrences(lateSunday, new Set(), 'Europe/Moscow', '2026-11-15', '2026-11-16'))).toEqual([
      ['2026-11-15T20:00:00.000Z', '2026-11-15T22:00:00.000Z', '2026-11-15'],
    ]);
  });
});
