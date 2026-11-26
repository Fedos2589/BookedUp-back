import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { MockInstance } from 'vitest';
import type { App } from 'supertest/types.js';

import { hashRandomToken } from '../src/common/random-token.js';
import { ChannelRegistry } from '../src/notifications/channels/channel-registry.js';
import { TelegramClient } from '../src/notifications/channels/telegram.client.js';
import { TelegramUpdatesService } from '../src/notifications/telegram-updates.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { sessionCookie, sessionSetCookie } from './helpers.js';
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

const start = (cookie?: string, locale = 'ru') => {
  const req = request(app.getHttpServer()).post('/public/client-login').send({ locale });
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
    // The page gets the same four digits the row keeps (the bot shows them too).
    expect(res.body.code).toMatch(/^\d{4}$/);
    expect(row.code).toBe(res.body.code);
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60 * 1000);
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000);
  });

  it('a second try from the same browser replaces the first login', async () => {
    const first = await start().expect(201);
    const firstCookie = /^(__Host-cl=[^;]+)/.exec(sessionSetCookie(first, '__Host-cl')!)![1]!;
    const before = await prisma.clientLogin.count();

    const second = await start(firstCookie).expect(201);

    expect(await prisma.clientLogin.count()).toBe(before);
    const nonce = (second.body.url as string).split('start=')[1]!;
    const row = await prisma.clientLogin.findUniqueOrThrow({ where: { nonceHash: hashRandomToken(nonce) } });
    expect(row.code).toBe(second.body.code);
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
  const newLogin = async (locale = 'ru') => {
    const res = await start(undefined, locale).expect(201);
    const nonce = (res.body.url as string).split('start=')[1]!;
    return {
      nonce,
      code: res.body.code as string,
      row: () => prisma.clientLogin.findUniqueOrThrow({ where: { nonceHash: hashRandomToken(nonce) } }),
    };
  };
  const digits = () => `995${Math.floor(Math.random() * 900_000_000) + 100_000_000}`;

  it("shows the code in the login's language", async () => {
    const { nonce, code } = await newLogin('en');

    await pressStart(nonce, chatId());

    expect(lastReply().text).toContain(`Code: ${code}`);
    expect(lastReply().text).toContain('localhost');
    expect(lastReply().text).toContain('only if');
  });

  it('gives the phone to the login whose code the bot showed last, not to the newest one', async () => {
    const chat = chatId();
    const own = await newLogin(); // the victim's page
    const foreign = await newLogin(); // a forwarded link, made later
    await pressStart(foreign.nonce, chat); // a stranger's code: ignored
    await pressStart(own.nonce, chat); // the page's code matched

    await share(chat, digits());

    expect((await own.row()).confirmedAt).not.toBeNull();
    expect(await foreign.row()).toMatchObject({ chatId: null, phone: null, confirmedAt: null });
  });

  it('does not unbind other logins when the nonce is no good', async () => {
    const chat = chatId();
    const own = await newLogin();
    await pressStart(own.nonce, chat);

    await pressStart('x'.repeat(43), chat);

    expect((await own.row()).chatId).toBe(String(chat));
  });

  it('Start asks for the phone with a share button, then the own contact confirms it', async () => {
    const { nonce, code, row } = await newLogin();
    const chat = chatId();

    await pressStart(nonce, chat);

    expect(lastReply()).toMatchObject({
      chat_id: chat,
      text: expect.stringContaining('Поделитесь номером телефона'),
      reply_markup: { keyboard: [[{ request_contact: true }]] },
    });
    // The bot repeats the page's code, so a person can compare the two.
    expect(lastReply().text).toContain(`Код: ${code}`);
    expect(lastReply().text).toContain('localhost');
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

  it('a contact from a chat that never started a login gets no answer', async () => {
    await share(chatId(), digits());

    expect(call).not.toHaveBeenCalled();
  });

  it('names the site in the ask for the phone', async () => {
    const { nonce } = await newLogin();

    await pressStart(nonce, chatId());

    expect(lastReply().text).toContain('localhost:5173');
  });

  it('the same nonce pressed in a second chat does not take the login from the first', async () => {
    const { nonce, row } = await newLogin();
    const first = chatId();
    const second = chatId();
    await pressStart(nonce, first);

    await pressStart(nonce, second);

    expect(lastReply()).toMatchObject({ chat_id: second, text: 'This link has expired, open it again' });
    expect((await row()).chatId).toBe(String(first));
    await share(second, digits());
    expect((await row()).confirmedAt).toBeNull();
    await share(first, digits());
    expect((await row()).confirmedAt).not.toBeNull();
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

describe('GET /public/client-login', () => {
  const chat = () => Math.floor(Math.random() * 1_000_000_000) + 1;
  let call: MockInstance<TelegramClient['call']>;
  beforeEach(() => {
    call = vi.spyOn(app.get(TelegramClient), 'call').mockResolvedValue({});
  });
  afterEach(() => call.mockRestore());

  const poll = (cookie?: string) => {
    const req = request(app.getHttpServer()).get('/public/client-login');
    return cookie === undefined ? req : req.set('Cookie', cookie);
  };
  const confirmed = async () => {
    const res = await start().expect(201);
    const nonce = (res.body.url as string).split('start=')[1]!;
    const code = res.body.code as string;
    const id = chat();
    const phone = `+995${Math.floor(Math.random() * 900_000_000) + 100_000_000}`;
    const bot = app.get(TelegramUpdatesService);
    await bot.handleUpdate({ message: { text: `/start ${nonce}`, chat: { id, type: 'private' }, from: { id } } });
    return {
      cookie: sessionCookie(res, '__Host-cl')!,
      code,
      phone,
      id,
      confirm: () =>
        bot.handleUpdate({
          message: {
            contact: { phone_number: phone, user_id: id },
            chat: { id, type: 'private' },
            from: { id },
          },
        }),
    };
  };

  it('is pending until the contact, then gives the session once and only to this browser', async () => {
    const login = await confirmed();
    // The code survives a reload of the page: the poll repeats it while the login waits.
    await poll(login.cookie).expect(200, { status: 'pending', code: login.code });

    await login.confirm();
    // Another browser, or none, gets nothing from the same login.
    await poll(`__Host-cl=${'x'.repeat(43)}`).expect(200, { status: 'expired' });
    await poll().expect(200, { status: 'expired' });
    expect(await prisma.clientSession.count({ where: { phone: login.phone } })).toBe(0);

    const res = await poll(login.cookie).expect(200, { status: 'confirmed' });
    expect(res.headers['cache-control']).toBe('no-store');
    const set = sessionSetCookie(res, '__Host-client')!;
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/Secure/);
    expect(set).toMatch(/SameSite=Lax/);
    const token = /^__Host-client=([^;]+)/.exec(set)![1]!;
    const session = await prisma.clientSession.findUniqueOrThrow({ where: { tokenHash: hashRandomToken(token) } });
    expect(session).toMatchObject({ phone: login.phone, chatId: String(login.id), locale: 'ru' });
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);
    expect(sessionSetCookie(res, '__Host-cl')).toMatch(/Expires=Thu, 01 Jan 1970/);

    await poll(login.cookie).expect(200, { status: 'expired' });
    expect(await prisma.clientSession.count({ where: { phone: login.phone } })).toBe(1);
  });

  it('two polls at once make one session', async () => {
    const login = await confirmed();
    await login.confirm();

    const answers = await Promise.all([poll(login.cookie), poll(login.cookie)]);

    expect(answers.map((a) => a.body.status).sort((a: string, b: string) => a.localeCompare(b))).toEqual([
      'confirmed',
      'expired',
    ]);
    expect(await prisma.clientSession.count({ where: { phone: login.phone } })).toBe(1);
  });

  it('an expired login is expired', async () => {
    const login = await confirmed();
    await login.confirm();
    await prisma.clientLogin.updateMany({ where: { chatId: String(login.id) }, data: { expiresAt: new Date(0) } });

    await poll(login.cookie).expect(200, { status: 'expired' });
    expect(await prisma.clientSession.count({ where: { phone: login.phone } })).toBe(0);
  });
});
