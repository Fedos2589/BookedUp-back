import { Public } from '@nestjs/authentication';
import { Body, Controller, HttpCode, Post, UnauthorizedException, Headers } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import type { Env } from '../config/env.js';
import { TelegramUpdatesService } from './telegram-updates.service.js';

const digest = (value: string) => createHash('sha256').update(value).digest();

// Telegram calls this, not the front: no Swagger entry, no session. What proves the caller is the secret
// set with setWebhook, sent in a header. Without a secret in the env nobody can be proven, so nobody is let in.
@ApiExcludeController()
@Public()
// Telegram sends from a few addresses and the secret already vouches for them.
@SkipThrottle()
@Controller('telegram')
export class TelegramWebhookController {
  constructor(
    private readonly updates: TelegramUpdatesService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Headers('x-telegram-bot-api-secret-token') given: string | undefined,
    @Body({ schema: z.unknown() }) update: unknown,
  ): Promise<void> {
    const secret = this.config.get('TELEGRAM_WEBHOOK_SECRET', { infer: true });
    // Digests, so the comparison is constant-time whatever the lengths.
    if (secret === undefined || given === undefined || !timingSafeEqual(digest(given), digest(secret))) {
      throw new UnauthorizedException();
    }
    await this.updates.handleUpdate(update);
  }
}
