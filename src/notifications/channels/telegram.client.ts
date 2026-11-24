import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../config/env.js';

// What Telegram said when it refused: `code` is its error_code (an HTTP status), `description` its words.
export class TelegramError extends Error {
  constructor(
    readonly code: number,
    readonly description: string,
  ) {
    super(`Telegram: ${description} (${code})`);
  }
}

const REQUEST_TIMEOUT_MS = 10_000;

type Reply = { ok: true; result: unknown } | { ok: false; error_code: number; description: string };

// The Bot API over fetch. The token is in the URL, so no error leaves here with the URL in it.
@Injectable()
export class TelegramClient {
  constructor(private readonly config: ConfigService<Env, true>) {}

  async call(
    method: string,
    body: object,
    { signal, timeoutMs = REQUEST_TIMEOUT_MS }: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const token = this.config.get('TELEGRAM_BOT_TOKEN', { infer: true });
    if (token === undefined) throw new Error('Telegram is not configured');
    let response: Response;
    try {
      response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        // No answer must not hold a tick (or a webhook reply) for minutes.
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
      });
    } catch {
      // The network error's message and cause can carry the URL, and the URL carries the token.
      throw new Error(`Telegram ${method}: no answer`);
    }
    const reply = (await response.json().catch(() => null)) as Reply | null;
    if (reply?.ok === true) return reply.result;
    throw new TelegramError(
      reply?.ok === false ? reply.error_code : response.status,
      reply?.description ?? 'no description',
    );
  }
}
