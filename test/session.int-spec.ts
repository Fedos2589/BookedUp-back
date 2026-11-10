import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { PrismaService } from '../src/prisma/prisma.service.js';
import { createTestApp } from './test-app.js';

let app: INestApplication<App>;

let seq = 0;
const unique = () => `${Date.now()}${++seq}`;

const owner = () => {
  const id = unique();
  return {
    email: `owner-${id}@example.com`,
    password: 'correct horse battery',
    name: 'Lena',
    business: { name: 'Studio Lena', slug: `studio-lena-${id}`, timeZone: 'Europe/Moscow' },
  };
};

const http = () => request(app.getHttpServer());
const signUp = (body: object) => http().post('/auth/sign-up').send(body);
const signIn = (email: string, password: string) => http().post('/auth/sign-in').send({ email, password });
const me = (cookie?: string) => (cookie ? http().get('/me').set('Cookie', cookie) : http().get('/me'));

// `name=value` of the session cookie, as a browser would send it back.
const sessionCookie = (res: request.Response) => {
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  return cookies.find((c) => c.startsWith('__Host-sid='))?.split(';')[0];
};

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

describe('sessions', () => {
  it('signs the owner in on sign-up, with an HttpOnly cookie', async () => {
    const res = await signUp(owner()).expect(201);

    const header = ([] as string[]).concat(res.headers['set-cookie']).find((c) => c.startsWith('__Host-sid='));
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
    const unknownEmail = await signIn(`nobody-${unique()}@example.com`, body.password).expect(401);

    expect(wrongPassword.body).toEqual(unknownEmail.body);
    expect(sessionCookie(wrongPassword)).toBeUndefined();
  });

  it('answers 400 to a password the hasher would refuse, not 500', async () => {
    const res = await signIn(`x-${unique()}@example.com`, 'ﷺ'.repeat(130)).expect(400);

    expect(res.body.message.join('\n')).toContain('password:');
  });

  it('signs out: the cookie stops working', async () => {
    const cookie = sessionCookie(await signUp(owner()).expect(201))!;

    await http().post('/auth/sign-out').set('Cookie', cookie).expect(204);

    await me(cookie).expect(401);
  });

  it('answers 401 to a sign-out without a session', async () => {
    await http().post('/auth/sign-out').expect(401);
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
    const email = `target-${unique()}@example.com`;
    const attempt = () => request(throttled.getHttpServer()).post('/auth/sign-in').send({ email, password: 'guess' });

    for (let i = 0; i < 5; i++) await attempt().expect(401);

    await attempt().expect(429);
  });
});
