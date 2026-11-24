import { ConfigService } from '@nestjs/config';

import type { TelegramClient } from './channels/telegram.client.js';
import { TelegramPolling } from './telegram-polling.js';
import type { TelegramUpdatesService } from './telegram-updates.service.js';

const polling = (env: Record<string, string>) =>
  new TelegramPolling(new ConfigService(env), {} as TelegramClient, {} as TelegramUpdatesService);

describe('TelegramPolling.enabled', () => {
  const dev = { NODE_ENV: 'development', TELEGRAM_BOT_TOKEN: '1:a' };

  it('is on in development with a token and no webhook secret', () => {
    expect(polling(dev).enabled).toBe(true);
  });

  it.each([
    ['no token', { NODE_ENV: 'development' }],
    ['a webhook secret (the webhook is used)', { ...dev, TELEGRAM_WEBHOOK_SECRET: 's' }],
    ['production', { ...dev, NODE_ENV: 'production' }],
    ['tests', { ...dev, NODE_ENV: 'test' }],
  ])('is off with %s', (_, env) => {
    expect(polling(env).enabled).toBe(false);
  });
});
