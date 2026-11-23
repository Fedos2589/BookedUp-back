import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { App } from 'supertest/types.js';

import { DispatcherService } from '../src/notifications/dispatcher.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createClient, memberOf, signUpOwner } from './helpers.js';
import { createTestApp } from './test-app.js';

let app: INestApplication<App>;
let prisma: PrismaService;
let dispatcher: DispatcherService;

beforeAll(async () => {
  app = await createTestApp();
  prisma = app.get(PrismaService);
  dispatcher = app.get(DispatcherService);
});

afterAll(async () => {
  await app.close();
});

const phone = () => `+7999${randomUUID().replace(/\D/g, '').padEnd(7, '1').slice(0, 7)}`;

// Other test files write events into the same database, and `expand` takes them 50 at a time.
const drain = async () => {
  while ((await dispatcher.expand(new Date())) > 0);
};

// A business with its owner, a master with an account and a booking of that master by `clientId`'s card.
const setUp = async () => {
  const owner = await signUpOwner(app);
  const businessId = owner.business.id;
  const master = await memberOf(app, businessId, 'MASTER');
  const staff = await prisma.staff.create({
    data: { businessId, name: 'Anna', userId: master.userId },
    select: { id: true },
  });
  const book = async (clientId: string, hour = 7) => {
    const startsAt = new Date(`2030-01-07T${String(hour).padStart(2, '0')}:00:00.000Z`);
    return prisma.appointment.create({
      data: {
        businessId,
        staffId: staff.id,
        clientId,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3_600_000),
        clientName: 'Vera',
        clientPhone: phone(),
      },
      select: { id: true, startsAt: true },
    });
  };
  // An online booking: no actor.
  const bookedEvent = (appointment: { id: string; startsAt: Date }) =>
    prisma.notificationEvent.create({
      data: { businessId, appointmentId: appointment.id, kind: 'BOOKED', startsAt: appointment.startsAt },
      select: { id: true },
    });
  const deliveries = async () =>
    (await prisma.notificationDelivery.findMany({ where: { businessId } }))
      .map((d) => `${d.channel} ${d.audience} ${d.locale} ${d.address}`)
      .sort();
  const emailOf = async (userId: string) => (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).email;
  const ownerId = (await prisma.membership.findFirstOrThrow({ where: { businessId, role: 'OWNER' } })).userId;
  return { businessId, master, ownerId, book, bookedEvent, deliveries, emailOf };
};

describe('events into deliveries', () => {
  it('turns an online booking into a delivery for the master, the owner and the client’s channel', async () => {
    const t = await setUp();
    const clientId = await createClient(prisma, t.businessId, phone());
    const appointment = await t.book(clientId);
    await prisma.clientChannel.create({
      data: {
        businessId: t.businessId,
        clientId,
        appointmentId: appointment.id,
        kind: 'TELEGRAM',
        address: '777',
        locale: 'ru',
      },
    });
    await t.bookedEvent(appointment);

    await drain();

    expect(await t.deliveries()).toEqual(
      [
        `LOG staff en ${await t.emailOf(t.ownerId)}`,
        `LOG staff en ${await t.emailOf(t.master.userId)}`,
        'LOG client ru 777',
      ].sort(),
    );
    expect(await prisma.notificationEvent.count({ where: { businessId: t.businessId, processedAt: null } })).toBe(0);
  });

  it('adds nothing the second time', async () => {
    const t = await setUp();
    await t.bookedEvent(await t.book(await createClient(prisma, t.businessId, phone())));

    await drain();
    const first = await t.deliveries();
    await drain();

    expect(first).toHaveLength(2);
    expect(await t.deliveries()).toEqual(first);
  });

  it('two expands at once give the same rows and no error', async () => {
    const t = await setUp();
    for (let hour = 7; hour < 10; hour++) {
      await t.bookedEvent(await t.book(await createClient(prisma, t.businessId, phone()), hour));
    }

    await Promise.all([drain(), drain()]);

    // Three events × (the owner, the master).
    expect(await t.deliveries()).toHaveLength(2 * 3);
    expect(await prisma.notificationEvent.count({ where: { businessId: t.businessId, processedAt: null } })).toBe(0);
  });

  it('reaches the guardian’s WhatsApp for a dependent, and skips a switched-off channel and another booking’s one', async () => {
    const t = await setUp();
    const guardianId = await createClient(prisma, t.businessId, phone());
    const dependent = await prisma.client.create({
      data: { businessId: t.businessId, name: 'Kid', guardianId },
      select: { id: true },
    });
    const appointment = await t.book(dependent.id);
    const other = await t.book(guardianId, 9);
    const channel = (data: {
      kind: 'WHATSAPP' | 'TELEGRAM';
      address: string;
      appointmentId: string | null;
      clientId: string;
    }) => prisma.clientChannel.create({ data: { businessId: t.businessId, locale: 'en', ...data } });
    await channel({ kind: 'WHATSAPP', address: '+70000000001', appointmentId: null, clientId: guardianId });
    await channel({ kind: 'TELEGRAM', address: 'of-the-other-booking', appointmentId: other.id, clientId: guardianId });
    await prisma.clientChannel.create({
      data: {
        businessId: t.businessId,
        clientId: dependent.id,
        appointmentId: appointment.id,
        kind: 'TELEGRAM',
        address: 'switched-off',
        locale: 'en',
        disabledAt: new Date(),
      },
    });
    await t.bookedEvent(appointment);

    await drain();

    const clientRows = (await t.deliveries()).filter((row) => row.includes(' client '));
    expect(clientRows).toEqual(['LOG client en +70000000001']);
  });

  it('leaves out a channel turned on after the event', async () => {
    const t = await setUp();
    const clientId = await createClient(prisma, t.businessId, phone());
    const appointment = await t.book(clientId);
    await t.bookedEvent(appointment);
    await prisma.clientChannel.create({
      data: {
        businessId: t.businessId,
        clientId,
        appointmentId: appointment.id,
        kind: 'TELEGRAM',
        address: 'late',
        locale: 'en',
      },
    });

    await drain();

    expect((await t.deliveries()).filter((row) => row.includes(' client '))).toEqual([]);
  });

  it('one event that cannot be read does not hold the others back', async () => {
    const t = await setUp();
    const appointment = await t.book(await createClient(prisma, t.businessId, phone()));
    // A MOVED event whose payload points at a staff id that is no id at all.
    const poisoned = await prisma.notificationEvent.create({
      data: {
        businessId: t.businessId,
        appointmentId: appointment.id,
        kind: 'MOVED',
        startsAt: appointment.startsAt,
        payload: { fromStaffId: 'not-an-id', fromStartsAt: appointment.startsAt.toISOString() },
      },
      select: { id: true },
    });
    await t.bookedEvent(appointment);

    await drain();

    expect(await t.deliveries()).toHaveLength(2);
    const left = await prisma.notificationEvent.findMany({ where: { businessId: t.businessId, processedAt: null } });
    expect(left.map((event) => event.id)).toEqual([poisoned.id]);
    // The shared database would keep retrying it, and logging, in every later test.
    await prisma.notificationEvent.delete({ where: { id: poisoned.id } });
  });
});
