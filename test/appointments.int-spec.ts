import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import type { MemberRole } from '../src/generated/prisma/enums.js';
import { addDays, isoWeekday, startOfDay, todayIn } from '../src/schedule/local-time.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createClient, memberOf as memberOfBusiness, signUpOwner } from './helpers.js';
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

const slotOf = (staffId: string, startsAt: string, endsAt: string) => ({ staffId, startsAt, endsAt });

// Random, not a clock: test files run in parallel against one database.
const phone = () => `+7${randomUUID().replace(/\D/g, '').padEnd(10, '0').slice(0, 10)}`;

// A booking body for a new person with a phone of their own: each call is someone else, so a test
// that books twice doesn't meet «phone taken».
const booking = (staffId: string, startsAt: string, endsAt: string) => ({
  ...slotOf(staffId, startsAt, endsAt),
  newClient: { name: 'Olga', phone: phone() },
});

// What a booking written straight to the database says about who booked.
const snapshot = { clientName: 'Olga', clientPhone: '+79991234567' };

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
      .send({
        ...slotOf(staffId, startsAt, endsAt),
        newClient: { name: 'Olga', phone: '+79991234567' },
        note: '  first visit ',
      })
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

  describe('for a client', () => {
    const makeClient = async (owner: { cookie: string }, businessId: string, body: object) =>
      (await http().post(`/businesses/${businessId}/clients`).set('Cookie', owner.cookie).send(body).expect(201))
        .body as { id: string; phone: string | null };
    const post = (owner: { cookie: string }, businessId: string, body: object) =>
      http().post(appointmentsUrl(businessId)).set('Cookie', owner.cookie).send(body);

    it("writes who booked from the client's card, and the phone of the guardian for a dependent", async () => {
      const { owner, businessId, staffId } = await setUp();
      const mother = await makeClient(owner, businessId, { name: 'Olga', phone: '+79991234567' });
      const kid = await makeClient(owner, businessId, { name: 'Masha', guardianId: mother.id });

      const res = await post(owner, businessId, {
        ...slotOf(staffId, slot(0).startsAt, slot(0).endsAt),
        clientId: kid.id,
      }).expect(201);

      expect(res.body).toMatchObject({ clientId: kid.id, clientName: 'Masha', clientPhone: '+79991234567' });
    });

    it('keeps what was written when the client is renamed later', async () => {
      const { owner, businessId, staffId } = await setUp();
      const olga = await makeClient(owner, businessId, { name: 'Olga', phone: phone() });
      const id = (
        await post(owner, businessId, {
          ...slotOf(staffId, slot(0).startsAt, slot(0).endsAt),
          clientId: olga.id,
        }).expect(201)
      ).body.id as string;

      await http()
        .patch(`/businesses/${businessId}/clients/${olga.id}`)
        .set('Cookie', owner.cookie)
        .send({ name: 'Olga P.', phone: phone() })
        .expect(200);

      const booked = (
        await http()
          .get(appointmentsUrl(businessId))
          .query({ from: monday, to: monday })
          .set('Cookie', owner.cookie)
          .expect(200)
      ).body as { id: string; clientName: string }[];
      expect(booked.find((each) => each.id === id)).toMatchObject({ clientName: 'Olga' });
    });

    it('makes the new client together with the booking', async () => {
      const { owner, businessId, staffId } = await setUp();
      const number = phone();

      const res = await post(owner, businessId, {
        ...slotOf(staffId, slot(0).startsAt, slot(0).endsAt),
        newClient: { name: 'Olga', phone: number },
      }).expect(201);

      const clients = await app.get(PrismaService).client.findMany({ where: { businessId } });
      expect(clients).toMatchObject([{ id: res.body.clientId, name: 'Olga', phone: number }]);
      expect(res.body).toMatchObject({ clientName: 'Olga', clientPhone: number });
    });

    it('leaves no client behind when the slot is not free', async () => {
      const { owner, businessId, staffId } = await setUp();

      const res = await post(owner, businessId, booking(staffId, `${monday}T07:30:00.000Z`, `${monday}T08:30:00.000Z`));

      expect(res.status).toBe(409);
      expect(await app.get(PrismaService).client.count({ where: { businessId } })).toBe(0);
    });

    it('answers 409 phoneTaken with the holder of a taken phone, and books nothing', async () => {
      const { owner, businessId, staffId } = await setUp();
      const olga = await makeClient(owner, businessId, { name: 'Olga', phone: '+79991234567' });

      const res = await post(owner, businessId, {
        ...slotOf(staffId, slot(0).startsAt, slot(0).endsAt),
        newClient: { name: 'Another Olga', phone: '+79991234567' },
      }).expect(409);

      expect(res.body).toMatchObject({ code: 'phoneTaken', clientId: olga.id });
      expect(await app.get(PrismaService).appointment.count({ where: { businessId } })).toBe(0);
    });

    it('answers 409 notHolder for a new dependent of a dependent', async () => {
      const { owner, businessId, staffId } = await setUp();
      const mother = await makeClient(owner, businessId, { name: 'Olga', phone: phone() });
      const kid = await makeClient(owner, businessId, { name: 'Masha', guardianId: mother.id });

      const res = await post(owner, businessId, {
        ...slotOf(staffId, slot(0).startsAt, slot(0).endsAt),
        newClient: { name: 'Baby', guardianId: kid.id },
      }).expect(409);

      expect(res.body).toMatchObject({ code: 'notHolder' });
    });

    it('answers 404 for a client of another business and 400 for both or neither of clientId and newClient', async () => {
      const { owner, businessId, staffId } = await setUp();
      const stranger = await signUpOwner(app);
      const theirs = await makeClient(stranger, stranger.business.id, { name: 'Their client', phone: phone() });
      const when = slotOf(staffId, slot(0).startsAt, slot(0).endsAt);

      await post(owner, businessId, { ...when, clientId: theirs.id }).expect(404);
      await post(owner, businessId, { ...when, clientId: theirs.id, newClient: { name: 'X', phone: phone() } }).expect(
        400,
      );
      await post(owner, businessId, when).expect(400);
      expect(await app.get(PrismaService).appointment.count({ where: { businessId } })).toBe(0);
    });
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
      .send({ ...slotOf(staffId, startsAt, endsAt), newClient: { name: ' ', phone: '89991234567' } })
      .expect(400);
    const order = await http()
      .post(appointmentsUrl(businessId))
      .set('Cookie', owner.cookie)
      .send(booking(staffId, endsAt, startsAt))
      .expect(400);

    const shortPhone = await http()
      .post(appointmentsUrl(businessId))
      .set('Cookie', owner.cookie)
      .send({ ...slotOf(staffId, startsAt, endsAt), newClient: { name: 'Olga', phone: '+12' } })
      .expect(400);

    expect(shortPhone.body.message).toEqual([expect.stringMatching(/^newClient\.phone:/)]);
    expect(fields.body.message).toEqual([
      expect.stringMatching(/^newClient\.name:/),
      expect.stringMatching(/^newClient\.phone:/),
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

  it('refuses a move into a meeting with every seat taken with 409 full, and the seat stays', async () => {
    const { as, base, businessId, group, seat } = await coach(1);
    const session = (
      await as(
        http()
          .post(`${base}/one-off-sessions`)
          .send({ title: 'Masterclass', ...sessionTime, capacity: 2 }),
      ).expect(201)
    ).body.id as string;
    await seat({ groupId: group }).expect(201);
    const mine = (await seat({ oneOffSessionId: session }, sessionTime).expect(201)).body as { id: string };

    const res = await as(
      http()
        .patch(`${appointmentsUrl(businessId)}/${mine.id}`)
        .send({ staffId: undefined, ...meeting, groupId: group }),
    ).expect(409);

    expect(res.body).toMatchObject({ statusCode: 409, code: 'full' });
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

const HOUR_MS = 3_600_000;

describe('adding someone who came without a booking', () => {
  // The group meets on today's weekday 00:00–01:00 Moscow, so it has started whenever the test runs.
  // 2030-01-08 (a Tuesday) hasn't come yet.
  const today = todayIn('Europe/Moscow', new Date());
  const weekday = isoWeekday(today);
  const meetingOn = (date: string, startMinute = 0) => {
    const startsAt = new Date(startOfDay('Europe/Moscow', date) + startMinute * 60_000);
    return {
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + HOUR_MS).toISOString(),
    };
  };

  const coach = async (capacity: number, startMinute = 0) => {
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
            weekdays: [weekday, 2],
            startMinute,
            durationMinutes: 60,
            capacity,
          }),
      ).expect(201)
    ).body.id as string;
    const walkIn = (date: string, extra: object = { groupId: group }, cookie = owner.cookie) => {
      const { startsAt, endsAt } = meetingOn(date, startMinute);
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
    return { as, base, businessId, staffId, group, walkIn, booked, owner };
  };

  it('adds them to a meeting that has started today, as done', async () => {
    const { group, walkIn } = await coach(3);

    const res = await walkIn(today).expect(201);

    expect(res.body).toMatchObject({ groupId: group, status: 'DONE', ...meetingOn(today) });
  });

  it('adds an existing client of the business by clientId', async () => {
    const { group, walkIn, owner, businessId } = await coach(3);
    const olga = (
      await http()
        .post(`/businesses/${businessId}/clients`)
        .set('Cookie', owner.cookie)
        .send({ name: 'Olga', phone: phone() })
        .expect(201)
    ).body as { id: string };

    const res = await walkIn(today, { groupId: group, clientId: olga.id, newClient: undefined }).expect(201);

    expect(res.body).toMatchObject({ clientId: olga.id, clientName: 'Olga', status: 'DONE' });
  });

  it('adds them over the places of a full meeting', async () => {
    const { businessId, staffId, walkIn } = await coach(1);

    await walkIn(today).expect(201);
    await walkIn(today).expect(201);

    expect(await app.get(PrismaService).appointment.count({ where: { businessId, staffId, status: 'DONE' } })).toBe(2);
  });

  it('refuses a meeting that starts later today with 409 notStarted, and adds nothing', async () => {
    // 23:00 Moscow: it has not started unless the test runs in the last hour of the day.
    const { walkIn, booked } = await coach(3, 23 * 60);

    const res = await walkIn(today).expect(409);

    expect(res.body).toMatchObject({ statusCode: 409, code: 'notStarted' });
    expect(await booked(today)).toBe(0);
  });

  it('answers 409 notFree for a meeting of a day gone by, and adds nothing', async () => {
    const { walkIn } = await coach(3);
    // A week ago was the same weekday, so the group did meet: only the day is wrong.
    const res = await walkIn(addDays(today, -7)).expect(409);

    expect(res.body).toMatchObject({ code: 'notFree' });
  });

  it('answers 409 notFree for a day to come: only today takes walk-ins', async () => {
    const { walkIn } = await coach(3);

    const res = await walkIn('2030-01-08').expect(409);

    expect(res.body).toMatchObject({ code: 'notFree' });
  });

  it('answers 409 notFree for a cancelled date or an unknown group', async () => {
    const { businessId, group, walkIn } = await coach(3);
    // The API refuses to cancel a date that has started; this one was cancelled in the database.
    await app
      .get(PrismaService)
      .groupCancellation.create({ data: { businessId, groupId: group, date: new Date(`${today}T00:00:00Z`) } });

    const cancelled = await walkIn(today).expect(409);
    const unknown = await walkIn(today, { groupId: '00000000-0000-4000-8000-000000000000' }).expect(409);

    for (const res of [cancelled, unknown]) expect(res.body).toMatchObject({ code: 'notFree' });
  });

  it('needs a group or a one-off session', async () => {
    const { walkIn } = await coach(3);

    await walkIn(today, {}).expect(400);
  });

  it("refuses a master adding to someone else's meeting with 403", async () => {
    const { businessId, walkIn } = await coach(3);
    const master = await memberWithSchedule(businessId, 'MASTER');

    await walkIn(today, undefined, master.cookie).expect(403);
  });
});

describe("the master's time after a visit", () => {
  // The status is seeded straight into the database: through the API a no-show can only come after
  // the start, and a slot that has started is no longer offered.
  const seed = async (businessId: string, staffId: string, status: 'DONE' | 'NO_SHOW') =>
    app.get(PrismaService).appointment.create({
      data: {
        businessId,
        clientId: await createClient(app.get(PrismaService), businessId),
        ...slotOf(staffId, slot(0).startsAt, slot(0).endsAt),
        ...snapshot,
        status,
      },
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
        data: {
          businessId,
          clientId: await createClient(app.get(PrismaService), businessId),
          ...slotOf(staffId, slot(0).startsAt, slot(0).endsAt),
          ...snapshot,
        },
      }),
    ).resolves.toMatchObject({ status: 'BOOKED' });
  });
});

describe('listing bookings for a range', () => {
  const seed = async (businessId: string, staffId: string, startsAt: string, extra: { status?: 'CANCELLED' } = {}) => {
    const start = new Date(startsAt);
    return app.get(PrismaService).appointment.create({
      data: {
        businessId,
        clientId: await createClient(app.get(PrismaService), businessId),
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
    const clientId = await createClient(prisma, businessId);
    // 40 hour-long bookings each, from 00:00Z on, spread over the week.
    await prisma.appointment.createMany({
      data: staff.flatMap(({ id }) =>
        Array.from({ length: 40 }, (_, index) => {
          const startsAt = new Date(Date.parse('2030-01-07T00:00:00Z') + index * 4 * 3_600_000);
          return {
            businessId,
            clientId,
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
          clientId: await createClient(app.get(PrismaService), businessId),
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

describe('moving a booking', () => {
  const move = (cookie: string, businessId: string, id: string, body: object) =>
    http()
      .patch(`${appointmentsUrl(businessId)}/${id}`)
      .set('Cookie', cookie)
      .send(body);
  const book = async (cookie: string, businessId: string, staffId: string, at: { startsAt: string; endsAt: string }) =>
    (
      await http()
        .post(appointmentsUrl(businessId))
        .set('Cookie', cookie)
        .send(booking(staffId, at.startsAt, at.endsAt))
        .expect(201)
    ).body.id as string;
  const listed = async (cookie: string, businessId: string) =>
    (
      await http()
        .get(appointmentsUrl(businessId))
        .query({ from: monday, to: monday })
        .set('Cookie', cookie)
        .expect(200)
    ).body as { id: string; startsAt: string; staffId: string }[];

  it('moves a booking to a free slot and frees the old one', async () => {
    const { owner, businessId, staffId } = await setUp();
    const id = await book(owner.cookie, businessId, staffId, slot(0));

    const res = await move(owner.cookie, businessId, id, { staffId, ...slot(2) }).expect(200);

    expect(res.body).toMatchObject({ id, staffId, ...slot(2), status: 'BOOKED', clientName: 'Olga' });
    expect(await freeStarts(owner, businessId)).toEqual([slot(0).startsAt, slot(1).startsAt]);
  });

  it('refuses a taken slot with 409 notFree and leaves the booking where it was', async () => {
    const { owner, businessId, staffId } = await setUp();
    const id = await book(owner.cookie, businessId, staffId, slot(0));
    await book(owner.cookie, businessId, staffId, slot(1));

    const res = await move(owner.cookie, businessId, id, { staffId, ...slot(1) }).expect(409);

    expect(res.body).toMatchObject({ statusCode: 409, code: 'notFree' });
    expect((await listed(owner.cookie, businessId)).find((each) => each.id === id)?.startsAt).toBe(slot(0).startsAt);
  });

  it('refuses a time that is not a slot with 409 notFree', async () => {
    const { owner, businessId, staffId } = await setUp();
    const id = await book(owner.cookie, businessId, staffId, slot(0));

    const res = await move(owner.cookie, businessId, id, {
      staffId,
      startsAt: `${monday}T07:30:00.000Z`,
      endsAt: `${monday}T08:30:00.000Z`,
    }).expect(409);

    expect(res.body).toMatchObject({ code: 'notFree' });
  });

  it("does not count the booking's own slot against it", async () => {
    const { owner, businessId, staffId } = await setUp();
    const id = await book(owner.cookie, businessId, staffId, slot(1));

    await move(owner.cookie, businessId, id, { staffId, ...slot(1) }).expect(200);
  });

  it('moves a booking to another master', async () => {
    const { owner, businessId, staffId } = await setUp();
    const other = (
      await http()
        .post(`/businesses/${businessId}/staff`)
        .set('Cookie', owner.cookie)
        .send({ name: 'Boris' })
        .expect(201)
    ).body.id as string;
    await http()
      .put(`/businesses/${businessId}/staff/${other}/weekly-windows`)
      .set('Cookie', owner.cookie)
      .send({ windows: [{ weekday: 1, startMinute: 600, durationMinutes: 180, slotMinutes: 60, title: null }] })
      .expect(200);
    const id = await book(owner.cookie, businessId, staffId, slot(0));

    const res = await move(owner.cookie, businessId, id, { staffId: other, ...slot(0) }).expect(200);

    expect(res.body).toMatchObject({ id, staffId: other });
    await book(owner.cookie, businessId, staffId, slot(0));
  });

  it.each(['DONE', 'NO_SHOW', 'CANCELLED'] as const)(
    'refuses to move a %s booking with 409 badTransition',
    async (status) => {
      const { owner, businessId, staffId } = await setUp();
      const id = await book(owner.cookie, businessId, staffId, slot(0));
      await app.get(PrismaService).appointment.update({ where: { id }, data: { status } });

      const res = await move(owner.cookie, businessId, id, { staffId, ...slot(1) }).expect(409);

      expect(res.body).toMatchObject({ code: 'badTransition' });
    },
  );

  it('gives one 200 and one 409 to two bookings moved into one slot at once', async () => {
    const { owner, businessId, staffId } = await setUp();
    const first = await book(owner.cookie, businessId, staffId, slot(0));
    const second = await book(owner.cookie, businessId, staffId, slot(1));

    const results = await Promise.all([
      move(owner.cookie, businessId, first, { staffId, ...slot(2) }),
      move(owner.cookie, businessId, second, { staffId, ...slot(2) }),
    ]);

    expect(results.map((res) => res.status).sort((a, b) => a - b)).toEqual([200, 409]);
  });

  it('answers 404 for a booking of another business, 403 for a master of someone else', async () => {
    const { owner, businessId, staffId } = await setUp();
    const stranger = await setUp();
    const master = await memberWithSchedule(businessId, 'MASTER');
    const id = await book(owner.cookie, businessId, staffId, slot(0));

    await move(stranger.owner.cookie, stranger.businessId, id, { staffId: stranger.staffId, ...slot(1) }).expect(404);
    await move(master.cookie, businessId, id, { staffId, ...slot(1) }).expect(403);
    await move(owner.cookie, businessId, id, { staffId: master.staffId, ...slot(1) }).expect(409);
  });
});
