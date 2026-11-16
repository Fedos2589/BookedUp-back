import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import type { MemberRole } from '../src/generated/prisma/enums.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { memberOf as memberOfBusiness, signUpOwner } from './helpers.js';
import { createTestApp } from './test-app.js';

let app: INestApplication<App>;

const http = () => request(app.getHttpServer());

const appointmentsUrl = (businessId: string) => `/businesses/${businessId}/appointments`;
const slotsUrl = (businessId: string) => `/businesses/${businessId}/slots`;

// A Monday far enough ahead that its slots are never in the past. The business is in Moscow (UTC+3):
// the window is 10:00–13:00, three slots of an hour, the first one 07:00Z.
const monday = '2030-01-07';
const slot = (index: number) => ({
  startsAt: `${monday}T${String(7 + index).padStart(2, '0')}:00:00.000Z`,
  endsAt: `${monday}T${String(8 + index).padStart(2, '0')}:00:00.000Z`,
});

const booking = (staffId: string, startsAt: string, endsAt: string) => ({
  staffId,
  startsAt,
  endsAt,
  clientName: 'Olga',
  clientPhone: '+79991234567',
});

// An owner whose master Anna works on Mondays, 10:00–13:00 in hourly slots.
const setUp = async () => {
  const owner = await signUpOwner(app);
  const businessId = owner.business.id;
  const staffId = (
    await http().post(`/businesses/${businessId}/staff`).set('Cookie', owner.cookie).send({ name: 'Anna' }).expect(201)
  ).body.id as string;
  await http()
    .put(`/businesses/${businessId}/staff/${staffId}/weekly-windows`)
    .set('Cookie', owner.cookie)
    .send({ windows: [{ weekday: 1, startMinute: 600, durationMinutes: 180, slotMinutes: 60, title: null }] })
    .expect(200);
  return { owner, businessId, staffId };
};

const memberWithSchedule = async (businessId: string, role: MemberRole) => {
  const member = await memberOfBusiness(app, businessId, role);
  const staff = await app
    .get(PrismaService)
    .staff.create({ data: { businessId, name: role, userId: member.userId }, select: { id: true } });
  return { ...member, staffId: staff.id };
};

const freeStarts = async (owner: { cookie: string }, businessId: string) =>
  (
    (await http().get(slotsUrl(businessId)).query({ from: monday, to: monday }).set('Cookie', owner.cookie).expect(200))
      .body as { startsAt: string }[]
  ).map((each) => each.startsAt);

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

describe('booking an hours slot', () => {
  it('books a free slot, and the slot is gone from the free ones', async () => {
    const { owner, businessId, staffId } = await setUp();
    const { startsAt, endsAt } = slot(0);

    const res = await http()
      .post(appointmentsUrl(businessId))
      .set('Cookie', owner.cookie)
      .send({ ...booking(staffId, startsAt, endsAt), note: '  first visit ' })
      .expect(201);

    expect(res.body).toMatchObject({
      staffId,
      startsAt,
      endsAt,
      status: 'BOOKED',
      clientName: 'Olga',
      clientPhone: '+79991234567',
      note: 'first visit',
      groupId: null,
      oneOffSessionId: null,
    });
    expect(await freeStarts(owner, businessId)).toEqual([slot(1).startsAt, slot(2).startsAt]);
  });

  it('answers 409 notFree for a time that is not a slot', async () => {
    const { owner, businessId, staffId } = await setUp();

    const res = await http()
      .post(appointmentsUrl(businessId))
      .set('Cookie', owner.cookie)
      .send(booking(staffId, `${monday}T07:30:00.000Z`, `${monday}T08:30:00.000Z`))
      .expect(409);

    expect(res.body).toMatchObject({ statusCode: 409, code: 'notFree' });
    expect(await freeStarts(owner, businessId)).toHaveLength(3);
  });

  it('answers 409 notFree for a taken slot', async () => {
    const { owner, businessId, staffId } = await setUp();
    const { startsAt, endsAt } = slot(1);
    await http()
      .post(appointmentsUrl(businessId))
      .set('Cookie', owner.cookie)
      .send(booking(staffId, startsAt, endsAt))
      .expect(201);

    const res = await http()
      .post(appointmentsUrl(businessId))
      .set('Cookie', owner.cookie)
      .send(booking(staffId, startsAt, endsAt))
      .expect(409);

    expect(res.body).toMatchObject({ statusCode: 409, code: 'notFree' });
  });

  it('gives one booking and one 409 to two requests for one slot at once', async () => {
    const { owner, businessId, staffId } = await setUp();
    const { startsAt, endsAt } = slot(2);
    const send = () =>
      http()
        .post(appointmentsUrl(businessId))
        .set('Cookie', owner.cookie)
        .send(booking(staffId, startsAt, endsAt));

    const statuses = (await Promise.all([send(), send()])).map((res) => res.status).sort((a, b) => a - b);

    expect(statuses).toEqual([201, 409]);
    expect(await app.get(PrismaService).appointment.count({ where: { businessId, staffId } })).toBe(1);
  });

  it("answers 404 for another business's master and books nothing", async () => {
    const { owner, businessId } = await setUp();
    const elsewhere = await setUp();
    const { startsAt, endsAt } = slot(0);

    await http()
      .post(appointmentsUrl(businessId))
      .set('Cookie', owner.cookie)
      .send(booking(elsewhere.staffId, startsAt, endsAt))
      .expect(404);

    expect(await app.get(PrismaService).appointment.count({ where: { staffId: elsewhere.staffId } })).toBe(0);
  });

  it('lets a master book themselves but not another master', async () => {
    const { businessId, staffId: anna } = await setUp();
    const boris = await memberWithSchedule(businessId, 'MASTER');
    await http()
      .put(`/businesses/${businessId}/staff/${boris.staffId}/weekly-windows`)
      .set('Cookie', boris.cookie)
      .send({ windows: [{ weekday: 1, startMinute: 600, durationMinutes: 60, slotMinutes: 60, title: null }] })
      .expect(200);
    const { startsAt, endsAt } = slot(0);

    await http()
      .post(appointmentsUrl(businessId))
      .set('Cookie', boris.cookie)
      .send(booking(anna, startsAt, endsAt))
      .expect(403);
    await http()
      .post(appointmentsUrl(businessId))
      .set('Cookie', boris.cookie)
      .send(booking(boris.staffId, startsAt, endsAt))
      .expect(201);
  });

  it('refuses a body that is not valid, with a 400 from the schema', async () => {
    const { owner, businessId, staffId } = await setUp();
    const { startsAt, endsAt } = slot(0);

    const fields = await http()
      .post(appointmentsUrl(businessId))
      .set('Cookie', owner.cookie)
      .send({ ...booking(staffId, startsAt, endsAt), clientName: ' ', clientPhone: '89991234567' })
      .expect(400);
    const order = await http()
      .post(appointmentsUrl(businessId))
      .set('Cookie', owner.cookie)
      .send(booking(staffId, endsAt, startsAt))
      .expect(400);

    const shortPhone = await http()
      .post(appointmentsUrl(businessId))
      .set('Cookie', owner.cookie)
      .send({ ...booking(staffId, startsAt, endsAt), clientPhone: '+12' })
      .expect(400);

    expect(shortPhone.body.message).toEqual([expect.stringMatching(/^clientPhone:/)]);
    expect(fields.body.message).toEqual([
      expect.stringMatching(/^clientName:/),
      expect.stringMatching(/^clientPhone:/),
    ]);
    expect(order.body.message).toEqual(['endsAt: Not after startsAt']);
    expect(await app.get(PrismaService).appointment.count({ where: { staffId } })).toBe(0);
  });
});

describe('booking a seat', () => {
  // Tuesday 2030-01-08: the group meets 15:00–16:00 Moscow (12:00–13:00Z), a one-off session 17:00–18:00.
  const tuesday = '2030-01-08';
  const meeting = { startsAt: `${tuesday}T12:00:00.000Z`, endsAt: `${tuesday}T13:00:00.000Z` };
  const sessionTime = { startsAt: `${tuesday}T14:00:00.000Z`, endsAt: `${tuesday}T15:00:00.000Z` };

  const coach = async (capacity: number) => {
    const owner = await signUpOwner(app);
    const businessId = owner.business.id;
    const as = (req: request.Test) => req.set('Cookie', owner.cookie);
    const staffId = (await as(http().post(`/businesses/${businessId}/staff`).send({ name: 'Anna' })).expect(201)).body
      .id as string;
    const base = `/businesses/${businessId}/staff/${staffId}`;
    await as(http().put(`${base}/schedule-mode`).send({ mode: 'GROUPS' })).expect(200);
    const group = (
      await as(
        http()
          .post(`${base}/groups`)
          .send({
            title: 'Football',
            description: null,
            weekdays: [2],
            startMinute: 900,
            durationMinutes: 60,
            capacity,
          }),
      ).expect(201)
    ).body.id as string;
    const seat = (extra: object, time = meeting) =>
      as(
        http()
          .post(appointmentsUrl(businessId))
          .send({ ...booking(staffId, time.startsAt, time.endsAt), ...extra }),
      );
    const booked = async () =>
      (
        (await as(http().get(slotsUrl(businessId)).query({ from: tuesday, to: tuesday })).expect(200)).body as {
          groupId: string | null;
          booked: number;
          full: boolean;
        }[]
      ).find((each) => each.groupId === group);
    return { as, base, businessId, staffId, group, seat, booked };
  };

  it('books a seat, and the places taken grow', async () => {
    const { group, seat, booked } = await coach(3);

    const res = await seat({ groupId: group }).expect(201);
    await seat({ groupId: group }).expect(201);

    expect(res.body).toMatchObject({ groupId: group, oneOffSessionId: null, ...meeting });
    expect(await booked()).toMatchObject({ booked: 2, full: false });
  });

  it('books a seat in a one-off session', async () => {
    const { as, base, seat } = await coach(3);
    const session = (
      await as(
        http()
          .post(`${base}/one-off-sessions`)
          .send({ title: 'Masterclass', ...sessionTime, capacity: 1 }),
      ).expect(201)
    ).body.id as string;

    const res = await seat({ oneOffSessionId: session }, sessionTime).expect(201);
    const full = await seat({ oneOffSessionId: session }, sessionTime).expect(409);

    expect(res.body).toMatchObject({ oneOffSessionId: session, groupId: null });
    expect(full.body).toMatchObject({ statusCode: 409, code: 'full' });
  });

  it('gives one 201 and one 409 full to two requests for the last place', async () => {
    const { businessId, staffId, group, seat } = await coach(1);

    const results = await Promise.all([seat({ groupId: group }), seat({ groupId: group })]);

    expect(results.map((res) => res.status).sort((a, b) => a - b)).toEqual([201, 409]);
    expect(results.find((res) => res.status === 409)?.body).toMatchObject({ code: 'full' });
    expect(await app.get(PrismaService).appointment.count({ where: { businessId, staffId } })).toBe(1);
  });

  it('answers 409 notFree for a cancelled date, another time or an unknown group', async () => {
    const { as, base, group, seat } = await coach(3);
    await as(http().put(`${base}/groups/${group}/cancellations/${tuesday}`)).expect(200);

    const cancelled = await seat({ groupId: group }).expect(409);
    const unknown = await seat({ groupId: '00000000-0000-4000-8000-000000000000' }).expect(409);

    expect(cancelled.body).toMatchObject({ code: 'notFree' });
    expect(unknown.body).toMatchObject({ code: 'notFree' });
  });

  it('answers 409 notFree for a time that is not the meeting', async () => {
    const { group, seat } = await coach(3);

    const res = await seat({ groupId: group }, sessionTime).expect(409);

    expect(res.body).toMatchObject({ code: 'notFree' });
  });

  it('refuses both a group and a session in one body', async () => {
    const { group, seat } = await coach(3);

    await seat({ groupId: group, oneOffSessionId: group }).expect(400);
  });

  it('keeps counting a seat whose client did not come', async () => {
    const { group, seat, booked } = await coach(1);
    const id = (await seat({ groupId: group }).expect(201)).body.id as string;
    await app.get(PrismaService).appointment.update({ where: { id }, data: { status: 'NO_SHOW' } });

    const res = await seat({ groupId: group }).expect(409);

    expect(res.body).toMatchObject({ code: 'full' });
    expect(await booked()).toMatchObject({ booked: 1, full: true });
  });
});

describe('adding someone who came without a booking', () => {
  // The group meets on Tuesdays 15:00–16:00 Moscow (12:00–13:00Z). 2020-01-07 has passed, 2030-01-08 hasn't.
  const pastTuesday = '2020-01-07';
  const meetingOn = (date: string) => ({ startsAt: `${date}T12:00:00.000Z`, endsAt: `${date}T13:00:00.000Z` });

  const coach = async (capacity: number) => {
    const owner = await signUpOwner(app);
    const businessId = owner.business.id;
    const as = (req: request.Test) => req.set('Cookie', owner.cookie);
    const staffId = (await as(http().post(`/businesses/${businessId}/staff`).send({ name: 'Anna' })).expect(201)).body
      .id as string;
    const base = `/businesses/${businessId}/staff/${staffId}`;
    await as(http().put(`${base}/schedule-mode`).send({ mode: 'GROUPS' })).expect(200);
    const group = (
      await as(
        http()
          .post(`${base}/groups`)
          .send({
            title: 'Football',
            description: null,
            weekdays: [2],
            startMinute: 900,
            durationMinutes: 60,
            capacity,
          }),
      ).expect(201)
    ).body.id as string;
    const walkIn = (date: string, extra: object = { groupId: group }, cookie = owner.cookie) => {
      const { startsAt, endsAt } = meetingOn(date);
      return http()
        .post(`${appointmentsUrl(businessId)}/walk-ins`)
        .set('Cookie', cookie)
        .send({ ...booking(staffId, startsAt, endsAt), ...extra });
    };
    const booked = async (date: string) =>
      (
        (await as(http().get(slotsUrl(businessId)).query({ from: date, to: date })).expect(200)).body as {
          groupId: string | null;
          booked: number;
        }[]
      ).find((each) => each.groupId === group)?.booked;
    return { as, base, businessId, staffId, group, walkIn, booked };
  };

  it('adds them to a meeting that has passed, as done', async () => {
    const { group, walkIn } = await coach(3);

    const res = await walkIn(pastTuesday).expect(201);

    expect(res.body).toMatchObject({ groupId: group, status: 'DONE', ...meetingOn(pastTuesday) });
  });

  it('adds them over the places of a full meeting', async () => {
    const { businessId, staffId, walkIn } = await coach(1);

    await walkIn(pastTuesday).expect(201);
    await walkIn(pastTuesday).expect(201);

    expect(await app.get(PrismaService).appointment.count({ where: { businessId, staffId, status: 'DONE' } })).toBe(2);
  });

  it('refuses a meeting that has not started with 409 notStarted, and adds nothing', async () => {
    const { walkIn, booked } = await coach(3);

    const res = await walkIn('2030-01-08').expect(409);

    expect(res.body).toMatchObject({ statusCode: 409, code: 'notStarted' });
    expect(await booked('2030-01-08')).toBe(0);
  });

  it('answers 409 notFree for a cancelled date, a day without the meeting or an unknown group', async () => {
    const { businessId, group, walkIn } = await coach(3);
    // The API refuses to cancel a date that has passed; this one was cancelled back then.
    await app
      .get(PrismaService)
      .groupCancellation.create({ data: { businessId, groupId: group, date: new Date('2020-01-14T00:00:00Z') } });

    const cancelled = await walkIn('2020-01-14').expect(409);
    const wrongDay = await walkIn('2020-01-08').expect(409);
    const unknown = await walkIn(pastTuesday, { groupId: '00000000-0000-4000-8000-000000000000' }).expect(409);

    for (const res of [cancelled, wrongDay, unknown]) expect(res.body).toMatchObject({ code: 'notFree' });
  });

  it('needs a group or a one-off session', async () => {
    const { walkIn } = await coach(3);

    await walkIn(pastTuesday, {}).expect(400);
  });

  it("refuses a master adding to someone else's meeting with 403", async () => {
    const { businessId, walkIn } = await coach(3);
    const master = await memberWithSchedule(businessId, 'MASTER');

    await walkIn(pastTuesday, undefined, master.cookie).expect(403);
  });
});

describe("the master's time after a visit", () => {
  // The status is seeded straight into the database: through the API a no-show can only come after
  // the start, and a slot that has started is no longer offered.
  const seed = (businessId: string, staffId: string, status: 'DONE' | 'NO_SHOW') =>
    app.get(PrismaService).appointment.create({
      data: { businessId, ...booking(staffId, slot(0).startsAt, slot(0).endsAt), status },
    });
  const book = (owner: { cookie: string }, staffId: string, businessId: string) =>
    http()
      .post(appointmentsUrl(businessId))
      .set('Cookie', owner.cookie)
      .send(booking(staffId, slot(0).startsAt, slot(0).endsAt));

  it('is free again after a no-show of an hours booking', async () => {
    const { owner, businessId, staffId } = await setUp();
    await seed(businessId, staffId, 'NO_SHOW');

    expect(await freeStarts(owner, businessId)).toContain(slot(0).startsAt);
    await book(owner, staffId, businessId).expect(201);
  });

  it('stays taken after a visit that happened', async () => {
    const { owner, businessId, staffId } = await setUp();
    await seed(businessId, staffId, 'DONE');

    expect(await freeStarts(owner, businessId)).not.toContain(slot(0).startsAt);
    const res = await book(owner, staffId, businessId).expect(409);
    expect(res.body).toMatchObject({ code: 'notFree' });
  });

  it('lets the database itself take a booking over a no-show', async () => {
    const { businessId, staffId } = await setUp();
    await seed(businessId, staffId, 'NO_SHOW');

    await expect(
      app.get(PrismaService).appointment.create({
        data: { businessId, ...booking(staffId, slot(0).startsAt, slot(0).endsAt) },
      }),
    ).resolves.toMatchObject({ status: 'BOOKED' });
  });
});

describe('listing bookings for a range', () => {
  const seed = (businessId: string, staffId: string, startsAt: string, extra: { status?: 'CANCELLED' } = {}) => {
    const start = new Date(startsAt);
    return app.get(PrismaService).appointment.create({
      data: {
        businessId,
        staffId,
        startsAt: start,
        endsAt: new Date(start.getTime() + 3_600_000),
        clientName: 'Olga',
        clientPhone: '+79991234567',
        ...extra,
      },
      select: { id: true },
    });
  };
  const list = (cookie: string, businessId: string, query: Record<string, string>) =>
    http().get(appointmentsUrl(businessId)).query(query).set('Cookie', cookie);

  it('puts a booking on the day it starts by the business clock, in order', async () => {
    const { owner, businessId, staffId } = await setUp();
    await app.get(PrismaService).business.update({ where: { id: businessId }, data: { timeZone: 'Asia/Bangkok' } });
    // Bangkok is UTC+7: 06:30 and 23:30 on the 7th, 00:30 on the 8th.
    const late = await seed(businessId, staffId, '2030-01-07T16:30:00.000Z');
    const early = await seed(businessId, staffId, '2030-01-06T23:30:00.000Z');
    await seed(businessId, staffId, '2030-01-07T17:30:00.000Z');

    const res = await list(owner.cookie, businessId, { from: monday, to: monday }).expect(200);

    expect((res.body as { id: string }[]).map((each) => each.id)).toEqual([early.id, late.id]);
  });

  it('hides cancelled bookings unless asked', async () => {
    const { owner, businessId, staffId } = await setUp();
    const live = await seed(businessId, staffId, slot(0).startsAt);
    const cancelled = await seed(businessId, staffId, slot(1).startsAt, { status: 'CANCELLED' });

    const hidden = await list(owner.cookie, businessId, { from: monday, to: monday }).expect(200);
    const shown = await list(owner.cookie, businessId, { from: monday, to: monday, includeCancelled: 'true' }).expect(
      200,
    );

    expect((hidden.body as { id: string }[]).map((each) => each.id)).toEqual([live.id]);
    expect((shown.body as { id: string }[]).map((each) => each.id)).toEqual([live.id, cancelled.id]);
  });

  it('gives a master only their own bookings, whatever staffId says', async () => {
    const { owner, businessId, staffId } = await setUp();
    const master = await memberWithSchedule(businessId, 'MASTER');
    await seed(businessId, staffId, slot(0).startsAt);
    const own = await seed(businessId, master.staffId, slot(1).startsAt);

    const plain = await list(master.cookie, businessId, { from: monday, to: monday }).expect(200);
    const other = await list(master.cookie, businessId, { from: monday, to: monday, staffId }).expect(200);
    const ownById = await list(master.cookie, businessId, { from: monday, to: monday, staffId: master.staffId }).expect(
      200,
    );
    const filtered = await list(owner.cookie, businessId, { from: monday, to: monday, staffId }).expect(200);

    expect((plain.body as { id: string }[]).map((each) => each.id)).toEqual([own.id]);
    expect(other.body).toEqual([]);
    expect((ownById.body as { id: string }[]).map((each) => each.id)).toEqual([own.id]);
    expect(filtered.body).toHaveLength(1);
  });

  it('refuses a range of more than 31 days', async () => {
    const { owner, businessId } = await setUp();

    await list(owner.cookie, businessId, { from: '2030-01-01', to: '2030-02-01' }).expect(400);
    await list(owner.cookie, businessId, { from: '2030-01-01', to: '2030-01-31' }).expect(200);
  });

  it('answers a week of 10 masters with 40 bookings each in good time', async () => {
    const { owner, businessId } = await setUp();
    const prisma = app.get(PrismaService);
    const staff = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        prisma.staff.create({ data: { businessId, name: `Master ${index}` }, select: { id: true } }),
      ),
    );
    // 40 hour-long bookings each, from 00:00Z on, spread over the week.
    await prisma.appointment.createMany({
      data: staff.flatMap(({ id }) =>
        Array.from({ length: 40 }, (_, index) => {
          const startsAt = new Date(Date.parse('2030-01-07T00:00:00Z') + index * 4 * 3_600_000);
          return {
            businessId,
            staffId: id,
            startsAt,
            endsAt: new Date(startsAt.getTime() + 3_600_000),
            clientName: 'Olga',
            clientPhone: '+79991234567',
          };
        }),
      ),
    });

    const began = performance.now();
    const res = await list(owner.cookie, businessId, { from: monday, to: '2030-01-13' }).expect(200);
    const took = performance.now() - began;
    console.log(`list of ${(res.body as unknown[]).length} bookings took ${Math.round(took)} ms`);

    expect(res.body).toHaveLength(400);
    expect(took).toBeLessThan(1000);
  });
});

describe('changing the status of a booking', () => {
  type Status = 'BOOKED' | 'CONFIRMED' | 'DONE' | 'NO_SHOW' | 'CANCELLED';
  const statusUrl = (businessId: string, id: string) => `${appointmentsUrl(businessId)}/${id}/status`;
  const seed = async (businessId: string, staffId: string, status: Status, startsAt: string) => {
    const start = new Date(startsAt);
    return (
      await app.get(PrismaService).appointment.create({
        data: {
          businessId,
          staffId,
          startsAt: start,
          endsAt: new Date(start.getTime() + 3_600_000),
          status,
          clientName: 'Olga',
          clientPhone: '+79991234567',
        },
        select: { id: true },
      })
    ).id;
  };
  const change = (cookie: string, businessId: string, id: string, status: Status) =>
    http().patch(statusUrl(businessId, id)).set('Cookie', cookie).send({ status });
  const past = '2020-01-06T07:00:00.000Z';

  it.each<[Status, Status, string]>([
    ['BOOKED', 'CONFIRMED', slot(0).startsAt],
    ['BOOKED', 'CANCELLED', slot(0).startsAt],
    ['CONFIRMED', 'CANCELLED', slot(0).startsAt],
    ['CONFIRMED', 'DONE', past],
    ['CONFIRMED', 'NO_SHOW', past],
    ['BOOKED', 'DONE', past],
    ['BOOKED', 'NO_SHOW', past],
    ['BOOKED', 'CANCELLED', past],
  ])('moves %s to %s', async (from, to, startsAt) => {
    const { owner, businessId, staffId } = await setUp();
    const id = await seed(businessId, staffId, from, startsAt);

    const res = await change(owner.cookie, businessId, id, to).expect(200);

    expect(res.body).toMatchObject({ id, status: to });
  });

  it.each<[Status, Status]>([
    ['DONE', 'NO_SHOW'],
    ['BOOKED', 'CONFIRMED'],
    ['CONFIRMED', 'BOOKED'],
    ['DONE', 'CANCELLED'],
    ['CANCELLED', 'CONFIRMED'],
  ])('refuses %s to %s with 409 badTransition', async (from, to) => {
    const { owner, businessId, staffId } = await setUp();
    const id = await seed(businessId, staffId, from, past);
    if (from === 'BOOKED' && to === 'CONFIRMED') {
      // The one allowed pair above, here asked twice: the second time the booking is no longer BOOKED.
      await change(owner.cookie, businessId, id, to).expect(200);
    }

    const res = await change(owner.cookie, businessId, id, to).expect(409);

    expect(res.body).toMatchObject({ statusCode: 409, code: 'badTransition' });
  });

  it('refuses DONE and NO_SHOW before the booking starts with 409 notStarted', async () => {
    const { owner, businessId, staffId } = await setUp();
    for (const from of ['BOOKED', 'CONFIRMED'] as const) {
      const id = await seed(businessId, staffId, from, slot(from === 'BOOKED' ? 0 : 1).startsAt);
      for (const status of ['DONE', 'NO_SHOW'] as const) {
        const res = await change(owner.cookie, businessId, id, status).expect(409);
        expect(res.body).toMatchObject({ code: 'notStarted' });
      }
    }
  });

  it('gives one 200 and one 409 to two changes of one booking at once', async () => {
    const { owner, businessId, staffId } = await setUp();
    const id = await seed(businessId, staffId, 'CONFIRMED', past);

    const results = await Promise.all([
      change(owner.cookie, businessId, id, 'DONE'),
      change(owner.cookie, businessId, id, 'CANCELLED'),
    ]);

    expect(results.map((res) => res.status).sort((a, b) => a - b)).toEqual([200, 409]);
  });

  it('lets a master change the status of their own booking', async () => {
    const { businessId } = await setUp();
    const master = await memberWithSchedule(businessId, 'MASTER');
    const id = await seed(businessId, master.staffId, 'BOOKED', slot(0).startsAt);

    await change(master.cookie, businessId, id, 'CONFIRMED').expect(200);
  });

  it('frees the slot once the booking is cancelled', async () => {
    const { owner, businessId, staffId } = await setUp();
    const { startsAt, endsAt } = slot(1);
    const id = (
      await http()
        .post(appointmentsUrl(businessId))
        .set('Cookie', owner.cookie)
        .send(booking(staffId, startsAt, endsAt))
        .expect(201)
    ).body.id as string;
    expect(await freeStarts(owner, businessId)).not.toContain(startsAt);

    await change(owner.cookie, businessId, id, 'CANCELLED').expect(200);

    expect(await freeStarts(owner, businessId)).toContain(startsAt);
  });

  it('answers 404 for a booking of another business and 403 for a master of someone else', async () => {
    const { owner, businessId, staffId } = await setUp();
    const stranger = await setUp();
    const id = await seed(businessId, staffId, 'BOOKED', slot(0).startsAt);
    const master = await memberWithSchedule(businessId, 'MASTER');

    await change(stranger.owner.cookie, stranger.businessId, id, 'CONFIRMED').expect(404);
    await change(master.cookie, businessId, id, 'CONFIRMED').expect(403);
    await change(owner.cookie, businessId, id, 'CONFIRMED').expect(200);
  });
});
