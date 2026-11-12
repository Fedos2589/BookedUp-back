import type { LocalDate } from './local-time.js';

// A DATE column comes back as midnight UTC of that day, and is written the same way.
export const localDateOf = (date: Date): LocalDate => date.toISOString().slice(0, 10);
export const dateColumn = (date: LocalDate) => new Date(`${date}T00:00:00Z`);

export const withIsoTimes = <T extends { startsAt: Date; endsAt: Date }>({ startsAt, endsAt, ...rest }: T) => ({
  ...rest,
  startsAt: startsAt.toISOString(),
  endsAt: endsAt.toISOString(),
});
