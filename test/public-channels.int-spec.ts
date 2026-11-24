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

const subscription = (endpoint = `https://push.example/${randomUUID()}`) => ({
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

    await on(b.token, { subscription: sub, locale: 'ru' }).expect(200);

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

    await on(b.token, body).expect(200);
    await on(b.token, body).expect(200);

    expect(await channelsOf(b.appointmentId)).toHaveLength(1);
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
    await on(b.token, { ...good, subscription: subscription('http://push.example/x') }).expect(400);
    await on(b.token, { ...good, subscription: { endpoint: good.subscription.endpoint } }).expect(400);
    await on(b.token, { ...good, subscription: subscription(`https://push.example/${'a'.repeat(1000)}`) }).expect(400);
    await on(b.token, { ...good, locale: 'de' }).expect(400);
  });

  it('is 404 channelOff when Web Push is not on, and DELETE too', async () => {
    const b = await booking();
    const spy = vi.spyOn(app.get(ChannelRegistry), 'isOn').mockReturnValue(false);
    try {
      const put = await on(b.token, { subscription: subscription(), locale: 'en' }).expect(404);
      expect(put.body.code).toBe('channelOff');
      const del = await off(b.token, { endpoint: subscription().endpoint }).expect(404);
      expect(del.body.code).toBe('channelOff');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('DELETE /public/bookings/:token/push', () => {
  it('switches the subscription off but keeps its row; a PUT of the same endpoint switches it on with a new event', async () => {
    const b = await booking();
    const sub = subscription();
    await on(b.token, { subscription: sub, locale: 'en' }).expect(200);

    await off(b.token, { endpoint: sub.endpoint }).expect(204);

    const [switchedOff] = await channelsOf(b.appointmentId);
    expect(switchedOff!.disabledAt).not.toBeNull();

    await on(b.token, { subscription: sub, locale: 'en' }).expect(200);

    const channels = await channelsOf(b.appointmentId);
    expect(channels).toHaveLength(1);
    expect(channels[0]!.disabledAt).toBeNull();
    expect(await eventsOf(b.appointmentId)).toHaveLength(2);
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
    await on(elsewhere.token, { subscription: sub, locale: 'en' }).expect(200);
    await on(siblingToken, { subscription: sub, locale: 'en' }).expect(200);

    await off(mine.token, { endpoint: sub.endpoint }).expect(204);

    expect((await channelsOf(elsewhere.appointmentId))[0]!.disabledAt).toBeNull();
    expect((await channelsOf(sibling.id))[0]!.disabledAt).toBeNull();
  });
});

describe('sending a push', () => {
  const dispatch = async () => {
    const dispatcher = app.get(DispatcherService);
    await dispatcher.dispatch(new Date());
  };
  const pushesTo = (endpoint: string) => send.mock.calls.filter(([address]) => address === endpoint);

  it("gives a client's subscription its keys and the business's booking page, once", async () => {
    const b = await booking();
    const sub = subscription();
    await on(b.token, { subscription: sub, locale: 'en' }).expect(200);

    await dispatch();

    const [call] = pushesTo(sub.endpoint);
    expect(pushesTo(sub.endpoint)).toHaveLength(1);
    expect(call![2]).toEqual(sub.keys);
    expect(call![1]).toMatchObject({ url: `http://localhost:5173/book/${b.business.slug}` });
    expect(call![1].text).toContain(`http://localhost:5173/book/${b.business.slug}/manage/${b.token}`);
  });

  it("gives a member's subscription its keys and the cabinet's calendar", async () => {
    const b = await booking();
    // An admin hears of every online booking (notifyAllOnline is on by default).
    const master = await memberOf(app, b.business.id, 'ADMIN');
    const sub = subscription();
    await prisma.userChannel.create({
      data: { userId: master.userId, kind: 'PUSH', address: sub.endpoint, keys: sub.keys },
    });
    await prisma.notificationEvent.create({
      data: { businessId: b.business.id, appointmentId: b.appointmentId, kind: 'BOOKED', startsAt: new Date() },
    });

    await dispatch();

    const [call] = pushesTo(sub.endpoint);
    expect(call![2]).toEqual(sub.keys);
    expect(call![1]).toMatchObject({ url: 'http://localhost:5173/calendar' });
  });
});
