import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { SESSION_TTL_MS } from '../src/client-session/client-sessions.service.js';
import { ClientSessionPurgeService } from '../src/notifications/client-session-purge.service.js';
import { ClientLoginConfirmService } from '../src/notifications/client-login-confirm.service.js';
import { hashRandomToken, newRandomToken } from '../src/common/random-token.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { signUpOwner } from './helpers.js';
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

const phone = () => `+7${randomUUID().replace(/\D/g, '').padEnd(10, '1').slice(0, 10)}`;

// A confirmed client's session, written straight to the table: the cookie a browser would hold.
const sessionFor = async (clientPhone: string, expiresAt = new Date(Date.now() + SESSION_TTL_MS)) => {
  const token = newRandomToken();
  await prisma.clientSession.create({
    data: { tokenHash: hashRandomToken(token), phone: clientPhone, chatId: '555', locale: 'en', expiresAt },
  });
  return { token, cookie: `__Host-client=${token}` };
};

const read = (cookie?: string) => {
  const req = request(app.getHttpServer()).get('/public/client-session');
  return cookie === undefined ? req : req.set('Cookie', cookie);
};

describe('GET /public/client-session', () => {
  it('gives the phone of the live session and slides its expiry', async () => {
    const clientPhone = phone();
    const { token, cookie } = await sessionFor(clientPhone, new Date(Date.now() + 60_000));

    const res = await read(cookie).expect(200);

    expect(res.body).toEqual({ phone: clientPhone });
    expect(res.headers['cache-control']).toBe('no-store');
    const row = await prisma.clientSession.findUniqueOrThrow({ where: { tokenHash: hashRandomToken(token) } });
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + SESSION_TTL_MS - 60_000);
  });

  it('is null without a cookie, with an unknown token and with an expired session', async () => {
    const expired = await sessionFor(phone(), new Date(Date.now() - 1000));

    await read().expect(200).expect({ phone: null });
    await read(`__Host-client=${newRandomToken()}`).expect(200).expect({ phone: null });
    await read(expired.cookie).expect(200).expect({ phone: null });
  });

  it("is null for the cabinet's session alone", async () => {
    const owner = await signUpOwner(app);

    await read(owner.cookie).expect(200).expect({ phone: null });
  });
});

describe('DELETE /public/client-session', () => {
  it('ends the session and clears the cookie; a second call is the same', async () => {
    const { token, cookie } = await sessionFor(phone());

    const res = await request(app.getHttpServer()).delete('/public/client-session').set('Cookie', cookie).expect(204);
    expect(([] as string[]).concat(res.headers['set-cookie'] ?? []).join(';')).toMatch(/__Host-client=;/);
    expect(await prisma.clientSession.count({ where: { tokenHash: hashRandomToken(token) } })).toBe(0);
    await read(cookie).expect(200).expect({ phone: null });

    await request(app.getHttpServer()).delete('/public/client-session').set('Cookie', cookie).expect(204);
    await request(app.getHttpServer()).delete('/public/client-session').expect(204);
  });

  it("does not end another client's session", async () => {
    const other = await sessionFor(phone());
    const mine = await sessionFor(phone());

    await request(app.getHttpServer()).delete('/public/client-session').set('Cookie', mine.cookie).expect(204);

    expect(await prisma.clientSession.count({ where: { tokenHash: hashRandomToken(other.token) } })).toBe(1);
  });
});

describe('ClientSessionPurgeService.purgeExpired', () => {
  const login = (hash: string, expiresAt: Date, chatId?: string) =>
    prisma.clientLogin.create({
      data: { nonceHash: `n-${hash}`, browserHash: `b-${hash}`, locale: 'en', expiresAt, chatId },
    });

  it('deletes expired sessions and long-dead logins, keeps live sessions and logins', async () => {
    const stale = await sessionFor(phone(), new Date(Date.now() - 1000));
    const live = await sessionFor(phone());
    const id = randomUUID();
    await login(`dead-${id}`, new Date(Date.now() - 2 * 24 * 3600_000));
    await login(`live-${id}`, new Date(Date.now() + 60_000));

    await app.get(ClientSessionPurgeService).purgeExpired(new Date());

    const sessions = await prisma.clientSession.findMany({
      where: { tokenHash: { in: [stale.token, live.token].map(hashRandomToken) } },
    });
    expect(sessions.map((s) => s.tokenHash)).toEqual([hashRandomToken(live.token)]);
    const logins = await prisma.clientLogin.findMany({ where: { nonceHash: { endsWith: id } } });
    expect(logins.map((l) => l.nonceHash)).toEqual([`n-live-${id}`]);
  });

  // The bot answers a contact from a chat whose sign-in is out of time («expired») only while it still knows
  // that chat: the row of an expired login must outlive its ten minutes.
  it('still lets the bot recognise a chat whose login has just expired', async () => {
    const chatId = `chat-${randomUUID()}`;
    await login(`recent-${randomUUID()}`, new Date(Date.now() - 15 * 60_000), chatId);

    await app.get(ClientSessionPurgeService).purgeExpired(new Date());

    expect(await app.get(ClientLoginConfirmService).hasLogin(chatId)).toBe(true);
  });
});
