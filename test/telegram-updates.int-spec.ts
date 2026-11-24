import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { MockInstance } from 'vitest';
import type { App } from 'supertest/types.js';

import { hashRandomToken } from '../src/common/random-token.js';
import { TelegramClient } from '../src/notifications/channels/telegram.client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { onlineBooking, signUpOwner } from './helpers.js';
import { createTestApp } from './test-app.js';

const SECRET = 'webhook-secret-for-tests';

let app: INestApplication<App>;
let prisma: PrismaService;
let call: MockInstance<TelegramClient['call']>;

beforeAll(async () => {
  process.env.TELEGRAM_BOT_TOKEN = '123:test-token';
  process.env.TELEGRAM_BOT_USERNAME = 'bookedup_test_bot';
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
  app = await createTestApp();
  prisma = app.get(PrismaService);
});

beforeEach(() => {
  call = vi.spyOn(app.get(TelegramClient), 'call').mockResolvedValue({});
});

afterEach(() => call.mockRestore());

afterAll(async () => {
  await app.close();
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_USERNAME;
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
});

const http = () => request(app.getHttpServer());
const tokenOf = (res: request.Response) => (res.body.url as string).split('start=')[1] ?? '';

// What Telegram sends when someone presses Start on a t.me link.
let updateId = 0;
const start = (token: string, chatId: number, languageCode?: string) => ({
  update_id: ++updateId,
  message: {
    message_id: 1,
    text: `/start ${token}`,
    chat: { id: chatId, type: 'private' },
    from: { id: chatId, language_code: languageCode },
  },
});

const webhook = (update: unknown, secret: string | null = SECRET) => {
  const req = http().post('/telegram/webhook');
  return (secret === null ? req : req.set('X-Telegram-Bot-Api-Secret-Token', secret)).send(update as object);
};

const replies = () =>
  call.mock.calls.map(([method, body]) => ({ method, ...(body as { chat_id?: number; text?: string }) }));
const chatId = () => Math.floor(Math.random() * 1_000_000_000) + 1;

describe('a Start press with a link token', () => {
  it("an account's token saves the user's chat, replaces an older one, and is used up", async () => {
    const me = await signUpOwner(app);
    const user = await prisma.user.findFirstOrThrow({
      where: { memberships: { some: { businessId: me.business.id } } },
    });
    const [first, second] = [chatId(), chatId()];
    const link = async () => tokenOf(await http().post('/me/telegram-link').set('Cookie', me.cookie).expect(201));

    const token = await link();
    await webhook(start(token, first)).expect(200);
    await webhook(start(await link(), second)).expect(200);

    const channels = await prisma.userChannel.findMany({ where: { userId: user.id, kind: 'TELEGRAM' } });
    expect(channels.map((c) => c.address)).toEqual([String(second)]);
    expect(replies()[0]).toMatchObject({
      method: 'sendMessage',
      chat_id: first,
      text: expect.stringContaining('Connected'),
    });
    expect(await prisma.channelLinkToken.count({ where: { tokenHash: hashRandomToken(token) } })).toBe(0);
  });

  it("a booking's token saves the chat on that booking and writes CHANNEL_ON with the manage link, in the booking's business", async () => {
    const b = await onlineBooking(app);
    const chat = chatId();
    const link = await http().post(`/public/bookings/${b.token}/telegram-link`).send({ locale: 'ru' }).expect(201);

    await webhook(start(tokenOf(link), chat)).expect(200);

    const channel = await prisma.clientChannel.findFirstOrThrow({ where: { appointmentId: b.appointmentId } });
    expect(channel).toMatchObject({
      businessId: b.business.id,
      clientId: b.clientId,
      kind: 'TELEGRAM',
      address: String(chat),
      locale: 'ru',
      disabledAt: null,
    });
    const event = await prisma.notificationEvent.findFirstOrThrow({ where: { channelId: channel.id } });
    expect(event).toMatchObject({
      businessId: b.business.id,
      appointmentId: b.appointmentId,
      kind: 'CHANNEL_ON',
      actorUserId: null,
      processedAt: null,
      payload: { manageLink: `http://localhost:5173/book/${b.business.slug}/manage/${b.token}` },
    });
    // The CHANNEL_ON message itself is the confirmation: no extra reply.
    expect(call).not.toHaveBeenCalled();
  });

  it("takes the chat's language when it is one we have texts for", async () => {
    const b = await onlineBooking(app);
    const link = await http().post(`/public/bookings/${b.token}/telegram-link`).send({ locale: 'en' }).expect(201);

    await webhook(start(tokenOf(link), chatId(), 'ru')).expect(200);

    expect((await prisma.clientChannel.findFirstOrThrow({ where: { appointmentId: b.appointmentId } })).locale).toBe(
      'ru',
    );
  });

  it('the same chat opening a second link for one booking is one channel, one event', async () => {
    const b = await onlineBooking(app);
    const chat = chatId();
    for (const _ of [1, 2]) {
      const link = await http().post(`/public/bookings/${b.token}/telegram-link`).send({ locale: 'en' }).expect(201);
      await webhook(start(tokenOf(link), chat)).expect(200);
    }

    expect(await prisma.clientChannel.count({ where: { appointmentId: b.appointmentId } })).toBe(1);
    expect(
      await prisma.notificationEvent.count({ where: { appointmentId: b.appointmentId, kind: 'CHANNEL_ON' } }),
    ).toBe(1);
  });

  it('a used token gets «expired» and changes nothing', async () => {
    const b = await onlineBooking(app);
    const link = await http().post(`/public/bookings/${b.token}/telegram-link`).send({ locale: 'en' }).expect(201);
    const token = tokenOf(link);
    await webhook(start(token, chatId())).expect(200);
    call.mockClear();

    const again = chatId();
    await webhook(start(token, again)).expect(200);

    expect(replies()).toEqual([{ method: 'sendMessage', chat_id: again, text: expect.stringContaining('expired') }]);
    expect(await prisma.clientChannel.count({ where: { appointmentId: b.appointmentId } })).toBe(1);
  });

  it('an expired token is not used', async () => {
    const me = await signUpOwner(app);
    const user = await prisma.user.findFirstOrThrow({
      where: { memberships: { some: { businessId: me.business.id } } },
    });
    const token = tokenOf(await http().post('/me/telegram-link').set('Cookie', me.cookie).expect(201));
    await prisma.channelLinkToken.update({
      where: { tokenHash: hashRandomToken(token) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await webhook(start(token, chatId(), 'ru')).expect(200);

    expect(await prisma.userChannel.count({ where: { userId: user.id } })).toBe(0);
    expect(replies()).toEqual([
      { method: 'sendMessage', chat_id: expect.any(Number), text: expect.stringContaining('истекла') },
    ]);
  });

  it('an unknown token gets «expired»', async () => {
    await webhook(start('x'.repeat(43), chatId())).expect(200);
    expect(replies()).toHaveLength(1);
    expect(replies()[0]?.text).toContain('expired');
  });
});

describe('POST /telegram/webhook', () => {
  it('is 401 without the secret or with another one, and handles nothing then', async () => {
    const me = await signUpOwner(app);
    const token = tokenOf(await http().post('/me/telegram-link').set('Cookie', me.cookie).expect(201));

    await webhook(start(token, chatId()), null).expect(401);
    await webhook(start(token, chatId()), 'wrong').expect(401);

    expect(call).not.toHaveBeenCalled();
    expect(await prisma.channelLinkToken.count({ where: { tokenHash: hashRandomToken(token) } })).toBe(1);
  });

  it('is 200 for what is not a Start with a token, and for a reply that fails', async () => {
    await webhook({ update_id: 1, message: { text: 'hello', chat: { id: 1 } } }).expect(200);
    await webhook({ update_id: 2, edited_message: { text: '/start abc', chat: { id: 1 } } }).expect(200);
    await webhook({}).expect(200);
    expect(call).not.toHaveBeenCalled();

    call.mockRejectedValue(new Error('Telegram: Forbidden (403)'));
    await webhook(start('x'.repeat(43), chatId())).expect(200);
  });
});
