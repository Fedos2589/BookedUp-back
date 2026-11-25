import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { PrismaService } from '../src/prisma/prisma.service.js';
import { isoWeekday, startOfDay, todayIn } from '../src/schedule/local-time.js';
import { bookAsClient, signUpOwner, userIdOf } from './helpers.js';
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

const http = () => request(app.getHttpServer());

// A Monday far ahead, Moscow (UTC+3): the window is 10:00–13:00 in hourly slots, the first at 07:00Z.
const slot = (index: number) => ({
  startsAt: `2030-01-07T${String(7 + index).padStart(2, '0')}:00:00.000Z`,
  endsAt: `2030-01-07T${String(8 + index).padStart(2, '0')}:00:00.000Z`,
});
const phone = () => `+7999${randomUUID().replace(/\D/g, '').padEnd(7, '1').slice(0, 7)}`;

const setUp = async () => {
  const owner = await signUpOwner(app);
  const businessId = owner.business.id;
  const as = (req: request.Test) => req.set('Cookie', owner.cookie);
  const staffId = (await as(http().post(`/businesses/${businessId}/staff`).send({ name: 'Anna' })).expect(201)).body
    .id as string;
  await as(
    http()
      .put(`/businesses/${businessId}/staff/${staffId}/weekly-windows`)
      .send({ windows: [{ weekday: 1, startMinute: 600, durationMinutes: 180, slotMinutes: 60, title: null }] }),
  ).expect(200);
  const url = `/businesses/${businessId}/appointments`;
  const book = (index: number) =>
    as(
      http()
        .post(url)
        .send({ staffId, ...slot(index), newClient: { name: 'Olga', phone: phone() } }),
    );
  const bookOnline = (index: number) =>
    bookAsClient(app, owner.business.slug, { staffId, ...slot(index), name: 'Vera', phone: phone() });
  const events = () =>
    prisma.$queryRaw<
      { kind: string; actor_user_id: string | null; starts_at: Date; appointment_id: string; payload: unknown }[]
    >`
      SELECT kind, actor_user_id, starts_at, appointment_id, payload FROM notification_events
      WHERE business_id = ${businessId}::uuid ORDER BY created_at, id`;
  return { owner, businessId, staffId, as, url, book, bookOnline, events };
};

describe('an event with every booking change', () => {
  it('writes BOOKED with the actor for a booking made in the cabinet', async () => {
    const t = await setUp();

    const res = await t.book(0).expect(201);

    expect(await t.events()).toEqual([
      {
        kind: 'BOOKED',
        actor_user_id: await userIdOf(app, t.owner.cookie),
        starts_at: new Date(slot(0).startsAt),
        appointment_id: res.body.id,
        payload: null,
      },
    ]);
  });

  it('writes BOOKED with no actor for a booking made online', async () => {
    const t = await setUp();

    const res = await t.bookOnline(0).expect(201);

    expect(await t.events()).toMatchObject([
      { kind: 'BOOKED', actor_user_id: null, appointment_id: res.body.booking.id },
    ]);
  });

  it('writes nothing when the slot is taken', async () => {
    const t = await setUp();
    await t.book(0).expect(201);

    await t.book(0).expect(409);
    await t.bookOnline(0).expect(409);

    expect(await t.events()).toHaveLength(1);
  });

  it('writes MOVED with the new start, for a move in the cabinet and for one by the link', async () => {
    const t = await setUp();
    const id = (await t.book(0).expect(201)).body.id as string;
    await t
      .as(
        http()
          .patch(`${t.url}/${id}`)
          .send({ ...slot(1) }),
      )
      .expect(200);

    const online = await t.bookOnline(2).expect(201);
    const token = (online.body.manageLink as string).split('/').pop();
    await http()
      .patch(`/public/bookings/${token}`)
      .send({ ...slot(0) })
      .expect(200);

    const [, moved, , movedOnline] = await t.events();
    expect(moved).toMatchObject({
      kind: 'MOVED',
      actor_user_id: await userIdOf(app, t.owner.cookie),
      starts_at: new Date(slot(1).startsAt),
      appointment_id: id,
      // Where it was: the old master and time can't be read from the booking any more.
      payload: { fromStaffId: t.staffId, fromStartsAt: slot(0).startsAt },
    });
    expect(movedOnline).toMatchObject({ kind: 'MOVED', actor_user_id: null, starts_at: new Date(slot(0).startsAt) });
  });

  it('remembers the old master when the booking goes to another one', async () => {
    const t = await setUp();
    const id = (await t.book(0).expect(201)).body.id as string;
    const other = (await t.as(http().post(`/businesses/${t.businessId}/staff`).send({ name: 'Boris' })).expect(201))
      .body.id as string;
    await t
      .as(
        http()
          .put(`/businesses/${t.businessId}/staff/${other}/weekly-windows`)
          .send({ windows: [{ weekday: 1, startMinute: 600, durationMinutes: 180, slotMinutes: 60, title: null }] }),
      )
      .expect(200);

    await t
      .as(
        http()
          .patch(`${t.url}/${id}`)
          .send({ staffId: other, ...slot(0) }),
      )
      .expect(200);

    expect((await t.events())[1]).toMatchObject({
      kind: 'MOVED',
      payload: { fromStaffId: t.staffId, fromStartsAt: slot(0).startsAt },
    });
  });

  it('writes nothing for a move to where the booking already is', async () => {
    const t = await setUp();
    const id = (await t.book(0).expect(201)).body.id as string;

    await t
      .as(
        http()
          .patch(`${t.url}/${id}`)
          .send({ ...slot(0) }),
      )
      .expect(200);

    expect(await t.events()).toHaveLength(1);
  });

  it('writes nothing for a move into a taken slot', async () => {
    const t = await setUp();
    await t.book(0).expect(201);
    const id = (await t.book(1).expect(201)).body.id as string;

    await t
      .as(
        http()
          .patch(`${t.url}/${id}`)
          .send({ ...slot(0) }),
      )
      .expect(409);

    expect(await t.events()).toHaveLength(2);
  });

  it('writes CANCELLED for a cancel in the cabinet and one by the link; DONE and NO_SHOW write none', async () => {
    const t = await setUp();
    const id = (await t.book(0).expect(201)).body.id as string;
    await t.as(http().patch(`${t.url}/${id}/status`).send({ status: 'CANCELLED' })).expect(200);
    const online = await t.bookOnline(1).expect(201);
    await http()
      .post(`/public/bookings/${(online.body.manageLink as string).split('/').pop()}/cancel`)
      .expect(201);

    const kinds = (await t.events()).map((each) => `${each.kind}:${each.actor_user_id === null ? 'client' : 'actor'}`);
    expect(kinds).toEqual(['BOOKED:actor', 'CANCELLED:actor', 'BOOKED:client', 'CANCELLED:client']);

    // A started booking is marked DONE / NO_SHOW by hand: no message about it.
    const past = await prisma.appointment.create({
      data: {
        businessId: t.businessId,
        staffId: t.staffId,
        clientId: (await prisma.client.create({ data: { businessId: t.businessId, name: 'P', phone: phone() } })).id,
        startsAt: new Date(Date.now() - 2 * 3_600_000),
        endsAt: new Date(Date.now() - 3_600_000),
        clientName: 'P',
        clientPhone: '+79990000000',
      },
    });
    await t.as(http().patch(`${t.url}/${past.id}/status`).send({ status: 'DONE' })).expect(200);
    expect(await t.events()).toHaveLength(4);
  });

  it('writes nothing for a cancel that is refused', async () => {
    const t = await setUp();
    const id = (await t.book(0).expect(201)).body.id as string;
    await t.as(http().patch(`${t.url}/${id}/status`).send({ status: 'CANCELLED' })).expect(200);

    await t.as(http().patch(`${t.url}/${id}/status`).send({ status: 'CANCELLED' })).expect(409);

    expect(await t.events()).toHaveLength(2);
  });

  it('writes nothing for someone who came without a booking', async () => {
    const owner = await signUpOwner(app);
    const businessId = owner.business.id;
    const as = (req: request.Test) => req.set('Cookie', owner.cookie);
    const staffId = (await as(http().post(`/businesses/${businessId}/staff`).send({ name: 'Coach' })).expect(201)).body
      .id as string;
    const base = `/businesses/${businessId}/staff/${staffId}`;
    await as(http().put(`${base}/schedule-mode`).send({ mode: 'GROUPS' })).expect(200);
    // Meets on today's weekday 00:00–01:00 Moscow, so it has started whenever the test runs.
    const today = todayIn('Europe/Moscow', new Date());
    const group = (
      await as(
        http()
          .post(`${base}/groups`)
          .send({
            title: 'Football',
            description: null,
            weekdays: [isoWeekday(today)],
            startMinute: 0,
            durationMinutes: 60,
            capacity: 3,
          }),
      ).expect(201)
    ).body.id as string;
    const startsAt = new Date(startOfDay('Europe/Moscow', today));

    await as(
      http()
        .post(`/businesses/${businessId}/appointments/walk-ins`)
        .send({
          staffId,
          groupId: group,
          startsAt: startsAt.toISOString(),
          endsAt: new Date(startsAt.getTime() + 3_600_000).toISOString(),
          newClient: { name: 'Olga', phone: phone() },
        }),
    ).expect(201);

    const rows = await prisma.$queryRaw<unknown[]>`
      SELECT 1 FROM notification_events WHERE business_id = ${businessId}::uuid`;
    expect(rows).toEqual([]);
  });
});
