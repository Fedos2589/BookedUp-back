import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { PrismaService } from '../src/prisma/prisma.service.js';
import { createClient, signUpOwner } from './helpers.js';
import { createTestApp } from './test-app.js';

let app: INestApplication<App>;

const http = () => request(app.getHttpServer());

// Tuesday 2030-01-08, Moscow (UTC+3): the group meets 15:00–16:00 (12:00–13:00Z), a one-off session
// takes 17:00–18:00 (14:00–15:00Z).
const tuesday = '2030-01-08';
const meeting = { startsAt: new Date(`${tuesday}T12:00:00.000Z`), endsAt: new Date(`${tuesday}T13:00:00.000Z`) };
const sessionTime = { startsAt: `${tuesday}T14:00:00.000Z`, endsAt: `${tuesday}T15:00:00.000Z` };
const football = {
  title: 'Football',
  description: null,
  weekdays: [2],
  startMinute: 900,
  durationMinutes: 60,
  capacity: 5,
};

const setUp = async () => {
  const owner = await signUpOwner(app);
  const businessId = owner.business.id;
  const as = (req: request.Test) => req.set('Cookie', owner.cookie);
  const staffId = (await as(http().post(`/businesses/${businessId}/staff`).send({ name: 'Anna' })).expect(201)).body
    .id as string;
  const base = `/businesses/${businessId}/staff/${staffId}`;
  await as(http().put(`${base}/schedule-mode`).send({ mode: 'GROUPS' })).expect(200);
  const prisma = app.get(PrismaService);
  const book = async (extra: { groupId?: string; oneOffSessionId?: string; startsAt?: Date; endsAt?: Date }) =>
    prisma.appointment.create({
      data: {
        businessId,
        clientId: await createClient(prisma, businessId),
        staffId,
        ...meeting,
        clientName: 'Olga',
        clientPhone: '+79991234567',
        ...extra,
      },
      select: { id: true },
    });
  const slots = async (query = { from: tuesday, to: tuesday }) =>
    (await as(http().get(`/businesses/${businessId}/slots`).query(query)).expect(200)).body as {
      groupId: string | null;
      oneOffSessionId: string | null;
    }[];
  return { as, base, businessId, staffId, prisma, book, slots };
};

const addGroup = async ({ as, base }: Awaited<ReturnType<typeof setUp>>) =>
  (await as(http().post(`${base}/groups`).send(football)).expect(201)).body.id as string;

const addSession = async ({ as, base }: Awaited<ReturnType<typeof setUp>>) =>
  (
    await as(
      http()
        .post(`${base}/one-off-sessions`)
        .send({ title: 'Masterclass', ...sessionTime, capacity: 3 }),
    ).expect(201)
  ).body.id as string;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

describe('a group', () => {
  it('keeps its meeting date while a live booking is on it, and cancels it once that is cancelled', async () => {
    const t = await setUp();
    const group = await addGroup(t);
    const { id } = await t.book({ groupId: group });
    const cancel = () => t.as(http().put(`${t.base}/groups/${group}/cancellations/${tuesday}`));

    const refused = await cancel().expect(409);
    expect(refused.body).toMatchObject({ statusCode: 409, code: 'hasBookings', appointmentIds: [id] });
    expect((await t.slots()).some((slot) => slot.groupId === group)).toBe(true);

    await t.prisma.appointment.update({ where: { id }, data: { status: 'CANCELLED' } });
    await cancel().expect(200);
    expect((await t.slots()).some((slot) => slot.groupId === group)).toBe(false);
  });

  it('is archived, not deleted: refused over a live booking, then gone from lists and slots with its history', async () => {
    const t = await setUp();
    const group = await addGroup(t);
    const { id } = await t.book({ groupId: group });
    const remove = () => t.as(http().delete(`${t.base}/groups/${group}`));

    const refused = await remove().expect(409);
    expect(refused.body).toMatchObject({ code: 'hasBookings', appointmentIds: [id] });
    await t
      .as(http().get(`${t.base}/groups`))
      .expect(200)
      .expect(({ body }) => expect(body).toHaveLength(1));

    await t.prisma.appointment.update({ where: { id }, data: { status: 'DONE' } });
    await remove().expect(204);
    await remove().expect(404);

    await t
      .as(http().get(`${t.base}/groups`))
      .expect(200)
      .expect([]);
    expect((await t.slots()).some((slot) => slot.groupId === group)).toBe(false);
    expect(await t.prisma.appointment.findUnique({ where: { id }, select: { groupId: true } })).toEqual({
      groupId: group,
    });
    await t.as(http().put(`${t.base}/groups/${group}`).send(football)).expect(404);
    await addGroup(t); // the same title and hours: the archived one gets in nobody's way
  });
});

describe('changing a group', () => {
  it('is refused when a live seat would be left without its meeting or place, and passes once cancelled', async () => {
    const t = await setUp();
    const group = await addGroup(t);
    const first = await t.book({ groupId: group });
    const second = await t.book({ groupId: group });
    const change = (extra: object) =>
      t.as(
        http()
          .put(`${t.base}/groups/${group}`)
          .send({ ...football, ...extra }),
      );

    const moved = await change({ startMinute: 1020 }).expect(409);
    const otherDay = await change({ weekdays: [4] }).expect(409);
    const smaller = await change({ capacity: 1 }).expect(409);

    for (const refused of [moved, otherDay, smaller])
      expect(refused.body).toMatchObject({ code: 'hasBookings', appointmentIds: expect.arrayContaining([first.id]) });
    expect(smaller.body.appointmentIds).toHaveLength(2);
    await t.as(http().get(`${t.base}/groups`)).expect(({ body }) => expect(body[0]).toMatchObject(football));

    await change({ title: 'Football for kids', capacity: 9 }).expect(200); // nothing a seat depends on
    await t.prisma.appointment.updateMany({
      where: { id: { in: [first.id, second.id] } },
      data: { status: 'CANCELLED' },
    });
    await change({ startMinute: 1020 }).expect(200);
  });
});

describe('a one-off session', () => {
  it('is refused over a live booking, then archived and its time is free again', async () => {
    const t = await setUp();
    const session = await addSession(t);
    const { id } = await t.book({
      oneOffSessionId: session,
      startsAt: new Date(sessionTime.startsAt),
      endsAt: new Date(sessionTime.endsAt),
    });
    const remove = () => t.as(http().delete(`${t.base}/one-off-sessions/${session}`));

    const refused = await remove().expect(409);
    expect(refused.body).toMatchObject({ code: 'hasBookings', appointmentIds: [id] });

    await t.prisma.appointment.update({ where: { id }, data: { status: 'CANCELLED' } });
    await remove().expect(204);

    await t
      .as(http().get(`${t.base}/one-off-sessions`))
      .expect(200)
      .expect([]);
    expect((await t.slots()).some((slot) => slot.oneOffSessionId === session)).toBe(false);
    await addSession(t); // the same time: the archived one doesn't hold it
  });
});

describe('time off', () => {
  it('is refused over a live booking and added once it is cancelled', async () => {
    const t = await setUp();
    const { id } = await t.book({});
    const leave = { startsAt: `${tuesday}T12:30:00.000Z`, endsAt: `${tuesday}T14:00:00.000Z` };
    const add = () => t.as(http().post(`${t.base}/time-off`).send(leave));

    const refused = await add().expect(409);
    expect(refused.body).toMatchObject({ code: 'hasBookings', appointmentIds: [id] });
    expect(await t.prisma.timeOff.count({ where: { staffId: t.staffId } })).toBe(0);

    await t.prisma.appointment.update({ where: { id }, data: { status: 'CANCELLED' } });
    await add().expect(201);
  });

  it('is added beside a booking it does not touch', async () => {
    const t = await setUp();
    await t.book({});

    await t
      .as(
        http()
          .post(`${t.base}/time-off`)
          .send({ startsAt: meeting.endsAt, endsAt: `${tuesday}T14:00:00.000Z` }),
      )
      .expect(201);
  });
});
