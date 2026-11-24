import { Injectable } from '@nestjs/common';

import { templateFor } from '../messages.js';
import type { Channel, RenderInput, SendResult } from './channel.js';
import { WhatsappClient, WhatsappError } from './whatsapp.client.js';

// «The recipient is not on WhatsApp»: the number will never work.
const NOT_ON_WHATSAPP = 131026;

@Injectable()
export class WhatsappChannel implements Channel {
  readonly kind = 'WHATSAPP';

  constructor(private readonly client: WhatsappClient) {}

  async send(address: string, input: RenderInput): Promise<SendResult> {
    const { name, language, params } = templateFor(input);
    try {
      await this.client.send({
        messaging_product: 'whatsapp',
        to: address,
        type: 'template',
        template: {
          name,
          language: { code: language },
          components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }],
        },
      });
      return 'sent';
    } catch (error) {
      if (error instanceof WhatsappError && error.code === NOT_ON_WHATSAPP) return 'unreachable';
      throw error;
    }
  }
}
