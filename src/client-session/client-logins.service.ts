import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Locale } from '../account/locale.js';
import { hashRandomToken, newRandomToken } from '../common/random-token.js';
import type { Env } from '../config/env.js';
import { ChannelRegistry } from '../notifications/channels/channel-registry.js';
import { channelOff } from '../notifications/link-tokens.service.js';
import type { TelegramLinkDto } from '../notifications/link.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LOGIN_TTL_MS } from './client-cookies.js';
import { ClientSessionsService } from './client-sessions.service.js';

// A client's sign-in through Telegram (E7b): the page opens the bot with a nonce (`url`), the bot
// learns the phone, the browser then takes a session. Two secrets, both stored as hashes: the nonce
// goes to the bot, the browser secret stays in this browser's cookie.
@Injectable()
export class ClientLoginsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: ChannelRegistry,
    private readonly config: ConfigService<Env, true>,
    private readonly sessions: ClientSessionsService,
  ) {}

  // `previousBrowser`: the cookie of an earlier try, whose login this one replaces.
  async start(
    locale: Locale,
    previousBrowser: string | undefined,
  ): Promise<{ link: TelegramLinkDto; browserSecret: string }> {
    const username = this.config.get('TELEGRAM_BOT_USERNAME', { infer: true });
    if (!this.channels.isOn('TELEGRAM') || username === undefined) throw channelOff();
    const nonce = newRandomToken();
    const browserSecret = newRandomToken();
    await this.prisma.$transaction([
      ...(previousBrowser === undefined
        ? []
        : [this.prisma.clientLogin.deleteMany({ where: { browserHash: hashRandomToken(previousBrowser) } })]),
      this.prisma.clientLogin.create({
        data: {
          nonceHash: hashRandomToken(nonce),
          browserHash: hashRandomToken(browserSecret),
          locale,
          expiresAt: new Date(Date.now() + LOGIN_TTL_MS),
        },
      }),
    ]);
    return { link: { url: `https://t.me/${username}?start=${nonce}` }, browserSecret };
  }

  // The browser asks: confirmed → the login is used up and a session token comes back. The delete
  // decides who wins when two polls arrive together; the loser sees `expired`.
  async take(browserSecret: string | undefined): Promise<{ status: 'pending' | 'expired' } | { sessionToken: string }> {
    if (browserSecret === undefined) return { status: 'expired' };
    const browserHash = hashRandomToken(browserSecret);
    return this.prisma.$transaction(async (tx) => {
      const [taken] = await tx.$queryRaw<{ phone: string; chat_id: string }[]>`
        DELETE FROM client_logins
        WHERE browser_hash = ${browserHash} AND confirmed_at IS NOT NULL AND expires_at > now()
        RETURNING phone, chat_id`;
      if (taken) {
        return { sessionToken: await this.sessions.create(tx, { phone: taken.phone, chatId: taken.chat_id }) };
      }
      const waiting = await tx.clientLogin.count({ where: { browserHash, expiresAt: { gt: new Date() } } });
      return { status: waiting > 0 ? 'pending' : 'expired' };
    });
  }
}
