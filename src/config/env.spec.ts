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

  it('wants the Telegram webhook secret in production once the bot token is set', () => {
    const prod = { ...valid, NODE_ENV: 'production', APP_URL: 'https://app.example.com' };
    const bot = { TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_BOT_USERNAME: 'bookedup_bot' };
    expect(() => validateEnv({ ...prod, ...bot })).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
    expect(validateEnv({ ...prod, ...bot, TELEGRAM_WEBHOOK_SECRET: 's' }).TELEGRAM_WEBHOOK_SECRET).toBe('s');
    expect(validateEnv(prod).TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(validateEnv({ ...valid, ...bot }).TELEGRAM_WEBHOOK_SECRET).toBeUndefined();
  });

  it('takes the three VAPID settings together or not at all, the subject a mailto: or https URL', () => {
    const vapid = { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'mailto:ops@example.com' };
    expect(validateEnv(valid).VAPID_PUBLIC_KEY).toBeUndefined();
    expect(validateEnv({ ...valid, ...vapid })).toMatchObject(vapid);
    expect(validateEnv({ ...valid, ...vapid, VAPID_SUBJECT: 'https://example.com' }).VAPID_SUBJECT).toBe(
      'https://example.com',
    );
    for (const gone of Object.keys(vapid)) {
      const rest = Object.fromEntries(Object.entries(vapid).filter(([key]) => key !== gone));
      expect(() => validateEnv({ ...valid, ...rest })).toThrow(/VAPID/);
    }
    expect(() => validateEnv({ ...valid, ...vapid, VAPID_SUBJECT: 'ops@example.com' })).toThrow(/VAPID_SUBJECT/);
  });

  it('takes the two email settings together or not at all', () => {
    const email = { RESEND_API_KEY: 're_key', MAIL_FROM: 'BookedUp <no-reply@example.com>' };
    expect(validateEnv(valid).RESEND_API_KEY).toBeUndefined();
    expect(validateEnv({ ...valid, ...email })).toMatchObject(email);
    expect(() => validateEnv({ ...valid, RESEND_API_KEY: 're_key' })).toThrow(/RESEND_API_KEY/);
    expect(() => validateEnv({ ...valid, MAIL_FROM: 'BookedUp <no-reply@example.com>' })).toThrow(/MAIL_FROM/);
  });

  it('takes the two WhatsApp settings together or not at all', () => {
    const whatsapp = { WHATSAPP_TOKEN: 'token', WHATSAPP_PHONE_NUMBER_ID: '1234567890' };
    expect(validateEnv(valid).WHATSAPP_TOKEN).toBeUndefined();
    expect(validateEnv({ ...valid, ...whatsapp })).toMatchObject(whatsapp);
    expect(() => validateEnv({ ...valid, WHATSAPP_TOKEN: 'token' })).toThrow(/WHATSAPP/);
    expect(() => validateEnv({ ...valid, WHATSAPP_PHONE_NUMBER_ID: '1234567890' })).toThrow(/WHATSAPP/);
  });

  it('names the missing variable', () => {
    expect(() => validateEnv({ REDIS_URL: valid.REDIS_URL })).toThrow(/DATABASE_URL/);
  });
});
