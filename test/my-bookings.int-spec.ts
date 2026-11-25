import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { hashRandomToken } from '../src/common/random-token.js';
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

// Tuesday 2030-01-08, Moscow: the master works 10:00–12:00 (07:00Z–09:00Z) in hour slots.
const at = (hour: number) => new Date(`2030-01-08T${String(hour).padStart(2, '0')}:00:00.000Z`);
const slot = (hour: number) => ({ startsAt: at(hour).toISOString(), endsAt: at(hour + 1).toISOString() });

describe('cancel and move my booking', () => {
  const withSchedule = async () => {
    const owner = await signUpOwner(app);
    const businessId = owner.business.id;
    const base = (path: string) => `/businesses/${businessId}/staff/${path}`;
    const http = () => request(app.getHttpServer());
    const staffId = (
      await http()
        .post(`/businesses/${businessId}/staff`)
        .set('Cookie', owner.cookie)
        .send({ name: 'Hana' })
        .expect(201)
    ).body.id as string;
    await http()
      .put(base(`${staffId}/schedule-mode`))
      .set('Cookie', owner.cookie)
      .send({ mode: 'HOURS' })
      .expect(200);
    await http()
      .put(base(`${staffId}/weekly-windows`))
      .set('Cookie', owner.cookie)
      .send({ windows: [{ weekday: 2, startMinute: 600, durationMinutes: 120, slotMinutes: 60, title: null }] })
      .expect(200);
    const session = await clientSession(app);
    const holder = await prisma.client.create({ data: { businessId, name: 'Vera', phone: session.phone } });
    const book = (clientId: string, hour: number, extra: { manageTokenHash?: string } = {}) =>
      prisma.appointment.create({
        data: {
          businessId,
          staffId,
          clientId,
          clientName: 'Vera',
          clientPhone: session.phone,
          ...slot(hour),
          ...extra,
        },
      });
    return { business: owner.business, staffId, session, holder, book };
  };
  const act = (slug: string, id: string, cookie?: string) => {
    const call = (req: request.Test) => (cookie === undefined ? req : req.set('Cookie', cookie));
    const url = `/public/businesses/${slug}/my-bookings/${id}`;
    const http = () => request(app.getHttpServer());
    return {
      cancel: () => call(http().post(`${url}/cancel`)),
      move: (body: object) => call(http().patch(url).send(body)),
    };
  };

  it('cancels its own booking and answers it as the list shows it', async () => {
    const t = await withSchedule();
    const booking = await t.book(t.holder.id, 7);

    const res = await act(t.business.slug, booking.id, t.session.cookie).cancel().expect(201);

    expect(res.body).toMatchObject({ id: booking.id, status: 'CANCELLED', canChange: false, clientName: 'Vera' });
    expect((await prisma.appointment.findFirstOrThrow({ where: { id: booking.id } })).status).toBe('CANCELLED');
  });

  it('moves its own booking, and the manage link of it still works', async () => {
    const t = await withSchedule();
    const token = 'm'.repeat(43);
    const booking = await t.book(t.holder.id, 7, { manageTokenHash: hashRandomToken(token) });

    const res = await act(t.business.slug, booking.id, t.session.cookie).move(slot(8)).expect(200);

    expect(res.body).toMatchObject({ id: booking.id, ...slot(8), staffId: t.staffId, canChange: true });
    await request(app.getHttpServer())
      .get(`/public/bookings/${token}`)
      .expect(200)
      .expect((r) => expect(r.body.booking).toMatchObject(slot(8)));
  });

  it('is 404 for another phone’s booking and leaves it as it was', async () => {
    const t = await withSchedule();
    const stranger = await clientSession(app);
    const booking = await t.book(t.holder.id, 7);

    await act(t.business.slug, booking.id, stranger.cookie).cancel().expect(404);
    await act(t.business.slug, booking.id, stranger.cookie).move(slot(8)).expect(404);

    expect(await prisma.appointment.findFirstOrThrow({ where: { id: booking.id } })).toMatchObject({
      status: 'BOOKED',
      startsAt: at(7),
    });
  });

  it('is 404 for the same phone’s booking at another business', async () => {
    const t = await withSchedule();
    const other = await withSchedule();
    const booking = await other.book(
      (await prisma.client.create({ data: { businessId: other.business.id, name: 'Vera', phone: t.session.phone } }))
        .id,
      7,
    );

    await act(t.business.slug, booking.id, t.session.cookie).cancel().expect(404);
    expect((await prisma.appointment.findFirstOrThrow({ where: { id: booking.id } })).status).toBe('BOOKED');
  });

  it('is 409 badTransition for a started booking, 401 without a session, 400 for a bad body', async () => {
    const t = await withSchedule();
    const started = await prisma.appointment.create({
      data: {
        businessId: t.business.id,
        staffId: t.staffId,
        clientId: t.holder.id,
        clientName: 'Vera',
        clientPhone: t.session.phone,
        startsAt: new Date(Date.now() - HOUR / 2),
        endsAt: new Date(Date.now() + HOUR / 2),
      },
    });
    const booking = await t.book(t.holder.id, 7);

    expect((await act(t.business.slug, started.id, t.session.cookie).cancel().expect(409)).body.code).toBe(
      'badTransition',
    );
    await act(t.business.slug, booking.id).cancel().expect(401);
    await act(t.business.slug, booking.id, t.session.cookie).move({ startsAt: 'x' }).expect(400);
  });
});
