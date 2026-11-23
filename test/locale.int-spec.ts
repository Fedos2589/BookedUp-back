import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { ownerInput, sessionCookie, signUpOwner } from './helpers.js';
import { createTestApp } from './test-app.js';

let app: INestApplication<App>;

const http = () => request(app.getHttpServer());

// The language cookie the response sets, as `lang=ru`; undefined when none was set.
const langSetCookie = (res: request.Response) =>
  ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('lang='));

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

describe('the language of the account', () => {
  it('is English until chosen, and GET /me says so', async () => {
    const { cookie } = await signUpOwner(app);

    const res = await http().get('/me').set('Cookie', cookie).expect(200);

    expect(res.body.user.locale).toBe('en');
  });

  it('sign-up takes the language the visitor already uses, and sets the cookie', async () => {
    const res = await http()
      .post('/auth/sign-up')
      .send({ ...ownerInput(), locale: 'ru' })
      .expect(201);

    expect(res.body.user.locale).toBe('ru');
    expect(langSetCookie(res)).toMatch(/^lang=ru;/);
  });

  it('sign-in sets the cookie to the account language, so a new device starts in it', async () => {
    const body = { ...ownerInput(), locale: 'ru' };
    await http().post('/auth/sign-up').send(body).expect(201);

    const res = await http().post('/auth/sign-in').send({ email: body.email, password: body.password }).expect(200);

    expect(res.body.user.locale).toBe('ru');
    const header = langSetCookie(res);
    expect(header).toMatch(/^lang=ru;/);
    expect(header).toMatch(/Path=\//);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).not.toMatch(/HttpOnly/i);
  });

  it('PUT /locale saves it for the signed-in user and sets the cookie', async () => {
    const { cookie } = await signUpOwner(app);

    const res = await http().put('/locale').set('Cookie', cookie).send({ locale: 'ru' }).expect(204);

    expect(langSetCookie(res)).toMatch(/^lang=ru;/);
    const account = await http().get('/me').set('Cookie', cookie).expect(200);
    expect(account.body.user.locale).toBe('ru');
  });

  it('PUT /locale sets the cookie for a visitor without an account', async () => {
    const res = await http().put('/locale').send({ locale: 'ru' }).expect(204);

    expect(langSetCookie(res)).toMatch(/^lang=ru;/);
    expect(sessionCookie(res)).toBeUndefined();
  });

  it('refuses a language the front has no texts for', async () => {
    await http().put('/locale').send({ locale: 'de' }).expect(400);
    await http()
      .post('/auth/sign-up')
      .send({ ...ownerInput(), locale: 'de' })
      .expect(400);
  });
});
