import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../config/env.js';
import type { ChannelKind } from '../../generated/prisma/client.js';
import type { AvailableChannels, AvailableStaffChannels } from '../channels.schema.js';
import type { Channel } from './channel.js';
import { EmailChannel } from './email.channel.js';
import { LogChannel } from './log.channel.js';
import { PushChannel } from './push.channel.js';
import { TelegramChannel } from './telegram.channel.js';
import { WhatsappChannel } from './whatsapp.channel.js';

// Which class sends a kind. The only place that knows the list. A kind is on when it is configured.
@Injectable()
export class ChannelRegistry {
  private readonly channels: Map<ChannelKind, Channel>;

  // A kind that is not on goes to the log, except in production, where it is skipped (E9, decision 8).
  readonly fallbackToLog: boolean;

  private readonly vapidPublicKey: string | undefined;

  constructor(
    config: ConfigService<Env, true>,
    log: LogChannel,
    telegram: TelegramChannel,
    push: PushChannel,
    whatsapp: WhatsappChannel,
    email: EmailChannel,
  ) {
    this.vapidPublicKey = config.get('VAPID_PUBLIC_KEY', { infer: true });
    this.channels = new Map<ChannelKind, Channel>([[log.kind, log]]);
    if (config.get('TELEGRAM_BOT_TOKEN', { infer: true }) !== undefined) this.channels.set(telegram.kind, telegram);
    if (this.vapidPublicKey !== undefined) this.channels.set(push.kind, push);
    if (config.get('WHATSAPP_TOKEN', { infer: true }) !== undefined) this.channels.set(whatsapp.kind, whatsapp);
    if (config.get('RESEND_API_KEY', { infer: true }) !== undefined) this.channels.set(email.kind, email);
    this.fallbackToLog = config.get('NODE_ENV', { infer: true }) !== 'production';
    // Told once, at start: email is the one channel a business is likely to forget, and without it nothing falls back to the log.
    if (!this.fallbackToLog && !this.channels.has(email.kind))
      new Logger(ChannelRegistry.name).warn('RESEND_API_KEY is not set: email is off');
  }

  // The kinds this process can send: it claims only their deliveries, and leaves the rest to one that can.
  kinds(): ChannelKind[] {
    return [...this.channels.keys()];
  }

  isOn(kind: ChannelKind): boolean {
    return this.channels.has(kind);
  }

  // What the front offers: a channel that is not on here is not shown.
  available(): AvailableChannels {
    return {
      telegram: this.isOn('TELEGRAM'),
      whatsapp: this.isOn('WHATSAPP'),
      push: this.isOn('PUSH'),
      email: this.isOn('EMAIL'),
    };
  }

  // The same for a member: WhatsApp sends client templates only, so it is not offered to them.
  availableToStaff(): AvailableStaffChannels {
    const { whatsapp: _, ...staff } = this.available();
    return staff;
  }

  // The public half of the VAPID pair, which a browser subscribes with; null when push is off.
  pushKey(): string | null {
    return this.vapidPublicKey ?? null;
  }

  get(kind: ChannelKind): Channel {
    const channel = this.channels.get(kind);
    if (channel === undefined) throw new Error(`No channel for ${kind}`);
    return channel;
  }
}
