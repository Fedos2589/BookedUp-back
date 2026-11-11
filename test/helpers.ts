import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import type { MemberRole } from '../src/generated/prisma/enums.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

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

// The Set-Cookie header of the session cookie; undefined when none was set. `sid` is its name
// with SESSION_COOKIE_SECURE=false.
export const sessionSetCookie = (res: request.Response, name = '__Host-sid') => {
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  return cookies.find((c) => c.startsWith(`${name}=`));
};

// `name=value` of the session cookie, as a browser would send it back; undefined when none was set.
export const sessionCookie = (res: request.Response, name?: string) => sessionSetCookie(res, name)?.split(';')[0];

// A new owner with their business, signed in.
export const signUpOwner = async (app: INestApplication<App>) => {
  const res = await request(app.getHttpServer()).post('/auth/sign-up').send(ownerInput()).expect(201);
  const cookie = sessionCookie(res);
  if (!cookie) throw new Error('sign-up set no session cookie');
  return { cookie, business: res.body.business as { id: string; name: string; slug: string; timeZone: string } };
};

// The signed-in user's id, as the front learns it.
export const userIdOf = async (app: INestApplication<App>, cookie: string) =>
  ((await request(app.getHttpServer()).get('/me').set('Cookie', cookie).expect(200)).body as { user: { id: string } })
    .user.id;

// Someone with an account of their own who is also a member of `businessId` with `role`,
// written straight to the database: what the tests of other features need, without going
// through an invitation.
export const memberOf = async (app: INestApplication<App>, businessId: string, role: MemberRole) => {
  const someone = await signUpOwner(app);
  const userId = await userIdOf(app, someone.cookie);
  await app.get(PrismaService).membership.create({ data: { businessId, userId, role } });
  return { cookie: someone.cookie, userId };
};
