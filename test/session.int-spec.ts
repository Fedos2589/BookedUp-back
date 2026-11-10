import { SignInService } from '@nestjs/authentication';
import { type INestApplication, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { AccountService } from '../src/account/account.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ownerInput, sessionCookie, sessionSetCookie } from './helpers.js';
import { createTestApp } from './test-app.js';

let app: INestApplication<App>;

const owner = ownerInput;

const http = () => request(app.getHttpServer());
const signUp = (body: object) => http().post('/auth/sign-up').send(body);
const signIn = (email: string, password: string) => http().post('/auth/sign-in').send({ email, password });
const me = (cookie?: string) => (cookie ? http().get('/me').set('Cookie', cookie) : http().get('/me'));

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

describe('sessions', () => {
  it('signs the owner in on sign-up, with an HttpOnly cookie', async () => {
    const res = await signUp(owner()).expect(201);

    const header = sessionSetCookie(res);
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/Secure/i);
    expect(header).toMatch(/SameSite=Lax/i);
  });

  it('GET /me answers the account and its businesses to the session cookie', async () => {
    const body = owner();
    const res = await signUp(body).expect(201);

    await me(sessionCookie(res))
      .expect(200)
      .expect({
        user: { id: res.body.user.id, email: body.email, name: 'Lena' },
        businesses: [{ ...res.body.business, role: 'OWNER' }],
      });
  });

  it('GET /me answers 401 without a session', async () => {
    await me().expect(401);
    await me('__Host-sid=forged').expect(401);
  });

  it('signs in with the password, whatever the case of the email', async () => {
    const body = owner();
    const created = await signUp(body).expect(201);

    const res = await signIn(body.email.toUpperCase(), body.password).expect(200);

    expect(res.body).toEqual({
      user: created.body.user,
      businesses: [{ ...created.body.business, role: 'OWNER' }],
    });
    await me(sessionCookie(res)).expect(200);
  });

  it('answers a wrong password and an unknown email the same way', async () => {
    const body = owner();
    await signUp(body).expect(201);

    const wrongPassword = await signIn(body.email, 'not the password').expect(401);
    const unknownEmail = await signIn(`nobody-${randomUUID()}@example.com`, body.password).expect(401);

    expect(wrongPassword.body).toEqual(unknownEmail.body);
    expect(sessionCookie(wrongPassword)).toBeUndefined();
  });

  it('answers 400 to a password the hasher would refuse, not 500', async () => {
    const res = await signIn(`x-${randomUUID()}@example.com`, 'ﷺ'.repeat(130)).expect(400);

    expect(res.body.message.join('\n')).toContain('password:');
  });

  it('signs out: the cookie stops working', async () => {
    const cookie = sessionCookie(await signUp(owner()).expect(201))!;

    await http().post('/auth/sign-out').set('Cookie', cookie).expect(204);

    await me(cookie).expect(401);
  });

  // Signing out is idempotent: someone back after a week, with an expired cookie, presses
  // "Sign out" and is signed out, not shown an error.
  it('answers 204 to a sign-out without a live session', async () => {
    await http().post('/auth/sign-out').expect(204);
    await http().post('/auth/sign-out').set('Cookie', '__Host-sid=expired').expect(204);
  });

  // The account is committed before the session is made: a failure there must not look
  // like a failed sign-up, or the retry meets "email already registered".
  it('answers 201 without a cookie when the account is created but signing in fails', async () => {
    const body = owner();
    const signInSpy = vi.spyOn(app.get(SignInService), 'signIn').mockRejectedValueOnce(new Error('db down'));

    const res = await signUp(body).expect(201);

    expect(signInSpy).toHaveBeenCalledOnce();
    expect(sessionCookie(res)).toBeUndefined();
    await signIn(body.email, body.password).expect(200);
  });

  it('answers 401, not 500, for an account that is gone', async () => {
    await expect(app.get(AccountService).describe(randomUUID())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('documents the 403 and 429 every write and every route can get', async () => {
    const { SwaggerModule, DocumentBuilder } = await import('@nestjs/swagger');
    const doc = SwaggerModule.createDocument(app, new DocumentBuilder().build());

    expect(Object.keys(doc.paths['/auth/sign-out']?.post?.responses ?? {})).toEqual(
      expect.arrayContaining(['204', '403', '429']),
    );
    expect(Object.keys(doc.paths['/me']?.get?.responses ?? {})).toEqual(expect.arrayContaining(['200', '401', '429']));
  });

  it("refuses a sign-in posted from another site's page (login CSRF)", async () => {
    const body = owner();
    await signUp(body).expect(201);

    await http()
      .post('/auth/sign-in')
      .set('Origin', 'https://evil.example')
      .set('Sec-Fetch-Site', 'cross-site')
      .send({ email: body.email, password: body.password })
      .expect(403);
  });

  it("refuses a sign-up posted from another site's page before creating anything", async () => {
    const body = owner();

    await http()
      .post('/auth/sign-up')
      .set('Origin', 'https://evil.example')
      .set('Sec-Fetch-Site', 'cross-site')
      .send(body)
      .expect(403);

    expect(await app.get(PrismaService).user.findUnique({ where: { email: body.email } })).toBeNull();
  });

  it('keeps /health public', async () => {
    await http().get('/health').expect(200);
  });
});

describe('rate limits', () => {
  let throttled: INestApplication<App>;

  beforeAll(async () => {
    throttled = await createTestApp({ throttle: true });
  });

  afterAll(async () => {
    await throttled.close();
  });

  it('stops guessing at one account after 5 sign-ins in 15 minutes', async () => {
    const email = `target-${randomUUID()}@example.com`;
    const attempt = () => request(throttled.getHttpServer()).post('/auth/sign-in').send({ email, password: 'guess' });

    for (let i = 0; i < 5; i++) await attempt().expect(401);

    await attempt().expect(429);
  });

  // The throttler guard sits before the authentication guard, so guessed cookies are
  // counted too, not just answered 401.
  it('counts requests with a guessed cookie: 429 after 100 a minute', async () => {
    const guess = () => request(throttled.getHttpServer()).get('/me').set('Cookie', '__Host-sid=guess');
    for (let i = 0; i < 100; i++) await guess().expect(401);

    await guess().expect(429);
  });

  // The per-account limits are for routes that check a password; a body with an email
  // elsewhere (sign-up, invitations later) is not counted per account.
  it('does not count other routes with an email per account', async () => {
    const body = owner();
    const send = () => request(throttled.getHttpServer()).post('/auth/sign-up').send(body);
    await send().expect(201);

    for (let i = 0; i < 6; i++) await send().expect(409);
  });
});
