import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { ownerInput } from './helpers.js';
import { createTestApp } from './test-app.js';

// Development over plain HTTP from another host (a phone on the LAN): browsers drop a Secure
// cookie there, so SESSION_COOKIE_SECURE=false sets a plain `sid` instead of `__Host-sid`.
// Set before AppModule is first imported in this file: the config is read then.
process.env.SESSION_COOKIE_SECURE = 'false';

let app: INestApplication<App>;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  delete process.env.SESSION_COOKIE_SECURE;
});

describe('session cookie over plain HTTP in development', () => {
  it('is `sid`, HttpOnly and not Secure, and signs the owner in', async () => {
    const res = await request(app.getHttpServer()).post('/auth/sign-up').send(ownerInput()).expect(201);

    const header = ([] as string[]).concat(res.headers['set-cookie']).find((c) => c.startsWith('sid='));
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).not.toMatch(/Secure/i);

    await request(app.getHttpServer()).get('/me').set('Cookie', header!.split(';')[0]).expect(200);
  });
});
