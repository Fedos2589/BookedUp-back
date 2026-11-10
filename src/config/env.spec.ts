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
    });
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
