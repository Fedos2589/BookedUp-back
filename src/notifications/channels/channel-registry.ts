import { Injectable } from '@nestjs/common';

import type { ChannelKind } from '../../generated/prisma/client.js';
import type { Channel } from './channel.js';
import { LogChannel } from './log.channel.js';

// Which class sends a kind. The only place that knows the list.
@Injectable()
export class ChannelRegistry {
  private readonly channels: Map<ChannelKind, Channel>;

  constructor(log: LogChannel) {
    this.channels = new Map([[log.kind, log]]);
  }

  // Until the real channels exist (step M) every message goes to the log.
  readonly fallbackToLog = true;

  get(kind: ChannelKind): Channel {
    const channel = this.channels.get(kind);
    if (channel === undefined) throw new Error(`No channel for ${kind}`);
    return channel;
  }
}
