import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../config/env.js';

// What WhatsApp said when it refused: `code` is its error code (131026: the number is not on WhatsApp).
export class WhatsappError extends Error {
  constructor(
    readonly code: number,
    readonly description: string,
  ) {
    super(`WhatsApp: ${description} (${code})`);
  }
}

const REQUEST_TIMEOUT_MS = 10_000;

type Reply = { error?: { code?: number; message?: string } };

// The Cloud API over fetch. The token is in a header, but a network error can still carry it: none leaves here with its own text.
@Injectable()
export class WhatsappClient {
  constructor(private readonly config: ConfigService<Env, true>) {}

  async send(body: object): Promise<void> {
    const token = this.config.get('WHATSAPP_TOKEN', { infer: true });
    const phoneId = this.config.get('WHATSAPP_PHONE_NUMBER_ID', { infer: true });
    if (token === undefined || phoneId === undefined) throw new Error('WhatsApp is not configured');
    let response: Response;
    try {
      response = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        // No answer must not hold a tick for minutes.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Error('WhatsApp: no answer');
    }
    if (response.ok) return;
    const reply = (await response.json().catch(() => null)) as Reply | null;
    throw new WhatsappError(reply?.error?.code ?? response.status, reply?.error?.message ?? 'no description');
  }
}
