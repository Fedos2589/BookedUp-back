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

    expect(fields.body.message).toEqual([
      expect.stringMatching(/^clientName:/),
      expect.stringMatching(/^clientPhone:/),
    ]);
    expect(order.body.message).toEqual(['endsAt: Not after startsAt']);
    expect(await app.get(PrismaService).appointment.count({ where: { staffId } })).toBe(0);
  });
});
