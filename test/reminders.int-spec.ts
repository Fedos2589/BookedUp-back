import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { App } from 'supertest/types.js';

import { RemindersService } from '../src/notifications/reminders.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createClient, signUpOwner } from './helpers.js';
import { createTestApp } from './test-app.js';

let app: INestApplication<App>;
let prisma: PrismaService;
let reminders: RemindersService;

beforeAll(async () => {
  app = await createTestApp();
  prisma = app.get(PrismaService);
  reminders = app.get(RemindersService);
});

afterAll(async () => {
  await app.close();
});

const MINUTE = 60_000;
const NOW = new Date('2030-01-06T12:00:00.000Z');
const after = (minutes: number, from = NOW) => new Date(from.getTime() + minutes * MINUTE);

const phone = () => `+7999${randomUUID().replace(/\D/g, '').padEnd(7, '1').slice(0, 7)}`;

const setUp = async (reminderOffsets?: number[]) => {
  const owner = await signUpOwner(app);
  const businessId = owner.business.id;
  if (reminderOffsets) await prisma.business.update({ where: { id: businessId }, data: { reminderOffsets } });
  const staff = await prisma.staff.create({ data: { businessId, name: 'Anna' }, select: { id: true } });
  const clientId = await createClient(prisma, businessId, phone());
  const book = (
    startsAt: Date,
    extra: { status?: 'CANCELLED' | 'CONFIRMED' | 'DONE' | 'NO_SHOW'; createdAt?: Date } = {},
  ) =>
    prisma.appointment.create({
      data: {
        businessId,
        staffId: staff.id,
        clientId,
        startsAt,
        endsAt: after(1, startsAt),
        clientName: 'Vera',
        clientPhone: phone(),
        ...extra,
      },
      select: { id: true },
    });
  const events = async () =>
    (await prisma.notificationEvent.findMany({ where: { businessId }, orderBy: { startsAt: 'asc' } })).map((e) => ({
      kind: e.kind,
      offsetMinutes: e.offsetMinutes,
      startsAt: e.startsAt.toISOString(),
      actorUserId: e.actorUserId,
    }));
  return { businessId, book, events };
};

const reminder = (offsetMinutes: number, startsAt: Date) => ({
  kind: 'REMINDER',
  offsetMinutes,
  startsAt: startsAt.toISOString(),
  actorUserId: null,
});

describe('scheduleReminders', () => {
  it('writes one event for a booking whose reminder is due', async () => {
    const t = await setUp();
    await t.book(after(1440));

    await reminders.scheduleReminders(NOW);

    expect(await t.events()).toEqual([reminder(1440, after(1440))]);
  });

  it('two runs write one event', async () => {
    const t = await setUp();
    await t.book(after(1440));

    await Promise.all([reminders.scheduleReminders(NOW), reminders.scheduleReminders(after(5))]);
    await reminders.scheduleReminders(after(10));

    expect(await t.events()).toHaveLength(1);
  });

  it('writes nothing outside the window of the last 15 minutes', async () => {
    const t = await setUp();
    await t.book(after(1440 + 1));
    await t.book(after(1440 - 15));
    await t.book(after(1440 - 16));

    await reminders.scheduleReminders(NOW);

    // The reminder time of the first is a minute ahead, of the last one 16 minutes behind; the middle one's is 15 behind.
    expect(await t.events()).toEqual([]);
  });

  it('writes one for a booking whose reminder time came a minute ago', async () => {
    const t = await setUp();
    await t.book(after(1440 - 14));

    await reminders.scheduleReminders(NOW);

    expect(await t.events()).toHaveLength(1);
  });

  it('writes one for a confirmed booking too, and none for one that is done or missed', async () => {
    const t = await setUp();
    await t.book(after(1440), { status: 'CONFIRMED' });
    await t.book(after(1440 + 5), { status: 'DONE' });
    await t.book(after(1440 + 10), { status: 'NO_SHOW' });

    await reminders.scheduleReminders(NOW);

    expect(await t.events()).toEqual([reminder(1440, after(1440))]);
  });

  it('writes nothing for a cancelled booking', async () => {
    const t = await setUp();
    await t.book(after(1440), { status: 'CANCELLED' });

    await reminders.scheduleReminders(NOW);

    expect(await t.events()).toEqual([]);
  });

  it('writes nothing for a booking made after the reminder time', async () => {
    const t = await setUp();
    await t.book(after(1440), { createdAt: after(1) });

    await reminders.scheduleReminders(NOW);

    expect(await t.events()).toEqual([]);
  });

  it('a moved booking keeps the old event and gets its own for the new start', async () => {
    const t = await setUp();
    const appointment = await t.book(after(1440));
    await reminders.scheduleReminders(NOW);

    const newStart = after(3 * 1440);
    await prisma.appointment.update({
      where: { id: appointment.id },
      data: { startsAt: newStart, endsAt: after(1, newStart) },
    });
    await reminders.scheduleReminders(after(5));
    expect(await t.events()).toEqual([reminder(1440, after(1440))]);

    await reminders.scheduleReminders(after(2 * 1440));
    expect(await t.events()).toEqual([reminder(1440, after(1440)), reminder(1440, newStart)]);
  });

  it('writes an event per offset, each at its own time', async () => {
    const t = await setUp([1440, 60]);
    await t.book(after(1440 + 60));

    await reminders.scheduleReminders(after(60));
    expect(await t.events()).toEqual([reminder(1440, after(1440 + 60))]);

    await reminders.scheduleReminders(after(1440));
    expect(await t.events()).toEqual([reminder(1440, after(1440 + 60)), reminder(60, after(1440 + 60))]);
  });

  it('writes nothing for a business with no offsets', async () => {
    const t = await setUp([]);
    await t.book(after(1440));
    await t.book(after(60));

    await reminders.scheduleReminders(NOW);

    expect(await t.events()).toEqual([]);
  });
});
