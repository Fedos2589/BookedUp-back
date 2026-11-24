import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { ChannelRegistry } from '../src/notifications/channels/channel-registry.js';
import { hashRandomToken, newRandomToken } from '../src/common/random-token.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createClient, signUpOwner } from './helpers.js';
import { createTestApp } from './test-app.js';

let app: INestApplication<App>;
let prisma: PrismaService;

beforeAll(async () => {
  // Read when the app is built: the bot is on for every test here.
  process.env.TELEGRAM_BOT_TOKEN = '123:test-token';
  process.env.TELEGRAM_BOT_USERNAME = 'bookedup_test_bot';
  app = await createTestApp();
  prisma = app.get(PrismaService);
});

afterAll(async () => {
  await app.close();
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_USERNAME;
});

const http = () => request(app.getHttpServer());
const TOKEN_IN_URL = /^https:\/\/t\.me\/bookedup_test_bot\?start=([\w-]{43})$/;

// A business with one master and one online booking; returns the booking's manage token.
const booking = async (status: 'BOOKED' | 'CANCELLED' = 'BOOKED', startsAt = new Date(Date.now() + 86_400_000)) => {
  const owner = await signUpOwner(app);
  const businessId = owner.business.id;
  const staff = await http()
    .post(`/businesses/${businessId}/staff`)
    .set('Cookie', owner.cookie)
    .send({ name: 'Hana' })
    .expect(201);
  const token = newRandomToken();
  const created = await prisma.appointment.create({
    data: {
      businessId,
      clientId: await createClient(prisma, businessId),
      staffId: staff.body.id as string,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3600_000),
      clientName: 'Vera',
      clientPhone: '+79991234567',
      status,
      manageTokenHash: hashRandomToken(token),
    },
  });
  return { token, business: owner.business, appointmentId: created.id };
};

describe('POST /me/telegram-link', () => {
  it('gives a t.me link; only the hash of its token is stored, for this user', async () => {
    const me = await signUpOwner(app);
    const user = await prisma.user.findFirstOrThrow({
      where: { memberships: { some: { businessId: me.business.id } } },
    });

    const res = await http().post('/me/telegram-link').set('Cookie', me.cookie).expect(201);

    const token = TOKEN_IN_URL.exec(res.body.url)?.[1] ?? '';
    expect(token).toHaveLength(43);
    const stored = await prisma.channelLinkToken.findUniqueOrThrow({ where: { tokenHash: hashRandomToken(token) } });
    expect(stored).toMatchObject({ userId: user.id, appointmentId: null, businessId: null, manageLink: null });
    expect(JSON.stringify(stored)).not.toContain(token);
    const lifetime = stored.expiresAt.getTime() - Date.now();
    expect(lifetime).toBeGreaterThan(59 * 60_000);
    expect(lifetime).toBeLessThanOrEqual(60 * 60_000);
  });

  it('wants a session', async () => {
    await http().post('/me/telegram-link').expect(401);
  });

  it('is 404 channelOff when Telegram is not on', async () => {
    const me = await signUpOwner(app);
    const off = vi.spyOn(app.get(ChannelRegistry), 'isOn').mockReturnValue(false);
    try {
      const res = await http().post('/me/telegram-link').set('Cookie', me.cookie).expect(404);
      expect(res.body.code).toBe('channelOff');
    } finally {
      off.mockRestore();
    }
  });
});

describe('POST /public/bookings/:token/telegram-link', () => {
  const link = (token: string) => http().post(`/public/bookings/${token}/telegram-link`);

  it("stores the token with this booking's business and appointment, and its own manage link", async () => {
    const b = await booking();

    const res = await link(b.token).send({ locale: 'ru' }).expect(201);

    const token = TOKEN_IN_URL.exec(res.body.url)?.[1] ?? '';
    const stored = await prisma.channelLinkToken.findUniqueOrThrow({ where: { tokenHash: hashRandomToken(token) } });
    expect(stored).toMatchObject({
      businessId: b.business.id,
      appointmentId: b.appointmentId,
      userId: null,
      locale: 'ru',
      manageLink: `http://localhost:5173/book/${b.business.slug}/manage/${b.token}`,
    });
    expect(stored.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60 * 60_000);
  });

  it('is 409 badTransition once the booking is cancelled or has started', async () => {
    const cancelled = await booking('CANCELLED');
    const started = await booking('BOOKED', new Date(Date.now() - 3600_000));
    for (const b of [cancelled, started]) {
      const res = await link(b.token).send({ locale: 'en' }).expect(409);
      expect(res.body.code).toBe('badTransition');
    }
    expect(await prisma.channelLinkToken.count({ where: { appointmentId: cancelled.appointmentId } })).toBe(0);
  });

  it('is 404 for an unknown token, 400 for a malformed one or a locale we have no texts for', async () => {
    const b = await booking();
    await link(newRandomToken()).send({ locale: 'en' }).expect(404);
    await link('short').send({ locale: 'en' }).expect(400);
    await link(b.token).send({ locale: 'de' }).expect(400);
    await link(b.token).send({}).expect(400);
  });

  it('is 404 channelOff when Telegram is not on', async () => {
    const b = await booking();
    const off = vi.spyOn(app.get(ChannelRegistry), 'isOn').mockReturnValue(false);
    try {
      const res = await link(b.token).send({ locale: 'en' }).expect(404);
      expect(res.body.code).toBe('channelOff');
    } finally {
      off.mockRestore();
    }
  });
});

describe('channel_link_tokens in the database', () => {
  it('refuses a token that belongs to both an account and a booking, or to neither', async () => {
    const b = await booking();
    const user = await prisma.user.findFirstOrThrow({
      where: { memberships: { some: { businessId: b.business.id } } },
    });
    const base = { tokenHash: hashRandomToken(newRandomToken()), locale: 'en', expiresAt: new Date(Date.now() + 1000) };

    await expect(
      prisma.channelLinkToken.create({
        data: { ...base, userId: user.id, businessId: b.business.id, appointmentId: b.appointmentId },
      }),
    ).rejects.toThrow();
    await expect(prisma.channelLinkToken.create({ data: base })).rejects.toThrow();
  });
});
