import { startOfDay } from './local-time.js';

describe('startOfDay', () => {
  it('is local midnight', () => {
    expect(new Date(startOfDay('Asia/Bangkok', '2030-01-07')).toISOString()).toBe('2030-01-06T17:00:00.000Z');
  });

  it('is the first hour that exists when the clock change skips midnight', () => {
    // São Paulo, 2018-11-04: the clocks jumped from 00:00 to 01:00.
    expect(new Date(startOfDay('America/Sao_Paulo', '2018-11-04')).toISOString()).toBe('2018-11-04T03:00:00.000Z');
  });
});
