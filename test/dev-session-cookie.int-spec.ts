import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { ownerInput, sessionCookie, sessionSetCookie } from './helpers.js';
import { createTestApp } from './test-app.js';

// Development over plain HTTP from another host (a phone on the LAN): browsers drop a Secure
// cookie there, so SESSION_COOKIE_SECURE=false sets a plain `sid` instead of `__Host-sid`.
let app: INestApplication<App>;

beforeAll(async () => {
  app = await createTestApp({ secureCookie: false });
});

afterAll(async () => {
  await app?.close();
});

describe('session cookie over plain HTTP in development', () => {
  it('is `sid` alone, HttpOnly and not Secure, and signs the owner in', async () => {
    const res = await request(app.getHttpServer()).post('/auth/sign-up').send(ownerInput()).expect(201);

    const header = sessionSetCookie(res, 'sid');
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).not.toMatch(/Secure/i);
    expect(sessionSetCookie(res)).toBeUndefined();

    await request(app.getHttpServer())
      .get('/me')
      .set('Cookie', sessionCookie(res, 'sid') ?? '')
      .expect(200);
  });
});
