import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';

import type { Env } from '../config/env.js';
import { TelegramClient } from './channels/telegram.client.js';
import { TelegramUpdatesService } from './telegram-updates.service.js';

const POLL_SECONDS = 25;
const RETRY_MS = 5000;

const updatesSchema = z.array(z.object({ update_id: z.number().int() }).loose());

// Development only: a laptop has no public address for a webhook, so the bot is asked for its updates
// (long polling). With the token set, no webhook secret and NODE_ENV=development; anywhere else the webhook is used.
@Injectable()
export class TelegramPolling implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TelegramPolling.name);
  private readonly stop = new AbortController();

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly telegram: TelegramClient,
    private readonly updates: TelegramUpdatesService,
  ) {}

  get enabled(): boolean {
    return (
      this.config.get('NODE_ENV', { infer: true }) === 'development' &&
      this.config.get('TELEGRAM_BOT_TOKEN', { infer: true }) !== undefined &&
      this.config.get('TELEGRAM_WEBHOOK_SECRET', { infer: true }) === undefined
    );
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.poll().catch((err: unknown) => this.logger.error({ err }, 'Telegram polling stopped'));
  }

  onModuleDestroy(): void {
    this.stop.abort();
  }

  private async poll(): Promise<void> {
    // In memory: after a restart Telegram sends the updates not yet confirmed, and a used token answers «expired».
    let offset = 0;
    while (!this.stop.signal.aborted) {
      try {
        const result = await this.telegram.call(
          'getUpdates',
          { offset, timeout: POLL_SECONDS, allowed_updates: ['message'] },
          { signal: this.stop.signal, timeoutMs: (POLL_SECONDS + 10) * 1000 },
        );
        for (const update of updatesSchema.parse(result)) {
          offset = update.update_id + 1;
          await this.updates.handleUpdate(update);
        }
      } catch (err) {
        if (this.stop.signal.aborted) return;
        this.logger.warn({ err }, 'Telegram getUpdates failed');
        await sleep(RETRY_MS, undefined, { signal: this.stop.signal }).catch(() => undefined);
      }
    }
  }
}
