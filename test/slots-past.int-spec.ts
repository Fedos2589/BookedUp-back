import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { PrismaService } from '../src/prisma/prisma.service.js';
import { signUpOwner } from './helpers.js';
import { createTestApp } from './test-app.js';

let app: INestApplication<App>;

const http = () => request(app.getHttpServer());
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR);
// The business is in Moscow (UTC+3, no DST): its calendar date at an instant.
const moscowDate = (at: Date) => new Date(at.getTime() + 3 * HOUR).toISOString().slice(0, 10);

type Slot = { oneOffSessionId: string | null; groupId: string | null; booked: number; capacity: number; full: boolean };

const setUp = async () => {
  const owner = await signUpOwner(app);
  const businessId = owner.business.id;
  const as = (req: request.Test) => req.set('Cookie', owner.cookie);
  const staffId = (await as(http().post(`/businesses/${businessId}/staff`).send({ name: 'Anna' })).expect(201)).body
    .id as string;
  await as(http().put(`/businesses/${businessId}/staff/${staffId}/schedule-mode`).send({ mode: 'GROUPS' })).expect(200);
  const prisma = app.get(PrismaService);
  const session = async (startsAt: Date, capacity: number, seats: number) => {
    const { id } = await prisma.oneOffSession.create({
      data: {
        businessId,
        staffId,
        title: 'Masterclass',
        startsAt,
        endsAt: new Date(startsAt.getTime() + HOUR),
        capacity,
      },
      select: { id: true },
    });
    for (let i = 0; i < seats; i++) {
      await prisma.appointment.create({
        data: {
          businessId,
          staffId,
          startsAt,
          endsAt: new Date(startsAt.getTime() + HOUR),
          oneOffSessionId: id,
          clientName: `Client ${i}`,
          clientPhone: '+79991234567',
        },
      });
    }
    return id;
  };
  const slots = async (extra: Record<string, string> = {}) =>
    (
      await as(
        http()
          .get(`/businesses/${businessId}/slots`)
          .query({ from: moscowDate(ago(72)), to: moscowDate(new Date(Date.now() + 24 * HOUR)), ...extra }),
      ).expect(200)
    ).body as Slot[];
  return { as, businessId, staffId, prisma, session, slots };
};

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

describe('GET /slots with includePast', () => {
  it('keeps a meeting that has started off the answer by default and brings it, with its seats, on request', async () => {
    const t = await setUp();
    const started = await t.session(ago(1), 5, 2);

    expect((await t.slots()).some((s) => s.oneOffSessionId === started)).toBe(false);
    expect((await t.slots({ includePast: 'false' })).some((s) => s.oneOffSessionId === started)).toBe(false);
    const found = (await t.slots({ includePast: 'true' })).find((s) => s.oneOffSessionId === started);
    expect(found).toMatchObject({ booked: 2, capacity: 5, full: false });
  });

  it('marks a full meeting that is over as full, and brings yesterday’s meeting', async () => {
    const t = await setUp();
    const full = await t.session(ago(2), 2, 2);
    const yesterday = await t.session(ago(26), 4, 1);

    const answer = await t.slots({ includePast: 'true' });
    expect(answer.find((s) => s.oneOffSessionId === full)).toMatchObject({ booked: 2, capacity: 2, full: true });
    expect(answer.find((s) => s.oneOffSessionId === yesterday)).toMatchObject({ booked: 1, capacity: 4 });
  });

  it('leaves out a cancelled group date and a meeting that is archived', async () => {
    const t = await setUp();
    const start = ago(26);
    const date = moscowDate(start);
    const local = new Date(start.getTime() + 3 * HOUR);
    const group = await t.prisma.group.create({
      data: {
        businessId: t.businessId,
        staffId: t.staffId,
        title: 'Football',
        weekdays: [local.getUTCDay() || 7],
        startMinute: local.getUTCHours() * 60,
        durationMinutes: 60,
        capacity: 5,
      },
      select: { id: true },
    });
    const kept = (answer: Slot[]) => answer.some((s) => s.groupId === group.id);
    expect(kept(await t.slots({ includePast: 'true' }))).toBe(true);

    await t.prisma.groupCancellation.create({
      data: { businessId: t.businessId, groupId: group.id, date: new Date(`${date}T00:00:00.000Z`) },
    });
    expect(kept(await t.slots({ includePast: 'true' }))).toBe(false);
  });

  it('refuses a flag that is neither true nor false', async () => {
    const t = await setUp();
    await t
      .as(
        http()
          .get(`/businesses/${t.businessId}/slots`)
          .query({ from: '2030-01-08', to: '2030-01-08', includePast: 'maybe' }),
      )
      .expect(400);
  });
});
