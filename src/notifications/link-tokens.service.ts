import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Locale } from '../account/locale.js';
import { hashRandomToken, newRandomToken } from '../common/random-token.js';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ChannelRegistry } from './channels/channel-registry.js';
import type { TelegramLinkDto } from './link.schema.js';

const LINK_TTL_MS = 60 * 60 * 1000;

// Whose chat the link will connect: an account's, or an online booking's (with its own manage link,
// which the CHANNEL_ON message repeats).
export type LinkOwner = { userId: string } | { businessId: string; appointmentId: string; manageLink: string };

export const channelOff = () =>
  new NotFoundException({
    statusCode: 404,
    error: 'Not Found',
    message: 'This channel is not turned on here',
    code: 'channelOff',
  });

// One-time links that connect a Telegram chat: the person opens `t.me/<bot>?start=<token>`, and the
// bot gets the token (M3). Only the token's hash is stored.
@Injectable()
export class LinkTokensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: ChannelRegistry,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async forUser(userId: string): Promise<TelegramLinkDto> {
    const { locale } = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { locale: true } });
    return this.issue({ userId }, locale as Locale);
  }

  async issue(owner: LinkOwner, locale: Locale): Promise<TelegramLinkDto> {
    const username = this.config.get('TELEGRAM_BOT_USERNAME', { infer: true });
    if (!this.channels.isOn('TELEGRAM') || username === undefined) throw channelOff();
    const token = newRandomToken();
    await this.prisma.channelLinkToken.create({
      data: { ...owner, tokenHash: hashRandomToken(token), locale, expiresAt: new Date(Date.now() + LINK_TTL_MS) },
    });
    return { url: `https://t.me/${username}?start=${token}` };
  }
}
