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

// A client's sign-in through Telegram (E7b): the page opens the bot with a nonce (`url`), the bot
// learns the phone, the browser then takes a session. Two secrets, both stored as hashes: the nonce
// goes to the bot, the browser secret stays in this browser's cookie.
@Injectable()
export class ClientLoginsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: ChannelRegistry,
    private readonly config: ConfigService<Env, true>,
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
}
