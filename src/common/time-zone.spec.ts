import { canonicalTimeZone } from './time-zone.js';

describe('canonicalTimeZone', () => {
  it.each([
    ['Europe/Moscow', 'Europe/Moscow'],
    ['europe/moscow', 'Europe/Moscow'],
    ['UTC', 'UTC'],
    ['utc', 'UTC'],
    ['Europe/Kiev', 'Europe/Kiev'],
  ])('turns %j into %j', (zone, canonical) => {
    expect(canonicalTimeZone(zone)).toBe(canonical);
  });

  // Which alias ICU calls canonical differs between versions (here America/Buenos_Aires);
  // what matters is that the stored value is a known zone and stays put.
  it('keeps a canonical name canonical', () => {
    const zone = canonicalTimeZone('America/Argentina/Buenos_Aires');
    expect(zone).toMatch(/Buenos_Aires$/);
    expect(canonicalTimeZone(zone!)).toBe(zone);
  });

  // Offsets: Postgres reads '+03:00' as POSIX, with the sign flipped, so they never reach it.
  it.each(['+03:00', '+0300', '+03', '-05:00'])('rejects the offset %j', (zone) => {
    expect(canonicalTimeZone(zone)).toBeUndefined();
  });

  it.each(['Moscow', 'Europe/Mosсow' /* Cyrillic с */, '', 'GMT+25', 'Europe/'])('rejects %j', (zone) => {
    expect(canonicalTimeZone(zone)).toBeUndefined();
  });
});
