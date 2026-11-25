import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { generateVAPIDKeys } from 'web-push';

import { hashRandomToken, newRandomToken } from '../src/common/random-token.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { bookAsClient, clientSession, createClient, onlineBooking, signUpOwner } from './helpers.js';
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
      channels: { telegram: false, whatsapp: false, push: false, email: false },
      pushKey: null,
      masters: [
        { id: adam!.id, name: 'Adam', scheduleMode: 'HOURS' },
        { id: zoe!.id, name: 'Zoe', scheduleMode: 'HOURS' },
      ],
      clientSignIn: false,
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
  const bookingsOf = (slug: string) => ({
    send: (body: { phone?: string } & Record<string, unknown>) => bookAsClient(app, slug, body),
  });
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
      phone: body.phone,
      manageLink: expect.stringMatching(/^http:\/\/localhost:5173\/book\/.+\/manage\/[\w-]{43}$/),
    });
    const stored = await prisma.appointment.findFirstOrThrow({ where: { id: res.body.booking.id } });
    expect(stored).toMatchObject({ businessId: t.business.id, clientName: 'Vera', clientPhone: body.phone });
    expect(stored.manageTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.manageLink).not.toContain(stored.manageTokenHash);
  });

  it('is 401 clientSignIn without a client session, and with only the cabinet’s', async () => {
    const t = await withSchedules();
    const { phone: _, ...body } = hoursBody(t, 7);
    const post = () => http().post(`/public/businesses/${t.business.slug}/bookings`).send(body);

    const res = await post().expect(401);
    expect(res.body).toMatchObject({ code: 'clientSignIn' });
    await post().set('Cookie', t.cookie).expect(401);
    expect(await prisma.appointment.count({ where: { businessId: t.business.id } })).toBe(0);
  });

  it('books on the session’s phone whatever phone the body carries, and says which phone', async () => {
    const t = await withSchedules();
    const session = await clientSession(app);

    const res = await http()
      .post(`/public/businesses/${t.business.slug}/bookings`)
      .set('Cookie', session.cookie)
      .send(hoursBody(t, 7, { phone: '+79990000000' }))
      .expect(201);

    expect(res.body.phone).toBe(session.phone);
    const stored = await prisma.appointment.findFirstOrThrow({ where: { id: res.body.booking.id } });
    expect(stored.clientPhone).toBe(session.phone);
    expect(await prisma.client.count({ where: { businessId: t.business.id, phone: '+79990000000' } })).toBe(0);
  });

  describe('the confirmed Telegram chat', () => {
    const cardChannels = (businessId: string, clientId: string) =>
      prisma.clientChannel.findMany({ where: { businessId, clientId, kind: 'TELEGRAM', appointmentId: null } });

    it('joins the client’s card with the locale, and the BOOKED event is delivered to it', async () => {
      const t = await withSchedules();
      const session = await clientSession(app, undefined, '777001');

      const res = await http()
        .post(`/public/businesses/${t.business.slug}/bookings`)
        .set('Cookie', session.cookie)
        .send(hoursBody(t, 7, { locale: 'ru' }))
        .expect(201);

      const stored = await prisma.appointment.findFirstOrThrow({ where: { id: res.body.booking.id } });
      const [card] = await cardChannels(t.business.id, stored.clientId);
      expect(card).toMatchObject({ address: '777001', locale: 'ru', disabledAt: null, optedOutAt: null });
      const events = await prisma.notificationEvent.findMany({ where: { appointmentId: stored.id } });
      expect(events.map((e) => e.kind)).toEqual(['BOOKED']);
    });

    it('stays switched off when the client switched it off: a new booking does not turn it back on', async () => {
      const t = await withSchedules();
      const session = await clientSession(app, undefined, '777002');
      const first = await http()
        .post(`/public/businesses/${t.business.slug}/bookings`)
        .set('Cookie', session.cookie)
        .send(hoursBody(t, 7))
        .expect(201);
      const { clientId } = await prisma.appointment.findFirstOrThrow({ where: { id: first.body.booking.id } });
      const off = new Date();
      await prisma.clientChannel.updateMany({
        where: { businessId: t.business.id, clientId, kind: 'TELEGRAM' },
        data: { disabledAt: off, optedOutAt: off },
      });

      await http()
        .post(`/public/businesses/${t.business.slug}/bookings`)
        .set('Cookie', session.cookie)
        .send(hoursBody(t, 8))
        .expect(201);

      const rows = await cardChannels(t.business.id, clientId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ disabledAt: off, optedOutAt: off });
    });
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

  it('is 404 for an unknown slug, 400 for a missing name or an unknown locale, and 409 for another business’s master', async () => {
    const t = await withSchedules();
    const other = await withSchedules();
    await bookingsOf('no-such-business-at-all').send(hoursBody(t, 7)).expect(404);
    await bookingsOf(t.business.slug)
      .send(hoursBody(t, 7, { locale: 'xx' }))
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
    const res = await bookAsClient(app, t.business.slug, {
      staffId: t.hours.id,
      startsAt: at(hour).toISOString(),
      endsAt: at(hour + 1).toISOString(),
      name: 'Vera',
    }).expect(201);
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
      notifications: { telegram: true, whatsapp: false, push: [], email: null },
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

  describe('move', () => {
    const slot = (hour: number) => ({ startsAt: at(hour).toISOString(), endsAt: at(hour + 1).toISOString() });
    const moveTo = (token: string, body: object) => http().patch(`/public/bookings/${token}`).send(body);

    it('moves to another free hour: the old one frees, the new one is taken', async () => {
      const t = await withSchedules();
      const { id, token } = await bookOnline(t, 7);

      const res = await moveTo(token, slot(8)).expect(200);

      expect(res.body).toMatchObject({
        booking: { ...slot(8), staffId: t.hours.id, status: 'BOOKED' },
        canChange: true,
      });
      expect(await prisma.appointment.findFirstOrThrow({ where: { id } })).toMatchObject({ startsAt: at(8) });
      const slots = await http()
        .get(`/public/businesses/${t.business.slug}/slots`)
        .query({ from: tuesday, to: tuesday })
        .expect(200);
      const starts = slots.body
        .filter((each: { staffId: string }) => each.staffId === t.hours.id)
        .map((each: { startsAt: string }) => each.startsAt);
      expect(starts).toEqual([at(7).toISOString()]);
    });

    it('is 409 full into a full meeting and leaves the booking where it was', async () => {
      const t = await withSchedules();
      const { id, token } = await bookOnline(t, 7);
      for (let i = 0; i < 5; i++) await t.book(t.groups.id, at(12), { groupId: t.group });

      const res = await moveTo(token, { staffId: t.groups.id, ...slot(12), groupId: t.group }).expect(409);

      expect(res.body.code).toBe('full');
      expect(await prisma.appointment.findFirstOrThrow({ where: { id } })).toMatchObject({
        startsAt: at(7),
        staffId: t.hours.id,
      });
    });

    it("never moves into another business's master", async () => {
      const t = await withSchedules();
      const other = await withSchedules();
      const { id, token } = await bookOnline(t, 7);

      await moveTo(token, { staffId: other.hours.id, ...slot(8) }).expect(409);

      expect(await prisma.appointment.findFirstOrThrow({ where: { id } })).toMatchObject({
        staffId: t.hours.id,
        startsAt: at(7),
      });
    });

    it('is 409 badTransition for a started or a cancelled booking, 404 for an unknown token, 400 for a bad body', async () => {
      const t = await withSchedules();
      const started = await startedBooking(t);
      expect((await moveTo(started, slot(8)).expect(409)).body.code).toBe('badTransition');
      const { token } = await bookOnline(t, 7);
      await http().post(`/public/bookings/${token}/cancel`).expect(201);
      expect((await moveTo(token, slot(8)).expect(409)).body.code).toBe('badTransition');
      await moveTo(newRandomToken(), slot(8)).expect(404);
      await moveTo(token, { startsAt: 'x' }).expect(400);
    });
  });
});

describe('GET /public/businesses/:slug/manifest.webmanifest', () => {
  it("is the business's own installable app: its name, scope and start_url of its page", async () => {
    const { business } = await signUpOwner(app);
    await prisma.business.update({ where: { id: business.id }, data: { name: 'Студия Огонёк и компания' } });

    const res = await http().get(`/public/businesses/${business.slug}/manifest.webmanifest`).expect(200);

    expect(res.headers['content-type']).toMatch(/^application\/manifest\+json/);
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    expect(JSON.parse(res.text)).toMatchObject({
      id: `/book/${business.slug}`,
      name: 'Студия Огонёк и компания',
      short_name: 'Студия Огонё',
      start_url: `/book/${business.slug}`,
      scope: `/book/${business.slug}`,
      display: 'standalone',
      icons: expect.arrayContaining([expect.objectContaining({ src: '/pwa-192.png' })]),
    });
  });

  it('is 404 for an unknown slug', async () => {
    const res = await http().get('/public/businesses/no-such-business-at-all/manifest.webmanifest').expect(404);

    // A 404 must not be cached for an hour: the business may be signed up a minute later.
    expect(res.headers['cache-control']).toBeUndefined();
    expect(res.headers['content-type']).not.toMatch(/manifest/);
  });
});

describe('which channels are on', () => {
  // The channels are read from the environment when the app is built: a second app has every key, the first none.
  const vapid = generateVAPIDKeys();
  const KEYS = {
    TELEGRAM_BOT_TOKEN: '123:test-token',
    TELEGRAM_BOT_USERNAME: 'bookedup_test_bot',
    TELEGRAM_WEBHOOK_SECRET: 'secret',
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_SUBJECT: 'mailto:ops@example.com',
    WHATSAPP_TOKEN: 'wa-token',
    WHATSAPP_PHONE_NUMBER_ID: '1234',
    RESEND_API_KEY: 're_key',
    MAIL_FROM: 'no-reply@example.com',
  };
  let keyed: INestApplication<App>;
  beforeAll(async () => {
    Object.assign(process.env, KEYS);
    keyed = await createTestApp();
    for (const key of Object.keys(KEYS)) delete process.env[key];
  });
  afterAll(async () => {
    await keyed.close();
  });

  it('shows the business page which channels it can offer, and the key a browser subscribes with', async () => {
    const { business } = await signUpOwner(app);

    const on = await request(keyed.getHttpServer()).get(`/public/businesses/${business.slug}`).expect(200);
    const off = await http().get(`/public/businesses/${business.slug}`).expect(200);

    expect(on.body).toMatchObject({
      channels: { telegram: true, whatsapp: true, push: true, email: true },
      pushKey: vapid.publicKey,
      clientSignIn: true,
    });
    expect(JSON.stringify(on.body)).not.toContain(vapid.privateKey);
    expect(off.body).toMatchObject({
      channels: { telegram: false, whatsapp: false, push: false, email: false },
      pushKey: null,
    });
  });

  const channel = (b: Awaited<ReturnType<typeof onlineBooking>>, data: object) =>
    prisma.clientChannel.create({
      data: { businessId: b.business.id, clientId: b.clientId, locale: 'en', kind: 'TELEGRAM', address: 'x', ...data },
    });

  it('shows a booking what is on for it: its own channels, the card’s WhatsApp, the email masked', async () => {
    const b = await onlineBooking(app);
    const appointmentId = b.appointmentId;
    const keys = { p256dh: 'a', auth: 'b' };
    await channel(b, { appointmentId, kind: 'TELEGRAM', address: '777' });
    await channel(b, { appointmentId, kind: 'PUSH', address: 'https://push.example/on', keys });
    await channel(b, {
      appointmentId,
      kind: 'PUSH',
      address: 'https://push.example/off',
      keys,
      disabledAt: new Date(),
    });
    await channel(b, { appointmentId, kind: 'EMAIL', address: 'maria.k@example.com' });
    await channel(b, { appointmentId: null, kind: 'WHATSAPP', address: '+79991234567' });

    const res = await http().get(`/public/bookings/${b.token}`).expect(200);

    expect(res.body.notifications).toEqual({
      telegram: true,
      whatsapp: true,
      push: ['https://push.example/on'],
      email: 'm***@example.com',
    });
    expect(JSON.stringify(res.body)).not.toContain('maria.k');
  });

  it('shows the Telegram on the client’s card as on', async () => {
    const b = await onlineBooking(app);
    await channel(b, { appointmentId: null, kind: 'TELEGRAM', address: '555' });

    const res = await http().get(`/public/bookings/${b.token}`).expect(200);

    expect(res.body.notifications.telegram).toBe(true);
  });

  it('does not show the WhatsApp of another client of the business', async () => {
    const b = await onlineBooking(app);
    const stranger = await createClient(prisma, b.business.id, '+79990009999');
    await channel(b, { clientId: stranger, appointmentId: null, kind: 'WHATSAPP', address: '+79990009999' });

    const res = await http().get(`/public/bookings/${b.token}`).expect(200);

    expect(res.body.notifications.whatsapp).toBe(false);
  });

  it('does not show another booking of the same phone its Telegram, push or email, only the card’s WhatsApp', async () => {
    const b = await onlineBooking(app);
    const first = await prisma.appointment.findUniqueOrThrow({ where: { id: b.appointmentId } });
    await channel(b, { appointmentId: first.id, kind: 'TELEGRAM', address: '888' });
    await channel(b, { appointmentId: first.id, kind: 'EMAIL', address: 'maria.k@example.com' });
    await channel(b, { appointmentId: null, kind: 'WHATSAPP', address: first.clientPhone });
    const token = newRandomToken();
    await prisma.appointment.create({
      data: {
        businessId: first.businessId,
        clientId: first.clientId,
        staffId: first.staffId,
        startsAt: new Date(first.startsAt.getTime() + 7200_000),
        endsAt: new Date(first.endsAt.getTime() + 7200_000),
        clientName: first.clientName,
        clientPhone: first.clientPhone,
        manageTokenHash: hashRandomToken(token),
      },
    });

    const res = await http().get(`/public/bookings/${token}`).expect(200);

    expect(res.body.notifications).toEqual({ telegram: false, whatsapp: true, push: [], email: null });
  });
});
