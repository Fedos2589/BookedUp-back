import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PasswordHasher } from '@nestjs/authentication';

import type { Env } from '../config/env.js';
import type { Mailer } from '../mail/mailer.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { PasswordResetService } from './password-reset.service.js';

// A user is known and a link is issued: only what happens to the link afterwards is under test.
const service = (nodeEnv: string, mailerOn: boolean, result = 'sent') => {
  const send = vi.fn().mockResolvedValue(result);
  const prisma = {
    user: { findUnique: vi.fn().mockResolvedValue({ id: 'user-1', locale: 'en' }) },
    $transaction: vi.fn().mockResolvedValue(true),
  } as unknown as PrismaService;
  const mailer = { isOn: () => mailerOn, send } as unknown as Mailer;
  const config = new ConfigService({
    NODE_ENV: nodeEnv,
    APP_URL: 'https://app.example.com',
  }) as unknown as ConfigService<Env, true>;
  return { send, service: new PasswordResetService(prisma, mailer, {} as PasswordHasher, config) };
};

// Everything the service says to any log level, as one string.
const logged = (...spies: { mock: { calls: unknown[][] } }[]) => JSON.stringify(spies.flatMap((s) => s.mock.calls));

describe('PasswordResetService without a mail key', () => {
  afterEach(() => vi.restoreAllMocks());

  it('in production logs a warning and never the link', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service: resets, send } = service('production', false);

    await resets.request('anna@example.com');

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(log).not.toHaveBeenCalled();
    expect(logged(warn, log)).not.toMatch(/reset-password|https:\/\/app\.example\.com/);
    expect(send).not.toHaveBeenCalled();
  });

  it('outside production logs the link, so a developer can reset locally', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { service: resets, send } = service('development', false);

    await resets.request('anna@example.com');

    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    expect(logged(log)).toMatch(/https:\/\/app\.example\.com\/reset-password\/[A-Za-z0-9_-]{43}/);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('PasswordResetService with a mail key', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is quiet when the letter went', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service: resets, send } = service('production', true);

    await resets.request('anna@example.com');

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['unreachable', 'unknown'])('warns, without the link, when the send comes back %s', async (result) => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service: resets } = service('production', true, result);

    await resets.request('anna@example.com');

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(logged(warn)).toContain(result);
    expect(logged(warn)).not.toMatch(/reset-password/);
  });
});
