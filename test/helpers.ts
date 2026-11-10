import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';

// A valid sign-up body. Random, not a clock: test files run in parallel against one database.
export const ownerInput = () => {
  const id = randomUUID();
  return {
    email: `owner-${id}@example.com`,
    password: 'correct horse battery',
    name: 'Lena',
    business: { name: 'Studio Lena', slug: `studio-lena-${id}`, timeZone: 'Europe/Moscow' },
  };
};

// `name=value` of the session cookie, as a browser would send it back; undefined when none was set.
export const sessionCookie = (res: request.Response) => {
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  return cookies.find((c) => c.startsWith('__Host-sid='))?.split(';')[0];
};

// A new owner with their business, signed in.
export const signUpOwner = async (app: INestApplication<App>) => {
  const res = await request(app.getHttpServer()).post('/auth/sign-up').send(ownerInput()).expect(201);
  const cookie = sessionCookie(res);
  if (!cookie) throw new Error('sign-up set no session cookie');
  return { cookie, business: res.body.business as { id: string; name: string; slug: string; timeZone: string } };
};
