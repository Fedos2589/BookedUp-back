import { Injectable, Logger } from '@nestjs/common';

import type { Message } from '../messages.js';
import type { Channel, SendResult } from './channel.js';

const VISIBLE = 4;

// An address is a phone, an email or a chat id: only its end goes to the log.
const masked = (address: string) => `…${address.slice(-VISIBLE)}`;

// The development and test channel: the message goes to the log, nowhere else.
@Injectable()
export class LogChannel implements Channel {
  readonly kind = 'LOG';
  private readonly logger = new Logger(LogChannel.name);

  async send(address: string, message: Message): Promise<SendResult> {
    this.logger.log({ channel: this.kind, to: masked(address), subject: message.subject, text: message.text });
    return 'sent';
  }
}
