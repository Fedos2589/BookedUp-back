import { readCookie } from './client-cookies.js';

describe('readCookie', () => {
  it('finds a cookie among others', () => {
    expect(readCookie('a=1; __Host-cl=secret; b=2', '__Host-cl')).toBe('secret');
  });

  it('does not take a cookie whose name only ends the same', () => {
    expect(readCookie('xcl=1', 'cl')).toBeUndefined();
  });

  it('has nothing without a header or with an empty value', () => {
    expect(readCookie(undefined, 'cl')).toBeUndefined();
    expect(readCookie('cl=', 'cl')).toBeUndefined();
  });
});
