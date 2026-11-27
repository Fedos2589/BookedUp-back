import { PasswordHasher } from '@nestjs/authentication';
import type { INestApplication } from '@nestjs/common';
import type { MockInstance } from 'vitest';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { hashRandomToken } from '../src/common/random-token.js';
import { PasswordResetService } from '../src/auth/password-reset.service.js';
import { Mailer } from '../src/mail/mailer.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ownerInput, sessionCookie } from './helpers.js';
import { createTestApp } from './test-app.js';

let app: INestApplication<App>;
let prisma: PrismaService;
let send: MockInstance<Mailer['send']>;

const http = () => request(app.getHttpServer());

const signUp = async (locale?: 'en' | 'ru') => {
  const body = { ...ownerInput(), ...(locale ? { locale } : {}) };
  await http().post('/auth/sign-up').send(body).expect(201);
  const user = await prisma.user.findUniqueOrThrow({ where: { email: body.email } });
  return { email: body.email, userId: user.id };
};

const resetsOf = (userId: string) => prisma.passwordReset.findMany({ where: { userId } });
const lettersTo = (email: string) => send.mock.calls.filter(([mail]) => mail.to === email);

// The letter is sent after the answer, not awaited.
const letterTo = async (email: string) => {
  await vi.waitFor(() => expect(lettersTo(email)).toHaveLength(1));
  return lettersTo(email)[0]![0];
};

beforeAll(async () => {
  app = await createTestApp();
  prisma = app.get(PrismaService);
  const mailer = app.get(Mailer);
  vi.spyOn(mailer, 'isOn').mockReturnValue(true);
  send = vi.spyOn(mailer, 'send').mockResolvedValue('sent');
});

afterAll(async () => {
  await app.close();
});

describe('POST /auth/password-reset', () => {
  it('a known email: 204, one stored hash, a letter with the link in the user’s language', async () => {
    const { email, userId } = await signUp('ru');

    const res = await http().post('/auth/password-reset').send({ email }).expect(204);

    expect(res.headers['set-cookie']).toBeUndefined();
    const mail = await letterTo(email);
    const token = /\/reset-password\/([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/.exec(mail.text)?.[1];
    expect(token).toBeDefined();
    expect(mail.text).toMatch(/[а-я]/i);
    const rows = await resetsOf(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(hashRandomToken(token!));
    expect(rows[0]!.tokenHash).not.toBe(token);
    const hourMs = 3_600_000;
    expect(Math.abs(+rows[0]!.expiresAt - (Date.now() + hourMs))).toBeLessThan(60_000);
  });

  it('the letter is English for an English account', async () => {
    const { email } = await signUp();

    await http().post('/auth/password-reset').send({ email }).expect(204);

    const mail = await letterTo(email);
    expect(mail.text).toContain('reset the password');
  });

  it('an unknown email: the same 204, no row, no letter', async () => {
    const email = `nobody-${crypto.randomUUID()}@example.com`;
    const before = await prisma.passwordReset.count();

    const res = await http().post('/auth/password-reset').send({ email }).expect(204);

    expect(res.body).toEqual({});
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await prisma.passwordReset.count()).toBe(before);
    await new Promise((r) => setTimeout(r, 50));
    expect(lettersTo(email)).toHaveLength(0);
  });

  it('two requests within a minute: one row, one letter', async () => {
    const { email, userId } = await signUp();

    await http().post('/auth/password-reset').send({ email }).expect(204);
    await http().post('/auth/password-reset').send({ email }).expect(204);

    await letterTo(email);
    await new Promise((r) => setTimeout(r, 50));
    expect(await resetsOf(userId)).toHaveLength(1);
    expect(lettersTo(email)).toHaveLength(1);
  });

  it('many requests in parallel: one row, one letter', async () => {
    const { email, userId } = await signUp();
    const service = app.get(PasswordResetService);

    await Promise.all(Array.from({ length: 10 }, () => service.request(email)));

    await letterTo(email);
    await new Promise((r) => setTimeout(r, 50));
    expect(await resetsOf(userId)).toHaveLength(1);
    expect(lettersTo(email)).toHaveLength(1);
  });

  it('waits while another request of the same user is in progress (the per-user lock)', async () => {
    const { email, userId } = await signUp();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let acquired!: () => void;
    const locked = new Promise<void>((resolve) => (acquired = resolve));
    const other = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId}::text, 0))`;
      acquired();
      await held;
    });
    await locked;

    const pending = app.get(PasswordResetService).request(email);
    await new Promise((r) => setTimeout(r, 200));
    expect(await resetsOf(userId)).toHaveLength(0);

    release();
    await other;
    await pending;
    expect(await resetsOf(userId)).toHaveLength(1);
  });

  it('after the cooldown the old row is gone and a new one takes its place', async () => {
    const { email, userId } = await signUp();
    await http().post('/auth/password-reset').send({ email }).expect(204);
    const [old] = await resetsOf(userId);
    await prisma.$executeRaw`UPDATE password_resets SET created_at = now() - interval '2 minutes' WHERE id = ${old!.id}::uuid`;

    await http().post('/auth/password-reset').send({ email }).expect(204);

    const rows = await resetsOf(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).not.toBe(old!.id);
    await vi.waitFor(() => expect(lettersTo(email)).toHaveLength(2));
  });

  it('an email of 255 characters is a 400', async () => {
    const email = `${'a'.repeat(243)}@example.com`;
    expect(email).toHaveLength(255);

    await http().post('/auth/password-reset').send({ email }).expect(400);
  });

  it('without a mail key the link goes nowhere and the request still answers 204', async () => {
    const { email, userId } = await signUp();
    vi.spyOn(app.get(Mailer), 'isOn').mockReturnValueOnce(false);
    const calls = send.mock.calls.length;

    await http().post('/auth/password-reset').send({ email }).expect(204);

    expect(await resetsOf(userId)).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(send.mock.calls.length).toBe(calls);
  });

  it('a failed send does not fail the request', async () => {
    const { email } = await signUp();
    send.mockRejectedValueOnce(new Error('Email: no answer'));

    await http().post('/auth/password-reset').send({ email }).expect(204);
  });
});

describe('POST /auth/password-reset/confirm', () => {
  const NEW_PASSWORD = 'a brand new password';

  // Signs up, asks for the link and takes the token out of the letter, as the person would.
  const askedFor = async () => {
    const body = ownerInput();
    const signedUp = await http().post('/auth/sign-up').send(body).expect(201);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: body.email } });
    await http().post('/auth/password-reset').send({ email: body.email }).expect(204);
    const mail = await letterTo(body.email);
    const token = /\/reset-password\/([A-Za-z0-9_-]{43})/.exec(mail.text)![1]!;
    return { ...body, userId: user.id, token, oldCookie: sessionCookie(signedUp)! };
  };

  const confirm = (token: string, password = NEW_PASSWORD) =>
    http().post('/auth/password-reset/confirm').send({ token, password });

  it('sets the new password: the old one stops working, the new one signs in', async () => {
    const { email, password, token } = await askedFor();

    const res = await confirm(token).expect(204);

    expect(res.headers['set-cookie']).toBeUndefined();
    await http().post('/auth/sign-in').send({ email, password }).expect(401);
    await http().post('/auth/sign-in').send({ email, password: NEW_PASSWORD }).expect(200);
  });

  it('ends every earlier session of the user, in any browser', async () => {
    const { oldCookie, email, password, token } = await askedFor();
    const other = await http().post('/auth/sign-in').send({ email, password }).expect(200);
    await http().get('/me').set('Cookie', oldCookie).expect(200);

    await confirm(token).expect(204);

    await http().get('/me').set('Cookie', oldCookie).expect(401);
    await http().get('/me').set('Cookie', sessionCookie(other)!).expect(401);
  });

  it('works once: the same token again is a 404 resetLinkInvalid', async () => {
    const { token, userId } = await askedFor();
    await confirm(token).expect(204);

    const res = await confirm(token, 'another new password').expect(404);

    expect(res.body).toMatchObject({ code: 'resetLinkInvalid' });
    expect(await resetsOf(userId)).toHaveLength(0);
  });

  it('an expired link is the same 404, and the password stays', async () => {
    const { token, userId, email, password } = await askedFor();
    await prisma.$executeRaw`UPDATE password_resets SET expires_at = now() - interval '1 second' WHERE user_id = ${userId}::uuid`;

    const res = await confirm(token).expect(404);

    expect(res.body).toMatchObject({ code: 'resetLinkInvalid' });
    await http().post('/auth/sign-in').send({ email, password }).expect(200);
  });

  it('an unknown token is the same 404, and costs no password hash', async () => {
    const hash = vi.spyOn(app.get(PasswordHasher), 'hash');

    const res = await confirm('A'.repeat(43)).expect(404);

    expect(hash).not.toHaveBeenCalled();

    expect(res.body).toMatchObject({ code: 'resetLinkInvalid' });
  });

  it('two confirms with one token in parallel: one 204, one 404', async () => {
    const { token } = await askedFor();

    const results = await Promise.all([confirm(token), confirm(token, 'second new password')]);

    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([204, 404]);
  });

  it('a password under 8 characters or a malformed token is a 400', async () => {
    const { token } = await askedFor();

    await confirm(token, '1234567').expect(400);
    await confirm('short').expect(400);
    // The link was not spent by the refusals.
    await confirm(token).expect(204);
  });
});
