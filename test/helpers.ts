import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import type { PrismaClient } from '../src/generated/prisma/client.js';
import type { MemberRole } from '../src/generated/prisma/enums.js';
import { ClientCookies } from '../src/client-session/client-cookies.js';
import { ClientSessionsService } from '../src/client-session/client-sessions.service.js';
import { hashRandomToken, newRandomToken } from '../src/common/random-token.js';
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
  return {
    cookie,
    business: res.body.business as {
      id: string;
      name: string;
      slug: string;
      timeZone: string;
      reminderOffsets: number[];
    },
  };
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

// The client of `businessId` with `phone` (made on the first call, found after): what a booking
// written straight to the database points at. The same call twice is the same client.
// The default phone puts every booking of a business on one client: a test that counts per client
// (no-shows, history) passes its own phones.
export const createClient = async (prisma: PrismaClient, businessId: string, phone = '+79991234567') =>
  (
    await prisma.client.upsert({
      where: { businessId_phone: { businessId, phone } },
      create: { businessId, name: 'Olga', phone },
      update: {},
      select: { id: true },
    })
  ).id;

// A business with one master and one online booking written straight to the database; returns the booking's
// manage token (what the booker's link carries) with the ids.
export const onlineBooking = async (
  app: INestApplication<App>,
  { status = 'BOOKED' as 'BOOKED' | 'CANCELLED', startsAt = new Date(Date.now() + 86_400_000) } = {},
) => {
  const prisma = app.get(PrismaService);
  const owner = await signUpOwner(app);
  const businessId = owner.business.id;
  const staff = await request(app.getHttpServer())
    .post(`/businesses/${businessId}/staff`)
    .set('Cookie', owner.cookie)
    .send({ name: 'Hana' })
    .expect(201);
  const token = newRandomToken();
  const created = await prisma.appointment.create({
    data: {
      businessId,
      clientId: await createClient(prisma, businessId),
      staffId: staff.body.id as string,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3600_000),
      clientName: 'Vera',
      clientPhone: '+79991234567',
      status,
      manageTokenHash: hashRandomToken(token),
    },
  });
  return { token, business: owner.business, appointmentId: created.id, clientId: created.clientId };
};

// A confirmed client's session, as a browser holds it after the Telegram sign-in: the row is written
// through the service the sign-in uses, the cookie is what the browser sends back.
export const clientSession = async (
  app: INestApplication<App>,
  phone?: string,
  chatId = '5550001',
  locale: 'en' | 'ru' = 'en',
) => {
  const booked = phone ?? `+7999${randomUUID().replace(/\D/g, '').padEnd(7, '1').slice(0, 7)}`;
  const token = await app.get(ClientSessionsService).create(app.get(PrismaService), { phone: booked, chatId, locale });
  return { cookie: `${app.get(ClientCookies).sessionName}=${token}`, phone: booked, chatId };
};

// POST /public/businesses/:slug/bookings as the client whose phone is `body.phone` (a new random one when
// absent): the phone is no part of the request any more, it comes from the session made here. Awaits and
// chains `.expect(status)` like a supertest request.
export const bookAsClient = (
  app: INestApplication<App>,
  slug: string,
  body: { phone?: string } & Record<string, unknown>,
) => new LazyBooking(app, slug, body);

class LazyBooking implements PromiseLike<request.Response> {
  private readonly expected: number[] = [];

  constructor(
    private readonly app: INestApplication<App>,
    private readonly slug: string,
    private readonly body: { phone?: string } & Record<string, unknown>,
  ) {}

  expect(status: number): this {
    this.expected.push(status);
    return this;
  }

  // oxlint-disable-next-line unicorn/no-thenable -- the point: `await` and `.expect()` work as on a supertest request
  then<R1 = request.Response, R2 = never>(
    onfulfilled?: ((value: request.Response) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.run().then(onfulfilled, onrejected);
  }

  private async run(): Promise<request.Response> {
    const { phone, ...rest } = this.body;
    const session = await clientSession(this.app, phone);
    let req = request(this.app.getHttpServer())
      .post(`/public/businesses/${this.slug}/bookings`)
      .set('Cookie', session.cookie)
      .send(rest);
    for (const status of this.expected) req = req.expect(status);
    return req;
  }
}
