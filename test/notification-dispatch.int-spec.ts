import type { INestApplication } from '@nestjs/common';
import { inject, type MockInstance } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { App } from 'supertest/types.js';

import { LogChannel } from '../src/notifications/channels/log.channel.js';
import { DispatcherService } from '../src/notifications/dispatcher.service.js';
import { messageFor } from '../src/notifications/messages.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createClient, memberOf, signUpOwner } from './helpers.js';
import { createTestApp } from './test-app.js';

let app: INestApplication<App>;
let prisma: PrismaService;
let dispatcher: DispatcherService;

beforeAll(async () => {
  app = await createTestApp({ databaseUrl: inject('dispatchDatabaseUrl') });
  prisma = app.get(PrismaService);
  dispatcher = app.get(DispatcherService);
});

afterAll(async () => {
  await app.close();
});

const after = (from: Date, seconds: number) => new Date(from.getTime() + seconds * 1000);

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

  it('reaches the Telegram on a client card for the client’s and a dependent’s bookings, once when a booking has the same chat', async () => {
    const t = await setUp();
    const guardianId = await createClient(prisma, t.businessId, phone());
    const dependent = await prisma.client.create({
      data: { businessId: t.businessId, name: 'Kid', guardianId },
      select: { id: true },
    });
    const stranger = await createClient(prisma, t.businessId, phone());
    const own = await t.book(guardianId, 8);
    const kids = await t.book(dependent.id, 9);
    const channel = (clientId: string, appointmentId: string | null, address: string) =>
      prisma.clientChannel.create({
        data: { businessId: t.businessId, clientId, appointmentId, kind: 'TELEGRAM', address, locale: 'en' },
      });
    await channel(guardianId, null, 'card-chat');
    await channel(stranger, null, 'strangers-card');
    await channel(guardianId, own.id, 'card-chat');
    await t.bookedEvent(own);
    await t.bookedEvent(kids);

    await drain();

    // Two events: the card's chat hears of each; the same chat on the booking too makes no second message.
    const clientRows = (await t.deliveries()).filter((row) => row.includes(' client '));
    expect(clientRows).toEqual(['LOG client en card-chat', 'LOG client en card-chat']);
    const perEvent = await prisma.notificationDelivery.groupBy({
      by: ['eventId'],
      where: { businessId: t.businessId, audience: 'client' },
      _count: true,
    });
    expect(perEvent.map((g) => g._count)).toEqual([1, 1]);
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
        // Not «now»: the event's own timestamp can fall in the same millisecond.
        createdAt: new Date(Date.now() + 60_000),
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

describe('sending deliveries', () => {
  let send: MockInstance<LogChannel['send']>;
  beforeEach(() => {
    send = vi.spyOn(app.get(LogChannel), 'send').mockResolvedValue('sent');
  });
  afterEach(() => {
    send.mockRestore();
  });

  // Other tests' deliveries are in the same database and go out with ours: look at our addresses only.
  const sentTo = (addresses: string[]) =>
    send.mock.calls
      .map(([address]) => address)
      .filter((address) => addresses.includes(address))
      .sort();
  const statusesOf = async (businessId: string) =>
    (await prisma.notificationDelivery.findMany({ where: { businessId } })).map((d) => d.status).sort();

  // An online booking with a Telegram client channel: three deliveries (owner, master, client).
  const booked = async () => {
    const t = await setUp();
    const clientId = await createClient(prisma, t.businessId, phone());
    const appointment = await t.book(clientId);
    const address = randomUUID();
    const channel = await prisma.clientChannel.create({
      data: {
        businessId: t.businessId,
        clientId,
        appointmentId: appointment.id,
        kind: 'TELEGRAM',
        address,
        locale: 'ru',
      },
    });
    const event = await t.bookedEvent(appointment);
    const addresses = [await t.emailOf(t.ownerId), await t.emailOf(t.master.userId), address];
    return { ...t, address, addresses, channel, event, appointment, clientId };
  };

  it('sends each recipient their message once', async () => {
    const t = await booked();

    await dispatcher.dispatch(new Date());
    await dispatcher.dispatch(new Date());

    expect(sentTo(t.addresses)).toEqual([...t.addresses].sort());
    expect(await statusesOf(t.businessId)).toEqual(['SENT', 'SENT', 'SENT']);
    const [, input] = send.mock.calls.find(([address]) => address === t.address) ?? [];
    expect(input && messageFor(input).text).toContain('Anna');
  });

  it('sends more than one batch in one dispatch', async () => {
    const t = await booked();
    await drain();
    const addresses = Array.from({ length: 60 }, () => randomUUID());
    await prisma.notificationDelivery.createMany({
      data: addresses.map((address) => ({
        businessId: t.businessId,
        eventId: t.event.id,
        channel: 'LOG' as const,
        address,
        audience: 'client',
        locale: 'ru',
      })),
    });

    await dispatcher.dispatch(new Date());

    expect(sentTo(addresses)).toEqual([...addresses].sort());
  });

  it('two dispatches at once send each delivery once', async () => {
    const t = await booked();

    await Promise.all([dispatcher.dispatch(new Date()), dispatcher.dispatch(new Date())]);

    expect(sentTo(t.addresses)).toEqual([...t.addresses].sort());
  });

  it('retries a failure after a minute, not on the next tick', async () => {
    const t = await booked();
    send.mockImplementation(async (address) => {
      if (address === t.address) throw new Error('provider down');
      return 'sent';
    });
    const now = new Date();

    await dispatcher.dispatch(now);
    expect(await statusesOf(t.businessId)).toEqual(['FAILED', 'SENT', 'SENT']);
    const failed = await prisma.notificationDelivery.findFirstOrThrow({
      where: { businessId: t.businessId, status: 'FAILED' },
    });
    expect(failed.lastError).toBe('provider down');

    send.mockResolvedValue('sent');
    await dispatcher.dispatch(after(now, 30));
    expect(await statusesOf(t.businessId)).toEqual(['FAILED', 'SENT', 'SENT']);

    await dispatcher.dispatch(after(now, 60));
    expect(await statusesOf(t.businessId)).toEqual(['SENT', 'SENT', 'SENT']);
  });

  it('spreads three tries over more than ten minutes, then stops', async () => {
    const u = await booked();
    send.mockRejectedValue(new Error('still down'));
    const now = new Date();
    const triesTo = () => send.mock.calls.filter(([address]) => address === u.address).length;

    await dispatcher.dispatch(now);
    await dispatcher.dispatch(after(now, 60));
    expect(triesTo()).toBe(2);
    // The second failure waits ten minutes.
    await dispatcher.dispatch(after(now, 60 + 9 * 60));
    expect(triesTo()).toBe(2);
    await dispatcher.dispatch(after(now, 60 + 10 * 60));
    await dispatcher.dispatch(after(now, 24 * 3600));

    expect(triesTo()).toBe(3);
    expect(await statusesOf(u.businessId)).toEqual(['FAILED', 'FAILED', 'FAILED']);
  });

  it('never picks a delivery left SENDING again', async () => {
    const t = await booked();
    await drain();
    await prisma.notificationDelivery.updateMany({ where: { businessId: t.businessId }, data: { status: 'SENDING' } });

    await dispatcher.dispatch(new Date());

    expect(sentTo(t.addresses)).toEqual([]);
  });

  it('switches the client channel off when the address is unreachable, and keeps its row and event', async () => {
    const t = await booked();
    send.mockImplementation(async (address) => (address === t.address ? 'unreachable' : 'sent'));

    await dispatcher.dispatch(new Date());
    await dispatcher.dispatch(new Date());

    const channel = await prisma.clientChannel.findUniqueOrThrow({ where: { id: t.channel.id } });
    expect(channel.disabledAt).not.toBeNull();
    expect(await prisma.notificationEvent.count({ where: { id: t.event.id } })).toBe(1);
    expect(send.mock.calls.filter(([address]) => address === t.address)).toHaveLength(1);
    expect(await statusesOf(t.businessId)).toEqual(['FAILED', 'SENT', 'SENT']);
  });

  it('does not send again what got no answer, and keeps the channel on', async () => {
    const t = await booked();
    send.mockImplementation(async (address) => (address === t.address ? 'unknown' : 'sent'));

    await dispatcher.dispatch(new Date(Date.now() + 3_600_000));
    await dispatcher.dispatch(new Date(Date.now() + 7_200_000));

    expect(send.mock.calls.filter(([address]) => address === t.address)).toHaveLength(1);
    const channel = await prisma.clientChannel.findUniqueOrThrow({ where: { id: t.channel.id } });
    expect(channel.disabledAt).toBeNull();
    const delivery = await prisma.notificationDelivery.findFirstOrThrow({
      where: { businessId: t.businessId, address: t.address },
    });
    expect(delivery).toMatchObject({ status: 'FAILED', lastError: 'no answer' });
  });

  it('deletes a member’s channel when the address is unreachable', async () => {
    const t = await booked();
    const address = randomUUID();
    await prisma.userChannel.create({ data: { userId: t.master.userId, kind: 'TELEGRAM', address } });
    await prisma.notificationEvent.deleteMany({ where: { id: t.event.id } });
    await t.bookedEvent(t.appointment);
    send.mockImplementation(async (to) => (to === address ? 'unreachable' : 'sent'));

    await dispatcher.dispatch(new Date());

    expect(await prisma.userChannel.count({ where: { userId: t.master.userId } })).toBe(0);
  });

  it('wipes the manage link from a CHANNEL_ON event once its message is out, and sends it', async () => {
    const t = await booked();
    const link = `https://example.test/manage/${randomUUID()}`;
    const event = await prisma.notificationEvent.create({
      data: {
        businessId: t.businessId,
        appointmentId: t.appointment.id,
        kind: 'CHANNEL_ON',
        channelId: t.channel.id,
        startsAt: t.appointment.startsAt,
        payload: { manageLink: link },
      },
    });

    await dispatcher.dispatch(new Date());

    const texts = send.mock.calls
      .filter(([address]) => address === t.address)
      .map(([, input]) => messageFor(input).text);
    expect(texts.filter((text) => text.includes(link))).toHaveLength(1);
    expect((await prisma.notificationEvent.findUniqueOrThrow({ where: { id: event.id } })).payload).toBeNull();
  });

  it('does not send twice when the database fails after a message went out, and the rest of the batch still goes', async () => {
    const t = await booked();
    // The first write of one of our results (a SENT) fails once. Other tests' deliveries go out in the same
    // dispatch, so the first write overall may be theirs.
    const updateMany = prisma.notificationDelivery.updateMany.bind(prisma.notificationDelivery);
    let failed = false;
    const write = vi.spyOn(prisma.notificationDelivery, 'updateMany').mockImplementation(((args) => {
      if (!failed && args.where?.businessId === t.businessId) {
        failed = true;
        return Promise.reject(new Error('db down'));
      }
      return updateMany(args);
    }) as typeof updateMany);

    await dispatcher.dispatch(new Date());
    write.mockRestore();
    await dispatcher.dispatch(new Date());

    expect(sentTo(t.addresses)).toEqual([...t.addresses].sort());
    expect(await statusesOf(t.businessId)).toEqual(['SENDING', 'SENT', 'SENT']);
  });

  it('does not send a reminder for a booking that was cancelled or moved since the event', async () => {
    const t = await booked();
    const reminderOf = (startsAt: Date) =>
      prisma.notificationEvent.create({
        data: {
          businessId: t.businessId,
          appointmentId: t.appointment.id,
          kind: 'REMINDER',
          offsetMinutes: 1440,
          startsAt,
        },
      });
    await drain();
    await prisma.notificationDelivery.deleteMany({ where: { businessId: t.businessId } });
    await prisma.notificationEvent.deleteMany({ where: { businessId: t.businessId } });
    const stale = await reminderOf(new Date(t.appointment.startsAt.getTime() - 3_600_000));
    const cancelled = await reminderOf(t.appointment.startsAt);
    await prisma.appointment.update({ where: { id: t.appointment.id }, data: { status: 'CANCELLED' } });

    await dispatcher.dispatch(new Date());

    expect(sentTo(t.addresses)).toEqual([]);
    const rows = await prisma.notificationDelivery.findMany({ where: { eventId: { in: [stale.id, cancelled.id] } } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((d) => d.status === 'FAILED' && d.attempts === 3)).toBe(true);
  });
});
