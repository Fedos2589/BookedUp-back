import { Injectable } from '@nestjs/common';

import { Mailer } from '../../mail/mailer.js';
import { messageFor } from '../messages.js';
import type { Channel, RenderInput, SendResult } from './channel.js';

// Renders the message; the mail itself goes through the Mailer.
@Injectable()
export class EmailChannel implements Channel {
  readonly kind = 'EMAIL';

  constructor(private readonly mailer: Mailer) {}

  send(address: string, input: RenderInput): Promise<SendResult> {
    const { subject, text } = messageFor(input);
    return this.mailer.send({ to: address, subject, text });
  }
}
