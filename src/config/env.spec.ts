import { validateEnv } from './env.js';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
};

describe('validateEnv', () => {
  it('applies defaults and coerces the port', () => {
    expect(validateEnv({ ...valid, PORT: '8080' })).toEqual({
      ...valid,
      NODE_ENV: 'development',
      PORT: 8080,
      TRUST_PROXY: 0,
      SESSION_COOKIE_SECURE: true,
    });
  });

  it('keeps the session cookie Secure unless told otherwise', () => {
    expect(validateEnv({ ...valid, SESSION_COOKIE_SECURE: 'false' }).SESSION_COOKIE_SECURE).toBe(false);
    expect(validateEnv({ ...valid, SESSION_COOKIE_SECURE: 'true' }).SESSION_COOKIE_SECURE).toBe(true);
    expect(() => validateEnv({ ...valid, SESSION_COOKIE_SECURE: 'no-thanks' })).toThrow(/SESSION_COOKIE_SECURE/);
  });

  it('refuses a session cookie without Secure in production', () => {
    expect(() => validateEnv({ ...valid, NODE_ENV: 'production', SESSION_COOKIE_SECURE: 'false' })).toThrow(
      /SESSION_COOKIE_SECURE/,
    );
  });

  it('takes the number of trusted proxy hops, never "trust everything"', () => {
    expect(validateEnv({ ...valid, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
    expect(() => validateEnv({ ...valid, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/);
    expect(() => validateEnv({ ...valid, TRUST_PROXY: '-1' })).toThrow(/TRUST_PROXY/);
  });

  it('names the missing variable', () => {
    expect(() => validateEnv({ REDIS_URL: valid.REDIS_URL })).toThrow(/DATABASE_URL/);
  });
});
