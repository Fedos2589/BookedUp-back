import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { hashRandomToken, newRandomToken } from '../src/common/random-token.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createClient, signUpOwner } from './helpers.js';
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

// Public routes are called the way a visitor does: no cookie.
const http = () => request(app.getHttpServer());

describe('GET /public/businesses/:slug', () => {
  it('answers the business and its live masters by name, without a session', async () => {
    const { business } = await signUpOwner(app);
    const [zoe, adam] = await Promise.all(
      ['Zoe', 'Adam'].map((name) =>
        prisma.staff.create({ data: { businessId: business.id, name }, select: { id: true } }),
      ),
    );
    await prisma.staff.create({ data: { businessId: business.id, name: 'Gone', archivedAt: new Date() } });

    const res = await http().get(`/public/businesses/${business.slug}`).expect(200);

    expect(res.body).toEqual({
      name: business.name,
      slug: business.slug,
      timeZone: business.timeZone,
      masters: [
        { id: adam!.id, name: 'Adam', scheduleMode: 'HOURS' },
        { id: zoe!.id, name: 'Zoe', scheduleMode: 'HOURS' },
      ],
    });
  });

  it("doesn't list another business's masters", async () => {
    const mine = await signUpOwner(app);
    const other = await signUpOwner(app);
    await prisma.staff.create({ data: { businessId: other.business.id, name: 'Elsewhere' } });

    const res = await http().get(`/public/businesses/${mine.business.slug}`).expect(200);

    expect(res.body.masters).toEqual([]);
  });

  it('is 404 for an unknown slug and 400 for a malformed one', async () => {
    await http().get('/public/businesses/no-such-business-at-all').expect(404);
    await http().get('/public/businesses/A_B').expect(400);
  });

  it('is in Swagger under public-booking', async () => {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    const operation = document.paths['/public/businesses/{slug}']?.get;
    expect(operation?.tags).toEqual(['public-booking']);
  });
});

// Tuesday 2030-01-08, Moscow (UTC+3): hours from 10:00 (07:00Z), a group meeting at 15:00 (12:00Z).
const tuesday = '2030-01-08';
const at = (hour: number) => new Date(`${tuesday}T${String(hour).padStart(2, '0')}:00:00.000Z`);

const withSchedules = async () => {
  const owner = await signUpOwner(app);
  const businessId = owner.business.id;
  const as = (req: request.Test) => req.set('Cookie', owner.cookie);
  const master = async (name: string, mode: 'HOURS' | 'GROUPS') => {
    const id = (await as(http().post(`/businesses/${businessId}/staff`).send({ name })).expect(201)).body.id as string;
    await as(http().put(`/businesses/${businessId}/staff/${id}/schedule-mode`).send({ mode })).expect(200);
    return { id, base: `/businesses/${businessId}/staff/${id}` };
  };
  const hours = await master('Hana', 'HOURS');
  await as(
    http()
      .put(`${hours.base}/weekly-windows`)
      .send({ windows: [{ weekday: 2, startMinute: 600, durationMinutes: 120, slotMinutes: 60, title: null }] }),
  ).expect(200);
  const groups = await master('Gus', 'GROUPS');
  const group = (
    await as(
      http()
        .post(`${groups.base}/groups`)
        .send({
          title: 'Football',
          description: null,
          weekdays: [2],
          startMinute: 900,
          durationMinutes: 60,
          capacity: 5,
        }),
    ).expect(201)
  ).body.id as string;
  const book = async (staffId: string, startsAt: Date, extra: { groupId?: string } = {}) =>
    prisma.appointment.create({
      data: {
        businessId,
        clientId: await createClient(prisma, businessId),
        staffId,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3600_000),
        clientName: 'Olga',
        clientPhone: '+79991234567',
        ...extra,
      },
    });
  const addHours = async (name: string) => {
    const created = await master(name, 'HOURS');
    await as(
      http()
        .put(`${created.base}/weekly-windows`)
        .send({ windows: [{ weekday: 2, startMinute: 600, durationMinutes: 120, slotMinutes: 60, title: null }] }),
    ).expect(200);
    return created;
  };
  return { business: owner.business, cookie: owner.cookie, addHours, hours, groups, group, book };
};

describe('GET /public/businesses/:slug/slots', () => {
  const slotsOf = (slug: string, query: Record<string, string> = {}) =>
    http()
      .get(`/public/businesses/${slug}/slots`)
      .query({ from: tuesday, to: tuesday, ...query });

  it('answers free hours and meetings with their counts, and nothing of the clients', async () => {
    const t = await withSchedules();
    await t.book(t.hours.id, at(7));
    await t.book(t.groups.id, at(12), { groupId: t.group });

    const res = await slotsOf(t.business.slug).expect(200);

    expect(res.body).toEqual([
      expect.objectContaining({ staffId: t.hours.id, startsAt: at(8).toISOString(), capacity: 1, booked: 0 }),
      expect.objectContaining({
        staffId: t.groups.id,
        startsAt: at(12).toISOString(),
        title: 'Football',
        capacity: 5,
        booked: 1,
        full: false,
        groupId: t.group,
      }),
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/Olga|79991234567/);
  });

  it("gives an empty list for another business's master", async () => {
    const mine = await withSchedules();
    const other = await withSchedules();

    const res = await slotsOf(mine.business.slug, { staffId: other.hours.id }).expect(200);

    expect(res.body).toEqual([]);
  });

  it('is 400 for more than 31 days (31 is fine) and 404 for an unknown slug', async () => {
    const t = await withSchedules();
    await slotsOf(t.business.slug, { to: '2030-02-17' }).expect(400);
    await slotsOf(t.business.slug, { to: '2030-02-07' }).expect(200);
    await slotsOf('no-such-business-at-all').expect(404);
  });

  it('never looks back: includePast is not offered', async () => {
    const t = await withSchedules();
    const res = await http()
      .get(`/public/businesses/${t.business.slug}/slots`)
      .query({ from: '2020-01-07', to: '2020-01-07', includePast: 'true' })
      .expect(200);
    expect(res.body).toEqual([]);
  });
});

describe('POST /public/businesses/:slug/bookings', () => {
  const phoneOf = () => `+7999${randomUUID().replace(/\D/g, '').padEnd(7, '1').slice(0, 7)}`;
  const bookingsOf = (slug: string) => http().post(`/public/businesses/${slug}/bookings`);
  const hoursBody = (t: Awaited<ReturnType<typeof withSchedules>>, hour: number, who = {}) => ({
    staffId: t.hours.id,
    startsAt: at(hour).toISOString(),
    endsAt: at(hour + 1).toISOString(),
    name: 'Vera',
    phone: phoneOf(),
    ...who,
  });

  it('books an hours slot by name and phone, and the owner sees it with the typed name', async () => {
    const t = await withSchedules();
    const body = hoursBody(t, 7);

    const res = await bookingsOf(t.business.slug).send(body).expect(201);

    expect(res.body).toEqual({
      booking: {
        id: expect.any(String),
        staffId: t.hours.id,
        staffName: 'Hana',
        startsAt: body.startsAt,
        endsAt: body.endsAt,
        title: null,
        groupId: null,
        oneOffSessionId: null,
      },
      manageLink: expect.stringMatching(/^http:\/\/localhost:5173\/book\/.+\/manage\/[\w-]{43}$/),
    });
    const stored = await prisma.appointment.findFirstOrThrow({ where: { id: res.body.booking.id } });
    expect(stored).toMatchObject({ businessId: t.business.id, clientName: 'Vera', clientPhone: body.phone });
    expect(stored.manageTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.manageLink).not.toContain(stored.manageTokenHash);
  });

  it('takes a seat in a meeting and names it', async () => {
    const t = await withSchedules();
    const res = await bookingsOf(t.business.slug)
      .send({
        staffId: t.groups.id,
        startsAt: at(12).toISOString(),
        endsAt: at(13).toISOString(),
        groupId: t.group,
        name: 'Vera',
        phone: phoneOf(),
      })
      .expect(201);
    expect(res.body.booking).toMatchObject({ title: 'Football', groupId: t.group, staffName: 'Gus' });
  });

  it('puts a known phone on the same client and leaves the card name alone; the answer has the same keys', async () => {
    const t = await withSchedules();
    const known = phoneOf();
    const clientId = await createClient(prisma, t.business.id, known); // card name «Olga»

    const first = await bookingsOf(t.business.slug)
      .send(hoursBody(t, 7, { phone: known }))
      .expect(201);
    const second = await bookingsOf(t.business.slug).send(hoursBody(t, 8)).expect(201);

    const stored = await prisma.appointment.findFirstOrThrow({ where: { id: first.body.booking.id } });
    expect(stored).toMatchObject({ clientId, clientName: 'Vera' });
    expect((await prisma.client.findFirstOrThrow({ where: { id: clientId } })).name).toBe('Olga');
    expect(Object.keys(first.body.booking)).toEqual(Object.keys(second.body.booking));
    expect(Object.keys(first.body)).toEqual(Object.keys(second.body));
  });

  it('lets one of two parallel requests for one hours slot in, the other is 409 notFree', async () => {
    const t = await withSchedules();
    const results = await Promise.all([1, 2].map(() => bookingsOf(t.business.slug).send(hoursBody(t, 7))));
    expect(results.map((res) => res.status).sort((a, b) => a - b)).toEqual([201, 409]);
    expect(results.find((res) => res.status === 409)?.body.code).toBe('notFree');
  });

  it('lets one of two parallel requests for the last seat in, the other is 409 full', async () => {
    const t = await withSchedules();
    const seat = {
      staffId: t.groups.id,
      startsAt: at(12).toISOString(),
      endsAt: at(13).toISOString(),
      groupId: t.group,
    };
    for (let i = 0; i < 4; i++) {
      await t.book(t.groups.id, at(12), { groupId: t.group });
    }
    const results = await Promise.all(
      [1, 2].map(() => bookingsOf(t.business.slug).send({ ...seat, name: 'Vera', phone: phoneOf() })),
    );
    expect(results.map((res) => res.status).sort((a, b) => a - b)).toEqual([201, 409]);
    expect(results.find((res) => res.status === 409)?.body.code).toBe('full');
  });

  it('ends on one client when two masters are booked at once with one new phone', async () => {
    const t = await withSchedules();
    const ivan = await t.addHours('Ivan');
    const phone = phoneOf();
    const results = await Promise.all([
      bookingsOf(t.business.slug).send(hoursBody(t, 7, { phone })),
      bookingsOf(t.business.slug).send(hoursBody(t, 7, { phone, staffId: ivan.id })),
    ]);
    expect(results.map((res) => res.status)).toEqual([201, 201]);
    expect(await prisma.client.count({ where: { businessId: t.business.id, phone } })).toBe(1);
  });

  it('refuses a 4th live future booking of one phone with 409 tooManyBookings', async () => {
    const t = await withSchedules();
    const phone = phoneOf();
    const clientId = await createClient(prisma, t.business.id, phone);
    for (const day of [1, 2, 3]) {
      const startsAt = new Date(at(7).getTime() + day * 86_400_000);
      await prisma.appointment.create({
        data: {
          businessId: t.business.id,
          clientId,
          staffId: t.hours.id,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 3600_000),
          clientName: 'Vera',
          clientPhone: phone,
        },
      });
    }

    const res = await bookingsOf(t.business.slug)
      .send(hoursBody(t, 7, { phone }))
      .expect(409);
    expect(res.body.code).toBe('tooManyBookings');
    // Someone else's phone, and a cancelled booking, don't count.
    await bookingsOf(t.business.slug).send(hoursBody(t, 7)).expect(201);
    await prisma.appointment.updateMany({ where: { clientId }, data: { status: 'CANCELLED' } });
    await bookingsOf(t.business.slug)
      .send(hoursBody(t, 8, { phone }))
      .expect(201);
  });

  it('is 404 for an unknown slug, 400 for a bad phone or a missing name, and 409 for another business’s master', async () => {
    const t = await withSchedules();
    const other = await withSchedules();
    await bookingsOf('no-such-business-at-all').send(hoursBody(t, 7)).expect(404);
    await bookingsOf(t.business.slug)
      .send(hoursBody(t, 7, { phone: '123' }))
      .expect(400);
    await bookingsOf(t.business.slug)
      .send(hoursBody(t, 7, { name: '' }))
      .expect(400);
    const res = await bookingsOf(t.business.slug)
      .send(hoursBody(t, 7, { staffId: other.hours.id }))
      .expect(409);
    expect(res.body.code).toBe('notFree');
  });

  it('is in the cabinet list under the typed name', async () => {
    const t = await withSchedules();
    await bookingsOf(t.business.slug).send(hoursBody(t, 7)).expect(201);
    const res = await http()
      .get(`/businesses/${t.business.id}/appointments`)
      .query({ from: tuesday, to: tuesday })
      .set('Cookie', t.cookie)
      .expect(200);
    expect(res.body).toEqual([expect.objectContaining({ clientName: 'Vera', staffId: t.hours.id })]);
  });

  describe('without a staffId: any free master', () => {
    const anyBody = (hour: number) => ({
      startsAt: at(hour).toISOString(),
      endsAt: at(hour + 1).toISOString(),
      name: 'Vera',
      phone: phoneOf(),
    });

    it('gives the time to the master with fewer bookings that day', async () => {
      const t = await withSchedules();
      const ivan = await t.addHours('Ivan');
      await t.book(t.hours.id, at(8)); // Hana already has one

      const res = await bookingsOf(t.business.slug).send(anyBody(7)).expect(201);

      expect(res.body.booking).toMatchObject({ staffId: ivan.id, staffName: 'Ivan' });
    });

    it('moves on to the next master when the first is taken, and is 409 notFree when none is left', async () => {
      const t = await withSchedules();
      await t.addHours('Ivan');
      const results = await Promise.all([1, 2, 3].map(() => bookingsOf(t.business.slug).send(anyBody(7))));
      expect(results.map((res) => res.status).sort((a, b) => a - b)).toEqual([201, 201, 409]);
      const masters = results.filter((res) => res.status === 201).map((res) => res.body.booking.staffId);
      expect(new Set(masters).size).toBe(2);
      expect(results.find((res) => res.status === 409)?.body.code).toBe('notFree');
    });

    it("never picks a GROUPS master's meeting, nor a master who is off the team", async () => {
      const t = await withSchedules();
      // Gus has a meeting at 12:00Z (15:00 Moscow), no hours slot there.
      await bookingsOf(t.business.slug).send(anyBody(12)).expect(409);
      await prisma.staff.update({ where: { id: t.hours.id }, data: { archivedAt: new Date() } });
      await bookingsOf(t.business.slug).send(anyBody(7)).expect(409);
    });

    it('is 400 with a groupId or a oneOffSessionId', async () => {
      const t = await withSchedules();
      await bookingsOf(t.business.slug)
        .send({ ...anyBody(12), groupId: t.group })
        .expect(400);
      await bookingsOf(t.business.slug)
        .send({ ...anyBody(12), oneOffSessionId: randomUUID() })
        .expect(400);
    });
  });
});

describe('see and cancel by the link', () => {
  const phoneOf = () => `+7999${randomUUID().replace(/\D/g, '').padEnd(7, '1').slice(0, 7)}`;
  const tokenOf = (link: string) => link.split('/').pop()!;
  const bookOnline = async (t: Awaited<ReturnType<typeof withSchedules>>, hour: number) => {
    const res = await http()
      .post(`/public/businesses/${t.business.slug}/bookings`)
      .send({
        staffId: t.hours.id,
        startsAt: at(hour).toISOString(),
        endsAt: at(hour + 1).toISOString(),
        name: 'Vera',
        phone: phoneOf(),
      })
      .expect(201);
    return { id: res.body.booking.id as string, token: tokenOf(res.body.manageLink) };
  };
  // A booking with a known token that started already (the slots are in 2030, so a past one is made by hand).
  const startedBooking = async (t: Awaited<ReturnType<typeof withSchedules>>) => {
    const token = newRandomToken();
    const startsAt = new Date(Date.now() - 3600_000);
    await prisma.appointment.create({
      data: {
        businessId: t.business.id,
        clientId: await createClient(prisma, t.business.id),
        staffId: t.hours.id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 7200_000),
        clientName: 'Vera',
        clientPhone: phoneOf(),
        manageTokenHash: hashRandomToken(token),
      },
    });
    return token;
  };

  it('shows the booking, its business and whether it can still change, and nothing of clients', async () => {
    const t = await withSchedules();
    const { id, token } = await bookOnline(t, 7);

    const res = await http().get(`/public/bookings/${token}`).expect(200);

    expect(res.body).toEqual({
      business: { name: t.business.name, slug: t.business.slug, timeZone: t.business.timeZone },
      booking: {
        staffId: t.hours.id,
        staffName: 'Hana',
        startsAt: at(7).toISOString(),
        endsAt: at(8).toISOString(),
        title: null,
        status: 'BOOKED',
        groupId: null,
        oneOffSessionId: null,
      },
      canChange: true,
    });
    expect(JSON.stringify(res.body)).not.toMatch(new RegExp(`Vera|\\+7999|${id}`));
  });

  it('cancels: the cabinet sees CANCELLED, the hour is free in public slots again, a second cancel is 409', async () => {
    const t = await withSchedules();
    const { id, token } = await bookOnline(t, 7);

    const res = await http().post(`/public/bookings/${token}/cancel`).expect(201);

    expect(res.body).toMatchObject({ booking: { status: 'CANCELLED' }, canChange: false });
    expect((await prisma.appointment.findFirstOrThrow({ where: { id } })).status).toBe('CANCELLED');
    const slots = await http()
      .get(`/public/businesses/${t.business.slug}/slots`)
      .query({ from: tuesday, to: tuesday })
      .expect(200);
    expect(slots.body).toContainEqual(expect.objectContaining({ staffId: t.hours.id, startsAt: at(7).toISOString() }));
    const again = await http().post(`/public/bookings/${token}/cancel`).expect(409);
    expect(again.body.code).toBe('badTransition');
  });

  it('refuses to cancel a booking that has started, and shows canChange false', async () => {
    const t = await withSchedules();
    const token = await startedBooking(t);

    expect((await http().get(`/public/bookings/${token}`).expect(200)).body.canChange).toBe(false);
    const res = await http().post(`/public/bookings/${token}/cancel`).expect(409);
    expect(res.body.code).toBe('badTransition');
  });

  it('cannot reach a cabinet booking, which has no token, or a bad token', async () => {
    const t = await withSchedules();
    const booking = await t.book(t.hours.id, at(7));
    await http().get(`/public/bookings/${booking.id}`).expect(400);
    await http().get(`/public/bookings/${newRandomToken()}`).expect(404);
    await http().post(`/public/bookings/${newRandomToken()}/cancel`).expect(404);
    await http().get('/public/bookings/short').expect(400);
    expect((await prisma.appointment.findFirstOrThrow({ where: { id: booking.id } })).status).toBe('BOOKED');
  });
});
