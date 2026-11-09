import { isTimeZone } from './time-zone.js';

describe('isTimeZone', () => {
  it.each(['Europe/Moscow', 'Asia/Bangkok', 'UTC', 'Europe/Kiev', 'America/Argentina/Buenos_Aires'])(
    'accepts %s',
    (zone) => {
      expect(isTimeZone(zone)).toBe(true);
    },
  );

  it.each(['Moscow', 'Europe/Mosсow' /* Cyrillic с */, '', 'GMT+25', 'Europe/'])('rejects %j', (zone) => {
    expect(isTimeZone(zone)).toBe(false);
  });
});
