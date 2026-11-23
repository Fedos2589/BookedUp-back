import { hashRandomToken, newRandomToken } from './random-token.js';

describe('a random token', () => {
  it('is 256 random bits, URL-safe, and never the same twice', () => {
    expect(newRandomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newRandomToken()).not.toBe(newRandomToken());
  });

  it('is stored as the SHA-256 hex of it', () => {
    expect(hashRandomToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
