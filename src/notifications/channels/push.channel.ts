import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sendNotification, setVapidDetails, WebPushError } from 'web-push';
import { z } from 'zod';

import type { Env } from '../../config/env.js';
import type { Message } from '../messages.js';
import type { Channel, SendResult } from './channel.js';

const TTL_SECONDS = 24 * 60 * 60;

const pushKeys = z.object({ p256dh: z.string(), auth: z.string() });

// The subscription is gone for good: the browser dropped it (404) or the push service says so (410).
const isGone = (error: unknown) =>
  error instanceof WebPushError && (error.statusCode === 404 || error.statusCode === 410);

@Injectable()
export class PushChannel implements Channel {
  readonly kind = 'PUSH';

  constructor(config: ConfigService<Env, true>) {
    const subject = config.get('VAPID_SUBJECT', { infer: true });
    const publicKey = config.get('VAPID_PUBLIC_KEY', { infer: true });
    const privateKey = config.get('VAPID_PRIVATE_KEY', { infer: true });
    // The registry lists the channel only when these are set; unset, it is never called.
    if (subject !== undefined && publicKey !== undefined && privateKey !== undefined) {
      setVapidDetails(subject, publicKey, privateKey);
    }
  }

  async send(address: string, message: Message, keys?: unknown): Promise<SendResult> {
    const parsed = pushKeys.safeParse(keys);
    if (!parsed.success) throw new Error('A push subscription needs its keys');
    const payload = JSON.stringify({ title: message.subject, body: message.text, url: message.url });
    try {
      await sendNotification({ endpoint: address, keys: parsed.data }, payload, { TTL: TTL_SECONDS });
      return 'sent';
    } catch (error) {
      if (isGone(error)) return 'unreachable';
      throw error;
    }
  }
}
