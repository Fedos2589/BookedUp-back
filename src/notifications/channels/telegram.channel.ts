import { Injectable } from '@nestjs/common';

import { messageFor } from '../messages.js';
import type { Channel, RenderInput, SendResult } from './channel.js';
import { TelegramClient, TelegramError } from './telegram.client.js';

// The chat is gone for good: the bot was blocked or kicked out (403), or the id leads nowhere (400).
// Any other 400 is our own mistake, and it must not switch a working chat off.
const isGone = (error: TelegramError) =>
  error.code === 403 || (error.code === 400 && /chat not found/i.test(error.description));

@Injectable()
export class TelegramChannel implements Channel {
  readonly kind = 'TELEGRAM';

  constructor(private readonly client: TelegramClient) {}

  async send(address: string, input: RenderInput): Promise<SendResult> {
    try {
      await this.client.call('sendMessage', { chat_id: address, text: messageFor(input).text });
      return 'sent';
    } catch (error) {
      if (error instanceof TelegramError && isGone(error)) return 'unreachable';
      throw error;
    }
  }
}
