import type { ChannelKind } from '../../generated/prisma/client.js';
import type { SendResult } from '../../mail/send-result.js';
import type { MessageInput } from '../messages.js';

export type { SendResult } from '../../mail/send-result.js';

// What a channel renders its message from. `url`: where a tap on a push goes (the business's booking page for a
// client, the cabinet's calendar for staff).
export type RenderInput = MessageInput & { url: string };

export interface Channel {
  readonly kind: ChannelKind;
  // `keys`: what the address needs besides itself (a push subscription's `p256dh` and `auth`).
  // The channel renders `input` itself: a text channel with `messageFor`, a template one with its own.
  send(address: string, input: RenderInput, keys?: unknown): Promise<SendResult>;
}
