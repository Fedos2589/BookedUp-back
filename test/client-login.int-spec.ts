import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { MockInstance } from 'vitest';
import type { App } from 'supertest/types.js';

import { hashRandomToken } from '../src/common/random-token.js';
import { ChannelRegistry } from '../src/notifications/channels/channel-registry.js';
import { TelegramClient } from '../src/notifications/channels/telegram.client.js';
import { TelegramUpdatesService } from '../src/notifications/telegram-updates.service.js';
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

describe('the bot confirms the phone', () => {
  let call: MockInstance<TelegramClient['call']>;
  beforeEach(() => {
    call = vi.spyOn(app.get(TelegramClient), 'call').mockResolvedValue({});
  });
  afterEach(() => call.mockRestore());

  const chatId = () => Math.floor(Math.random() * 1_000_000_000) + 1;
  const feed = (update: object) => app.get(TelegramUpdatesService).handleUpdate(update);
  const pressStart = (nonce: string, chat: number) =>
    feed({ message: { text: `/start ${nonce}`, chat: { id: chat, type: 'private' }, from: { id: chat } } });
  const share = (chat: number, phone: string, userId: number | null = chat) =>
    feed({
      message: {
        contact: { phone_number: phone, ...(userId !== null && { user_id: userId }) },
        chat: { id: chat, type: 'private' },
        from: { id: chat },
      },
    });
  const lastReply = () => call.mock.calls.at(-1)![1] as { chat_id: number; text: string; reply_markup?: object };
  const newLogin = async () => {
    const res = await start().expect(201);
    const nonce = (res.body.url as string).split('start=')[1]!;
    return { nonce, row: () => prisma.clientLogin.findUniqueOrThrow({ where: { nonceHash: hashRandomToken(nonce) } }) };
  };
  const digits = () => `995${Math.floor(Math.random() * 900_000_000) + 100_000_000}`;

  it('Start asks for the phone with a share button, then the own contact confirms it', async () => {
    const { nonce, row } = await newLogin();
    const chat = chatId();

    await pressStart(nonce, chat);

    expect(lastReply()).toMatchObject({
      chat_id: chat,
      text: 'Поделитесь номером телефона, чтобы подтвердить его',
      reply_markup: { keyboard: [[{ request_contact: true }]] },
    });
    expect(await row()).toMatchObject({ chatId: String(chat), phone: null, confirmedAt: null });

    const phone = digits();
    await share(chat, phone);

    expect(await row()).toMatchObject({ chatId: String(chat), phone: `+${phone}` });
    expect((await row()).confirmedAt).not.toBeNull();
    expect(lastReply()).toMatchObject({ text: 'Телефон подтверждён, вернитесь на страницу' });
    expect(lastReply().reply_markup).toEqual({ remove_keyboard: true });
  });

  it("another person's contact confirms nothing", async () => {
    const { nonce, row } = await newLogin();
    const chat = chatId();
    await pressStart(nonce, chat);

    await share(chat, digits(), chat + 1);
    expect((await row()).confirmedAt).toBeNull();
    expect(lastReply().text).toBe('Use the button to share your own phone');

    await share(chat, digits(), null);
    expect((await row()).confirmedAt).toBeNull();
  });

  it('a contact from a chat that never started a login says the link expired', async () => {
    await share(chatId(), digits());

    expect(lastReply().text).toBe('This link has expired, open it again');
  });

  it('an expired login cannot be started or confirmed', async () => {
    const { nonce, row } = await newLogin();
    const chat = chatId();
    await pressStart(nonce, chat);
    await prisma.clientLogin.update({ where: { id: (await row()).id }, data: { expiresAt: new Date(Date.now() - 1) } });

    await share(chat, digits());
    expect((await row()).confirmedAt).toBeNull();
    expect(lastReply().text).toBe('This link has expired, open it again');

    await pressStart(nonce, chatId());
    expect(lastReply().text).toBe('This link has expired, open it again');
  });
});
