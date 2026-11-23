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
      APP_URL: 'http://localhost:5173',
      NOTIFICATIONS_WORKER: true,
    });
  });

  it('runs the notifications worker unless told not to', () => {
    expect(validateEnv(valid).NOTIFICATIONS_WORKER).toBe(true);
    expect(validateEnv({ ...valid, NOTIFICATIONS_WORKER: 'false' }).NOTIFICATIONS_WORKER).toBe(false);
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

  // A deployment without it would hand out invitation links to localhost.
  it('needs APP_URL in production, and defaults it elsewhere', () => {
    expect(() => validateEnv({ ...valid, NODE_ENV: 'production' })).toThrow(/APP_URL/);
    expect(validateEnv({ ...valid, NODE_ENV: 'production', APP_URL: 'https://app.example.com' }).APP_URL).toBe(
      'https://app.example.com',
    );
    expect(validateEnv({ ...valid, NODE_ENV: 'test' }).APP_URL).toBe('http://localhost:5173');
  });

  it('takes the number of trusted proxy hops, never "trust everything"', () => {
    expect(validateEnv({ ...valid, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
    expect(() => validateEnv({ ...valid, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/);
    expect(() => validateEnv({ ...valid, TRUST_PROXY: '-1' })).toThrow(/TRUST_PROXY/);
  });

  it('takes the Telegram bot token and username together or not at all', () => {
    expect(validateEnv(valid).TELEGRAM_BOT_TOKEN).toBeUndefined();
    const both = { TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_BOT_USERNAME: 'bookedup_bot' };
    expect(validateEnv({ ...valid, ...both })).toMatchObject(both);
    expect(() => validateEnv({ ...valid, TELEGRAM_BOT_TOKEN: '123:abc' })).toThrow(/TELEGRAM_BOT_USERNAME/);
    expect(() => validateEnv({ ...valid, TELEGRAM_BOT_USERNAME: 'bookedup_bot' })).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it('names the missing variable', () => {
    expect(() => validateEnv({ REDIS_URL: valid.REDIS_URL })).toThrow(/DATABASE_URL/);
  });
});
