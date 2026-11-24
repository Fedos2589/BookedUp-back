import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { ChannelRegistry } from '../src/notifications/channels/channel-registry.js';
import { DispatcherService } from '../src/notifications/dispatcher.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createClient, memberOf, signUpOwner, userIdOf } from './helpers.js';
import { createTestApp } from './test-app.js';

let app: INestApplication<App>;
let prisma: PrismaService;

beforeAll(async () => {
  app = await createTestApp();
  prisma = app.get(PrismaService);
});

afterAll(async () => {
  await app.close();
});

const http = () => request(app.getHttpServer());
const mine = '/me/notifications';
const inBusiness = (businessId: string) => `/businesses/${businessId}/me/notifications`;

describe('my email switch', () => {
  it('is on until switched, and changes only the caller’s account', async () => {
    const me = await signUpOwner(app);
    const other = await signUpOwner(app);
    await http().get(mine).set('Cookie', me.cookie).expect(200);
    expect((await http().get(mine).set('Cookie', me.cookie)).body.email).toBe(true);

    const put = await http().put(mine).set('Cookie', me.cookie).send({ email: false }).expect(200);

    expect(put.body.email).toBe(false);
    expect((await http().get(mine).set('Cookie', me.cookie)).body.email).toBe(false);
    expect((await http().get(mine).set('Cookie', other.cookie)).body.email).toBe(true);
  });

  it('wants a boolean and a session', async () => {
    const me = await signUpOwner(app);

    await http().put(mine).set('Cookie', me.cookie).send({ email: 'no' }).expect(400);
    await http().get(mine).expect(401);
  });
});

describe('my «all online bookings» switch in a business', () => {
  it('is on for the owner and an admin, and not offered (null) to a master', async () => {
    const owner = await signUpOwner(app);
    const admin = await memberOf(app, owner.business.id, 'ADMIN');
    const master = await memberOf(app, owner.business.id, 'MASTER');
    const url = inBusiness(owner.business.id);

    await http().get(url).set('Cookie', owner.cookie).expect(200).expect({ allOnline: true });
    await http().get(url).set('Cookie', admin.cookie).expect(200).expect({ allOnline: true });
    await http().get(url).set('Cookie', master.cookie).expect(200).expect({ allOnline: null });
  });

  it('changes only the caller’s own membership', async () => {
    const owner = await signUpOwner(app);
    const admin = await memberOf(app, owner.business.id, 'ADMIN');
    const url = inBusiness(owner.business.id);

    await http()
      .put(url)
      .set('Cookie', admin.cookie)
      .send({ allOnline: false })
      .expect(200)
      .expect({ allOnline: false });

    await http().get(url).set('Cookie', admin.cookie).expect(200).expect({ allOnline: false });
    await http().get(url).set('Cookie', owner.cookie).expect(200).expect({ allOnline: true });
  });

  it('answers 400 to a master, and keeps their row', async () => {
    const owner = await signUpOwner(app);
    const master = await memberOf(app, owner.business.id, 'MASTER');
    const url = inBusiness(owner.business.id);

    await http().put(url).set('Cookie', master.cookie).send({ allOnline: false }).expect(400);

    await http().get(url).set('Cookie', master.cookie).expect(200).expect({ allOnline: null });
  });

  it('answers 400 to something that is not a boolean', async () => {
    const owner = await signUpOwner(app);

    await http().put(inBusiness(owner.business.id)).set('Cookie', owner.cookie).send({ allOnline: 'no' }).expect(400);
  });

  it('is closed to someone who is not a member of the business', async () => {
    const owner = await signUpOwner(app);
    const stranger = await signUpOwner(app);
    const url = inBusiness(owner.business.id);

    await http().get(url).set('Cookie', stranger.cookie).expect(403);
    await http().put(url).set('Cookie', stranger.cookie).send({ allOnline: false }).expect(403);

    await http().get(url).set('Cookie', owner.cookie).expect(200).expect({ allOnline: true });
  });
});

describe('my channels', () => {
  const channels = async (userId: string) =>
    (await prisma.userChannel.findMany({ where: { userId }, orderBy: { address: 'asc' } })).map(
      ({ kind, address }) => `${kind} ${address}`,
    );
  const subscription = () => ({
    endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
    keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
  });
  const phone = () => `+7999${randomUUID().replace(/\D/g, '').padEnd(7, '1').slice(0, 7)}`;

  // Every channel is configured here, so a PUT is not turned away; each test that wants it off says so.
  let isOn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    isOn = vi.spyOn(app.get(ChannelRegistry), 'isOn').mockReturnValue(true);
  });
  afterEach(() => isOn.mockRestore());

  it('keeps one WhatsApp number: the second PUT replaces the first', async () => {
    const me = await signUpOwner(app);
    const [first, second] = [phone(), phone()];

    await http().put(`${mine}/whatsapp`).set('Cookie', me.cookie).send({ phone: first }).expect(204);
    await http().put(`${mine}/whatsapp`).set('Cookie', me.cookie).send({ phone: second }).expect(204);
    await http().put(`${mine}/whatsapp`).set('Cookie', me.cookie).send({ phone: second }).expect(204);

    expect(await channels(await userIdOf(app, me.cookie))).toEqual([`WHATSAPP ${second}`]);
    await http().delete(`${mine}/whatsapp`).set('Cookie', me.cookie).expect(204);
    expect(await channels(await userIdOf(app, me.cookie))).toEqual([]);
  });

  it('wants an E.164 number for WhatsApp, and a session', async () => {
    const me = await signUpOwner(app);

    await http().put(`${mine}/whatsapp`).set('Cookie', me.cookie).send({ phone: '8 999 123' }).expect(400);
    await http().put(`${mine}/whatsapp`).send({ phone: phone() }).expect(401);
    await http().delete(`${mine}/whatsapp`).expect(401);
  });

  it('keeps a row per push device; DELETE removes only the named one', async () => {
    const me = await signUpOwner(app);
    const [a, b] = [subscription(), subscription()];
    for (const sub of [a, b]) {
      await http().put(`${mine}/push`).set('Cookie', me.cookie).send({ subscription: sub }).expect(204);
    }
    await http().put(`${mine}/push`).set('Cookie', me.cookie).send({ subscription: a }).expect(204);
    const userId = await userIdOf(app, me.cookie);
    expect(await prisma.userChannel.count({ where: { userId, kind: 'PUSH' } })).toBe(2);

    await http().delete(`${mine}/push`).set('Cookie', me.cookie).send({ endpoint: a.endpoint }).expect(204);

    expect(await channels(userId)).toEqual([`PUSH ${b.endpoint}`]);
  });

  it('refreshes the keys of a device that subscribed again', async () => {
    const me = await signUpOwner(app);
    const sub = subscription();
    await http().put(`${mine}/push`).set('Cookie', me.cookie).send({ subscription: sub }).expect(204);

    const keys = { p256dh: 'new-key', auth: 'new-auth' };
    await http()
      .put(`${mine}/push`)
      .set('Cookie', me.cookie)
      .send({ subscription: { ...sub, keys } })
      .expect(204);

    const row = await prisma.userChannel.findFirstOrThrow({ where: { kind: 'PUSH', address: sub.endpoint } });
    expect(row.keys).toEqual(keys);
  });

  it('does not let user A remove user B’s device', async () => {
    const a = await signUpOwner(app);
    const b = await signUpOwner(app);
    const sub = subscription();
    await http().put(`${mine}/push`).set('Cookie', b.cookie).send({ subscription: sub }).expect(204);

    await http().delete(`${mine}/push`).set('Cookie', a.cookie).send({ endpoint: sub.endpoint }).expect(204);

    expect(await channels(await userIdOf(app, b.cookie))).toEqual([`PUSH ${sub.endpoint}`]);
  });

  it('refuses a push endpoint of a host that is not a push service', async () => {
    const me = await signUpOwner(app);
    const subscriptionOf = { ...subscription(), endpoint: 'https://evil.example/push' };

    await http().put(`${mine}/push`).set('Cookie', me.cookie).send({ subscription: subscriptionOf }).expect(400);
  });

  it('removes the Telegram chat, and only the caller’s', async () => {
    const me = await signUpOwner(app);
    const other = await signUpOwner(app);
    const [meId, otherId] = [await userIdOf(app, me.cookie), await userIdOf(app, other.cookie)];
    await prisma.userChannel.createMany({
      data: [
        { userId: meId, kind: 'TELEGRAM', address: randomUUID() },
        { userId: otherId, kind: 'TELEGRAM', address: randomUUID() },
      ],
    });

    await http().delete(`${mine}/telegram`).set('Cookie', me.cookie).expect(204);

    expect(await channels(meId)).toEqual([]);
    expect(await channels(otherId)).toHaveLength(1);
    await http().delete(`${mine}/telegram`).expect(401);
  });

  it('is 404 channelOff to turn on a channel that is off here, and still lets one be switched off', async () => {
    const me = await signUpOwner(app);
    isOn.mockReturnValue(false);

    const whatsapp = await http().put(`${mine}/whatsapp`).set('Cookie', me.cookie).send({ phone: phone() });
    const push = await http().put(`${mine}/push`).set('Cookie', me.cookie).send({ subscription: subscription() });

    expect([whatsapp.status, whatsapp.body.code]).toEqual([404, 'channelOff']);
    expect([push.status, push.body.code]).toEqual([404, 'channelOff']);
    await http().delete(`${mine}/whatsapp`).set('Cookie', me.cookie).expect(204);
    await http()
      .delete(`${mine}/push`)
      .set('Cookie', me.cookie)
      .send({ endpoint: subscription().endpoint })
      .expect(204);
  });

  it('gives a master’s online booking a delivery per channel they have', async () => {
    const owner = await signUpOwner(app);
    const businessId = owner.business.id;
    const master = await memberOf(app, businessId, 'MASTER');
    const staff = await prisma.staff.create({ data: { businessId, name: 'Anna', userId: master.userId } });
    const sub = subscription();
    const [telegram, whatsapp] = [randomUUID(), phone()];
    await prisma.userChannel.create({ data: { userId: master.userId, kind: 'TELEGRAM', address: telegram } });
    await http().put(`${mine}/whatsapp`).set('Cookie', master.cookie).send({ phone: whatsapp }).expect(204);
    await http().put(`${mine}/push`).set('Cookie', master.cookie).send({ subscription: sub }).expect(204);
    const startsAt = new Date('2030-01-07T07:00:00.000Z');
    const appointment = await prisma.appointment.create({
      data: {
        businessId,
        staffId: staff.id,
        clientId: await createClient(prisma, businessId, phone()),
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3_600_000),
        clientName: 'Vera',
        clientPhone: phone(),
      },
    });
    await prisma.notificationEvent.create({
      data: { businessId, appointmentId: appointment.id, kind: 'BOOKED', startsAt },
    });
    const dispatcher = app.get(DispatcherService);
    // Other test files write events into the same database, and `expand` takes them 50 at a time.
    while ((await dispatcher.expand(new Date())) > 0);

    const masterEmail = (await prisma.user.findUniqueOrThrow({ where: { id: master.userId } })).email;
    const owned = (await prisma.notificationDelivery.findMany({ where: { businessId, audience: 'staff' } })).map(
      (d) => d.address,
    );
    // By address, not by channel: another test file's `expand` may have taken the event, with its own channels on.
    // Email, Telegram and push. A member's WhatsApp number is stored but never messaged: WhatsApp sends client
    // templates only (recipients.ts), so a delivery to it would fail every time.
    expect(owned).toContain(masterEmail);
    expect(owned).toContain(sub.endpoint);
    expect(owned).toContain(telegram);
    expect(owned).not.toContain(whatsapp);
    expect(owned).toHaveLength(4); // those three, and the owner's email
  });
});

describe('GET /me/notifications: what is on', () => {
  it('is all off with no keys and no channels', async () => {
    const me = await signUpOwner(app);

    const res = await http().get(mine).set('Cookie', me.cookie).expect(200);

    expect(res.body).toEqual({
      available: { telegram: false, whatsapp: false, push: false, email: false },
      pushKey: null,
      email: true,
      telegram: false,
      whatsapp: null,
      push: [],
    });
  });

  it('follows the keys, and shows my own channels only', async () => {
    const me = await signUpOwner(app);
    const other = await signUpOwner(app);
    const [meId, otherId] = [await userIdOf(app, me.cookie), await userIdOf(app, other.cookie)];
    const keys = { p256dh: 'a', auth: 'b' };
    await prisma.userChannel.createMany({
      data: [
        { userId: meId, kind: 'TELEGRAM', address: randomUUID() },
        { userId: meId, kind: 'WHATSAPP', address: '+79990001122' },
        { userId: meId, kind: 'PUSH', address: 'https://fcm.googleapis.com/fcm/send/1', keys },
        { userId: otherId, kind: 'PUSH', address: 'https://fcm.googleapis.com/fcm/send/2', keys },
      ],
    });
    const registry = app.get(ChannelRegistry);
    const on = vi.spyOn(registry, 'isOn').mockReturnValue(true);
    const key = vi.spyOn(registry, 'pushKey').mockReturnValue('public-key');
    try {
      const res = await http().get(mine).set('Cookie', me.cookie).expect(200);

      expect(res.body).toEqual({
        available: { telegram: true, whatsapp: true, push: true, email: true },
        pushKey: 'public-key',
        email: true,
        telegram: true,
        whatsapp: '+79990001122',
        push: ['https://fcm.googleapis.com/fcm/send/1'],
      });
      expect(JSON.stringify(res.body)).not.toContain('fcm/send/2');
    } finally {
      on.mockRestore();
      key.mockRestore();
    }
  });
});
