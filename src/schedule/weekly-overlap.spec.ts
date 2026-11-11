import { firstOverlap } from './weekly-overlap.js';

const window = (weekday: number, startMinute: number, durationMinutes: number) => ({
  weekday,
  startMinute,
  durationMinutes,
});

describe('firstOverlap', () => {
  it('finds none in a week of windows that only touch or sit apart', () => {
    expect(
      firstOverlap([window(1, 720, 60), window(1, 600, 120), window(2, 600, 120), window(7, 1380, 60)]),
    ).toBeUndefined();
  });

  it('names the two windows of one day that overlap, by their places in the list', () => {
    expect(firstOverlap([window(2, 600, 60), window(1, 600, 120), window(1, 660, 60)])).toEqual([1, 2]);
  });

  it('sees a window past midnight run into the next day', () => {
    expect(firstOverlap([window(3, 1380, 120), window(4, 30, 60)])).toEqual([0, 1]);
  });

  it('sees Sunday night run into Monday morning, the week being a ring', () => {
    expect(firstOverlap([window(1, 0, 60), window(7, 1380, 120)])).toEqual([0, 1]);
    expect(firstOverlap([window(7, 1380, 120), window(1, 0, 60)])).toEqual([0, 1]);
  });
});
