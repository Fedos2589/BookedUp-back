import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../config/env.js';
import type { ChannelKind } from '../../generated/prisma/client.js';
import type { Channel } from './channel.js';
import { LogChannel } from './log.channel.js';
import { PushChannel } from './push.channel.js';
import { TelegramChannel } from './telegram.channel.js';

// Which class sends a kind. The only place that knows the list. A kind is on when it is configured.
@Injectable()
export class ChannelRegistry {
  private readonly channels: Map<ChannelKind, Channel>;

  // A kind that is not on goes to the log, except in production, where it is skipped (E9, decision 8).
  readonly fallbackToLog: boolean;

  constructor(config: ConfigService<Env, true>, log: LogChannel, telegram: TelegramChannel, push: PushChannel) {
    this.channels = new Map<ChannelKind, Channel>([[log.kind, log]]);
    if (config.get('TELEGRAM_BOT_TOKEN', { infer: true }) !== undefined) this.channels.set(telegram.kind, telegram);
    if (config.get('VAPID_PUBLIC_KEY', { infer: true }) !== undefined) this.channels.set(push.kind, push);
    this.fallbackToLog = config.get('NODE_ENV', { infer: true }) !== 'production';
  }

  isOn(kind: ChannelKind): boolean {
    return this.channels.has(kind);
  }

  get(kind: ChannelKind): Channel {
    const channel = this.channels.get(kind);
    if (channel === undefined) throw new Error(`No channel for ${kind}`);
    return channel;
  }
}
