import { Injectable, Logger } from '@nestjs/common';

import { messageFor } from '../messages.js';
import type { Channel, RenderInput, SendResult } from './channel.js';

const VISIBLE = 4;

// An address is a phone, an email or a chat id: only its end goes to the log.
const masked = (address: string) => `…${address.slice(-VISIBLE)}`;

// A link in a text can be a manage link: whoever has it manages the booking, and logs are read by many.
const withoutLinks = (text: string) => text.replace(/https?:\/\/\S+/g, '[link]');

// The development and test channel: the message goes to the log, nowhere else.
@Injectable()
export class LogChannel implements Channel {
  readonly kind = 'LOG';
  private readonly logger = new Logger(LogChannel.name);

  async send(address: string, input: RenderInput): Promise<SendResult> {
    const message = messageFor(input);
    this.logger.log({
      channel: this.kind,
      to: masked(address),
      subject: message.subject,
      text: withoutLinks(message.text),
    });
    return 'sent';
  }
}
