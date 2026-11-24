import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../config/env.js';
import { messageFor } from '../messages.js';
import type { Channel, RenderInput, SendResult } from './channel.js';

const REQUEST_TIMEOUT_MS = 10_000;

// Resend answers 422 for an address it will not take; that address will never work.
const INVALID_ADDRESS = 422;

// Mail over Resend's HTTP API. The key is in a header, but a network error can still carry it: none leaves here
// with its own text.
@Injectable()
export class EmailChannel implements Channel {
  readonly kind = 'EMAIL';

  constructor(private readonly config: ConfigService<Env, true>) {}

  async send(address: string, input: RenderInput): Promise<SendResult> {
    const key = this.config.get('RESEND_API_KEY', { infer: true });
    const from = this.config.get('MAIL_FROM', { infer: true });
    if (key === undefined || from === undefined) throw new Error('Email is not configured');
    const { subject, text } = messageFor(input);
    let response: Response;
    try {
      response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ from, to: address, subject, text }),
        // No answer must not hold a tick for minutes.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // The timeout fires while the request may already be at Resend; any other failure left before it was taken.
      if (error instanceof DOMException && error.name === 'TimeoutError') return 'unknown';
      throw new Error('Email: no answer');
    }
    if (response.ok) return 'sent';
    if (response.status === INVALID_ADDRESS) return 'unreachable';
    throw new Error(`Email: Resend answered ${response.status}`);
  }
}
