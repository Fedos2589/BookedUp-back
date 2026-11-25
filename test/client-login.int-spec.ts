import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { hashRandomToken } from '../src/common/random-token.js';
import { ChannelRegistry } from '../src/notifications/channels/channel-registry.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { sessionSetCookie } from './helpers.js';
import { createTestApp } from './test-app.js';

let app: INestApplication<App>;
let prisma: PrismaService;

beforeAll(async () => {
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

const start = (cookie?: string) => {
  const req = request(app.getHttpServer()).post('/public/client-login').send({ locale: 'ru' });
  return cookie === undefined ? req : req.set('Cookie', cookie);
};

describe('POST /public/client-login', () => {
  it('gives the bot link and binds the login to this browser', async () => {
    const res = await start().expect(201);

    const nonce = /^https:\/\/t\.me\/bookedup_test_bot\?start=([A-Za-z0-9_-]{43})$/.exec(res.body.url)?.[1];
    expect(nonce).toBeDefined();
    const cookie = sessionSetCookie(res, '__Host-cl')!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\//);
    const secret = /^__Host-cl=([^;]+)/.exec(cookie)![1]!;

    // Only hashes are stored.
    const row = await prisma.clientLogin.findUniqueOrThrow({ where: { nonceHash: hashRandomToken(nonce!) } });
    expect(row.browserHash).toBe(hashRandomToken(secret));
    expect(row.nonceHash).not.toBe(nonce);
    expect(row.browserHash).not.toBe(secret);
    expect(row).toMatchObject({ locale: 'ru', chatId: null, phone: null, confirmedAt: null });
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60 * 1000);
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000);
  });

  it('a second try from the same browser replaces the first login', async () => {
    const first = await start().expect(201);
    const firstCookie = /^(__Host-cl=[^;]+)/.exec(sessionSetCookie(first, '__Host-cl')!)![1]!;
    const before = await prisma.clientLogin.count();

    await start(firstCookie).expect(201);

    expect(await prisma.clientLogin.count()).toBe(before);
  });

  it('is 404 channelOff when Telegram is not turned on here', async () => {
    const chat = app.get(ChannelRegistry);
    const spy = vi.spyOn(chat, 'isOn').mockReturnValue(false);
    try {
      const res = await start().expect(404);
      expect(res.body.code).toBe('channelOff');
    } finally {
      spy.mockRestore();
    }
  });
});
