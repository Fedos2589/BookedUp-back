import { strandedBookings } from './stranded-bookings.js';

const meets = { weekdays: [2], startMinute: 15 * 60, durationMinutes: 60, capacity: 2 };
const tuesday = (day: number, from = '12:00', to = '13:00') => ({
  startsAt: new Date(`2030-01-${String(day).padStart(2, '0')}T${from}:00.000Z`),
  endsAt: new Date(`2030-01-${String(day).padStart(2, '0')}T${to}:00.000Z`),
});
const seat = (id: string, time = tuesday(8)) => ({ id, ...time });

describe('strandedBookings', () => {
  it('finds none while every seat is a meeting of the group with room for it', () => {
    expect(strandedBookings(meets, [seat('a'), seat('b'), seat('c', tuesday(15))], 'Europe/Moscow')).toEqual([]);
  });

  it('finds seats the new time or day no longer has a meeting for', () => {
    const moved = { ...meets, startMinute: 17 * 60 };
    const otherDay = { ...meets, weekdays: [4] };
    const longer = { ...meets, durationMinutes: 90 };

    expect(strandedBookings(moved, [seat('a')], 'Europe/Moscow')).toEqual(['a']);
    expect(strandedBookings(otherDay, [seat('a')], 'Europe/Moscow')).toEqual(['a']);
    expect(strandedBookings(longer, [seat('a')], 'Europe/Moscow')).toEqual(['a']);
  });

  it('finds the seats of a meeting that now has more of them than places', () => {
    const seats = [seat('a'), seat('b'), seat('c'), seat('d', tuesday(15))];

    expect(strandedBookings(meets, seats, 'Europe/Moscow')).toEqual(['a', 'b', 'c']);
  });
});
