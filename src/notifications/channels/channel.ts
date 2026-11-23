import type { ChannelKind } from '../../generated/prisma/client.js';
import type { Message } from '../messages.js';

// `unreachable`: the address will never work (the chat was left, the push subscription expired), so the
// caller switches it off. A retryable error is thrown instead.
export type SendResult = 'sent' | 'unreachable';

export interface Channel {
  readonly kind: ChannelKind;
  // `keys`: what the address needs besides itself (a push subscription's `p256dh` and `auth`).
  send(address: string, message: Message, keys?: unknown): Promise<SendResult>;
}
