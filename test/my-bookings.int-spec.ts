import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { PrismaService } from '../src/prisma/prisma.service.js';
import { clientSession, signUpOwner } from './helpers.js';
import { createTestApp } from './test-app.js';

let app: INestApplication<App>;
let prisma: PrismaService;

beforeAll(async () => {
  app = await createTestApp();
  prisma = app.get(PrismaService);
});

afterAll(async () => {
  await app.close();
});

const HOUR = 3600_000;
const phoneOf = () => `+7999${randomUUID().replace(/\D/g, '').padEnd(7, '1').slice(0, 7)}`;

// A business with one master; `book` writes a booking straight to the table.
const setUp = async () => {
  const { business } = await signUpOwner(app);
  const staff = await prisma.staff.create({ data: { businessId: business.id, name: 'Hana' } });
  const card = (name: string, data: { phone?: string; guardianId?: string } = {}, businessId = business.id) =>
    prisma.client.create({ data: { businessId, name, ...data } });
  const book = async (
    clientId: string,
    clientName: string,
    { inHours = 24, status = 'BOOKED', businessId = business.id, staffId = staff.id } = {},
    clientPhone = '+79990000001',
  ) => {
    const startsAt = new Date(Date.now() + inHours * HOUR);
    return prisma.appointment.create({
      data: {
        businessId,
        staffId,
        clientId,
        clientName,
        clientPhone,
        startsAt,
        endsAt: new Date(startsAt.getTime() + HOUR),
        status: status as 'BOOKED',
      },
    });
  };
  return { business, staff, card, book };
};

const mine = (slug: string, cookie?: string) => {
  const req = request(app.getHttpServer()).get(`/public/businesses/${slug}/my-bookings`);
  return cookie === undefined ? req : req.set('Cookie', cookie);
};

describe('GET /public/businesses/:slug/my-bookings', () => {
  it('lists the phone’s own bookings and its dependents’, earliest first, with whose they are', async () => {
    const t = await setUp();
    const session = await clientSession(app);
    const holder = await t.card('Vera', { phone: session.phone });
    const child = await t.card('Misha', { guardianId: holder.id });
    const later = await t.book(holder.id, 'Vera', { inHours: 48 });
    const dependents = await t.book(child.id, 'Misha', { inHours: 24 });

    const res = await mine(t.business.slug, session.cookie).expect(200);

    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.bookings).toEqual([
      {
        id: dependents.id,
        clientName: 'Misha',
        staffId: t.staff.id,
        staffName: 'Hana',
        startsAt: dependents.startsAt.toISOString(),
        endsAt: dependents.endsAt.toISOString(),
        title: null,
        status: 'BOOKED',
        groupId: null,
        oneOffSessionId: null,
        canChange: true,
      },
      expect.objectContaining({ id: later.id, clientName: 'Vera' }),
    ]);
  });

  it('leaves out another phone’s, another business’s, past and cancelled bookings', async () => {
    const t = await setUp();
    const other = await setUp();
    const session = await clientSession(app);
    const holder = await t.card('Vera', { phone: session.phone });
    const stranger = await t.card('Olga', { phone: phoneOf() });
    const strangersChild = await t.card('Kid', { guardianId: stranger.id });
    const sameInOther = await other.card('Vera', { phone: session.phone });
    const wanted = await t.book(holder.id, 'Vera');
    await t.book(stranger.id, 'Olga', { inHours: 30 });
    await t.book(strangersChild.id, 'Kid', { inHours: 36 });
    await t.book(holder.id, 'Vera', { status: 'CANCELLED' });
    await t.book(holder.id, 'Vera', { inHours: -5 });
    await other.book(sameInOther.id, 'Vera', { businessId: other.business.id, staffId: other.staff.id });

    const res = await mine(t.business.slug, session.cookie).expect(200);

    expect(res.body.bookings.map((b: { id: string }) => b.id)).toEqual([wanted.id]);
  });

  it('is an empty list for a phone with no bookings, 401 without a session, 404 for an unknown slug', async () => {
    const t = await setUp();
    const session = await clientSession(app);

    await mine(t.business.slug, session.cookie).expect(200).expect({ bookings: [] });
    const res = await mine(t.business.slug).expect(401);
    expect(res.body).toMatchObject({ code: 'clientSignIn' });
    await mine('no-such-business-at-all', session.cookie).expect(404);
  });
});
