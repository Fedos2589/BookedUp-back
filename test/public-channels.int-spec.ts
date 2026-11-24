import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { MockInstance } from 'vitest';
import type { App } from 'supertest/types.js';
import { generateVAPIDKeys } from 'web-push';

import { hashRandomToken, newRandomToken } from '../src/common/random-token.js';
import { ChannelRegistry } from '../src/notifications/channels/channel-registry.js';
import { PushChannel } from '../src/notifications/channels/push.channel.js';
import { DispatcherService } from '../src/notifications/dispatcher.service.js';
import { messageFor } from '../src/notifications/messages.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { memberOf, onlineBooking } from './helpers.js';
import { createTestApp } from './test-app.js';

let app: INestApplication<App>;
let prisma: PrismaService;
let send: MockInstance<PushChannel['send']>;

beforeAll(async () => {
  // Read when the app is built: Web Push is on for every test here.
  const keys = generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
  process.env.VAPID_SUBJECT = 'mailto:ops@example.com';
  app = await createTestApp();
  prisma = app.get(PrismaService);
});

beforeEach(() => {
  send = vi.spyOn(app.get(PushChannel), 'send').mockResolvedValue('sent');
});

afterEach(() => send.mockRestore());

afterAll(async () => {
  await app.close();
  for (const name of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']) delete process.env[name];
});

const http = () => request(app.getHttpServer());
const booking = (status: 'BOOKED' | 'CANCELLED' = 'BOOKED', startsAt?: Date) =>
  onlineBooking(app, { status, ...(startsAt && { startsAt }) });

const subscription = (endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`) => ({
  endpoint,
  keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
});
const on = (token: string, body: object) => http().put(`/public/bookings/${token}/push`).send(body);
const off = (token: string, body: object) => http().delete(`/public/bookings/${token}/push`).send(body);
const channelsOf = (appointmentId: string) => prisma.clientChannel.findMany({ where: { appointmentId } });
const eventsOf = (appointmentId: string) =>
  prisma.notificationEvent.findMany({ where: { appointmentId, kind: 'CHANNEL_ON' } });

describe('PUT /public/bookings/:token/push', () => {
  it('saves the subscription on this booking and writes one CHANNEL_ON event with the manage link', async () => {
    const b = await booking();
    const sub = subscription();

    await on(b.token, { subscription: sub, locale: 'ru' }).expect(204);

    const [channel] = await channelsOf(b.appointmentId);
    expect(channel).toMatchObject({
      businessId: b.business.id,
      clientId: b.clientId,
      kind: 'PUSH',
      address: sub.endpoint,
      keys: sub.keys,
      locale: 'ru',
      disabledAt: null,
    });
    const [event] = await eventsOf(b.appointmentId);
    expect(event).toMatchObject({ channelId: channel!.id, businessId: b.business.id });
    expect(event!.payload).toEqual({
      manageLink: `http://localhost:5173/book/${b.business.slug}/manage/${b.token}`,
    });
  });

  it('twice with the same subscription is one channel and one event', async () => {
    const b = await booking();
    const body = { subscription: subscription(), locale: 'en' };

    await on(b.token, body).expect(204);
    await on(b.token, body).expect(204);

    expect(await channelsOf(b.appointmentId)).toHaveLength(1);
    expect(await eventsOf(b.appointmentId)).toHaveLength(1);
  });

  it('takes only the push services browsers use: another host is 400, the subscription is not saved', async () => {
    const b = await booking();
    for (const endpoint of [
      'https://10.0.0.5/push/abc',
      'https://internal.svc/push/abc',
      'https://fcm.googleapis.com.evil.example/x',
    ]) {
      await on(b.token, { subscription: subscription(endpoint), locale: 'en' }).expect(400);
    }
    for (const endpoint of [
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/abc',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
    ]) {
      await on(b.token, { subscription: subscription(endpoint), locale: 'en' }).expect(204);
    }
    expect(await channelsOf(b.appointmentId)).toHaveLength(3);
  });

  it('keeps the new keys when the same endpoint comes again, without a second event', async () => {
    const b = await booking();
    const sub = subscription();
    await on(b.token, { subscription: sub, locale: 'en' }).expect(204);

    await on(b.token, {
      subscription: { ...sub, keys: { p256dh: 'new-p256dh', auth: 'new-auth' } },
      locale: 'en',
    }).expect(204);

    expect((await channelsOf(b.appointmentId))[0]!.keys).toEqual({ p256dh: 'new-p256dh', auth: 'new-auth' });
    expect(await eventsOf(b.appointmentId)).toHaveLength(1);
  });

  it('is 409 badTransition once the booking is cancelled or has started', async () => {
    const cancelled = await booking('CANCELLED');
    const started = await booking('BOOKED', new Date(Date.now() - 3600_000));
    for (const b of [cancelled, started]) {
      const res = await on(b.token, { subscription: subscription(), locale: 'en' }).expect(409);
      expect(res.body.code).toBe('badTransition');
      expect(await channelsOf(b.appointmentId)).toHaveLength(0);
    }
  });

  it('is 404 for an unknown token, 400 for a bad token, a non-https endpoint, a missing key or an unknown locale', async () => {
    const b = await booking();
    const good = { subscription: subscription(), locale: 'en' };
    await on(newRandomToken(), good).expect(404);
    await on('short', good).expect(400);
    await on(b.token, { ...good, subscription: subscription('http://fcm.googleapis.com/x') }).expect(400);
    await on(b.token, { ...good, subscription: { endpoint: good.subscription.endpoint } }).expect(400);
    await on(b.token, { ...good, subscription: subscription(`https://fcm.googleapis.com/${'a'.repeat(1000)}`) }).expect(
      400,
    );
    await on(b.token, { ...good, locale: 'de' }).expect(400);
  });

  it('is 404 channelOff when Web Push is not on; turning it off still works', async () => {
    const b = await booking();
    const spy = vi.spyOn(app.get(ChannelRegistry), 'isOn').mockReturnValue(false);
    try {
      const put = await on(b.token, { subscription: subscription(), locale: 'en' }).expect(404);
      expect(put.body.code).toBe('channelOff');
      await off(b.token, { endpoint: subscription().endpoint }).expect(204);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('DELETE /public/bookings/:token/push', () => {
  it('switches the subscription off but keeps its row; a PUT of the same endpoint switches it on with a new event', async () => {
    const b = await booking();
    const sub = subscription();
    await on(b.token, { subscription: sub, locale: 'en' }).expect(204);

    await off(b.token, { endpoint: sub.endpoint }).expect(204);

    const [switchedOff] = await channelsOf(b.appointmentId);
    expect(switchedOff!.disabledAt).not.toBeNull();

    await on(b.token, { subscription: sub, locale: 'en' }).expect(204);

    const channels = await channelsOf(b.appointmentId);
    expect(channels).toHaveLength(1);
    expect(channels[0]!.disabledAt).toBeNull();
    expect(await eventsOf(b.appointmentId)).toHaveLength(2);
  });

  it("stays off when the same browser turns push on for the client's next booking", async () => {
    const first = await booking();
    const sub = subscription();
    await on(first.token, { subscription: sub, locale: 'en' }).expect(204);
    await off(first.token, { endpoint: sub.endpoint }).expect(204);
    const {
      id: _id,
      createdAt: _created,
      updatedAt: _updated,
      ...row
    } = await prisma.appointment.findUniqueOrThrow({
      where: { id: first.appointmentId },
    });
    const nextToken = newRandomToken();
    const next = await prisma.appointment.create({
      data: {
        ...row,
        startsAt: new Date(row.startsAt.getTime() + 2 * 3600_000),
        endsAt: new Date(row.endsAt.getTime() + 2 * 3600_000),
        manageTokenHash: hashRandomToken(nextToken),
      },
    });

    await on(nextToken, { subscription: sub, locale: 'en' }).expect(204);

    expect((await channelsOf(first.appointmentId))[0]!.disabledAt).not.toBeNull();
    expect((await channelsOf(next.id))[0]!.disabledAt).toBeNull();
  });

  it("cannot switch off another booking's subscription, in this business or another, even with its endpoint", async () => {
    const mine = await booking();
    const elsewhere = await booking();
    // A second booking of the same business and client, with its own token.
    const {
      id: _id,
      createdAt: _created,
      updatedAt: _updated,
      ...first
    } = await prisma.appointment.findUniqueOrThrow({
      where: { id: mine.appointmentId },
    });
    const siblingToken = newRandomToken();
    const sibling = await prisma.appointment.create({
      data: {
        ...first,
        startsAt: new Date(first.startsAt.getTime() + 2 * 3600_000),
        endsAt: new Date(first.endsAt.getTime() + 2 * 3600_000),
        manageTokenHash: hashRandomToken(siblingToken),
      },
    });
    const sub = subscription();
    await on(elsewhere.token, { subscription: sub, locale: 'en' }).expect(204);
    await on(siblingToken, { subscription: sub, locale: 'en' }).expect(204);

    await off(mine.token, { endpoint: sub.endpoint }).expect(204);

    expect((await channelsOf(elsewhere.appointmentId))[0]!.disabledAt).toBeNull();
    expect((await channelsOf(sibling.id))[0]!.disabledAt).toBeNull();
  });
});

describe('sending a push', () => {
  // Other specs' apps share this database. Each one's dispatch takes the kinds it has, so this app takes pushes
  // only, and never their log deliveries. Their `expand` could turn our events into deliveries of the kind
  // they have (a log line), so each test writes its event as already processed and its delivery itself.
  let kinds: MockInstance<ChannelRegistry['kinds']>;
  beforeEach(() => {
    kinds = vi.spyOn(app.get(ChannelRegistry), 'kinds').mockReturnValue(['PUSH']);
  });
  afterEach(() => kinds.mockRestore());

  // `send` only: `expand` takes every spec's unprocessed events, and this spec has no business with theirs.
  // Batch after batch (50 a time): earlier runs may have left pushes of their own in the queue.
  const dispatch = async () => {
    const dispatcher = app.get(DispatcherService);
    while ((await dispatcher.send(new Date())) === 50);
  };
  const pushesTo = (endpoint: string) => send.mock.calls.filter(([address]) => address === endpoint);

  const queued = async (
    b: Awaited<ReturnType<typeof booking>>,
    audience: 'client' | 'staff',
    endpoint: string,
    event: { kind: 'BOOKED' | 'CHANNEL_ON'; channelId?: string; payload?: object },
  ) => {
    const { id: eventId } = await prisma.notificationEvent.create({
      data: {
        businessId: b.business.id,
        appointmentId: b.appointmentId,
        startsAt: new Date(Date.now() + 86_400_000),
        processedAt: new Date(),
        ...event,
      },
    });
    await prisma.notificationDelivery.create({
      data: { businessId: b.business.id, eventId, channel: 'PUSH', address: endpoint, audience, locale: 'en' },
    });
  };
  const channelOf = (appointmentId: string) => prisma.clientChannel.findFirstOrThrow({ where: { appointmentId } });

  it("gives a client's subscription its keys and the business's booking page, once", async () => {
    const b = await booking();
    const sub = subscription();
    await on(b.token, { subscription: sub, locale: 'en' }).expect(204);
    const manageLink = `http://localhost:5173/book/${b.business.slug}/manage/${b.token}`;
    await queued(b, 'client', sub.endpoint, {
      kind: 'CHANNEL_ON',
      channelId: (await channelOf(b.appointmentId)).id,
      payload: { manageLink },
    });

    await dispatch();
    await dispatch();

    expect(pushesTo(sub.endpoint)).toHaveLength(1);
    const [call] = pushesTo(sub.endpoint);
    expect(call![2]).toEqual(sub.keys);
    expect(call![1]).toMatchObject({ url: `http://localhost:5173/book/${b.business.slug}` });
    expect(messageFor(call![1]).text).toContain(manageLink);
  });

  it('sends nothing to a subscription the client switched off after the message was queued', async () => {
    const b = await booking();
    const sub = subscription();
    await on(b.token, { subscription: sub, locale: 'en' }).expect(204);
    await queued(b, 'client', sub.endpoint, { kind: 'BOOKED' });
    await off(b.token, { endpoint: sub.endpoint }).expect(204);

    await dispatch();

    expect(pushesTo(sub.endpoint)).toHaveLength(0);
    const delivery = await prisma.notificationDelivery.findFirstOrThrow({
      where: { businessId: b.business.id, channel: 'PUSH', address: sub.endpoint },
    });
    expect(delivery).toMatchObject({ status: 'FAILED', lastError: 'booking changed' });
  });

  it('leaves a delivery of a kind this process does not send for one that does', async () => {
    const b = await booking();
    const sub = subscription();
    await on(b.token, { subscription: sub, locale: 'en' }).expect(204);
    await queued(b, 'client', sub.endpoint, { kind: 'BOOKED' });
    kinds.mockReturnValue(['LOG']);

    await dispatch();

    expect(pushesTo(sub.endpoint)).toHaveLength(0);
    const delivery = await prisma.notificationDelivery.findFirstOrThrow({
      where: { businessId: b.business.id, channel: 'PUSH', address: sub.endpoint },
    });
    expect(delivery).toMatchObject({ status: 'PENDING', attempts: 0 });
    // Not left for a later run to send.
    await prisma.notificationDelivery.deleteMany({ where: { id: delivery.id, businessId: b.business.id } });
  });

  it("gives a member's subscription its keys and the cabinet's calendar", async () => {
    const b = await booking();
    const member = await memberOf(app, b.business.id, 'ADMIN');
    const sub = subscription();
    await prisma.userChannel.create({
      data: { userId: member.userId, kind: 'PUSH', address: sub.endpoint, keys: sub.keys },
    });
    await queued(b, 'staff', sub.endpoint, { kind: 'BOOKED' });

    await dispatch();

    const [call] = pushesTo(sub.endpoint);
    expect(call![2]).toEqual(sub.keys);
    expect(call![1]).toMatchObject({ url: 'http://localhost:5173/calendar' });
  });
});
