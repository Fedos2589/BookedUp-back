import { z } from 'zod';

export { localeBodySchema as telegramLinkInput, type LocaleBody as TelegramLinkInput } from '../account/locale.js';

// Where the person goes to connect their Telegram chat: t.me/<bot>?start=<one-time token>.
export const telegramLinkSchema = z.object({ url: z.url() });
export type TelegramLinkDto = z.infer<typeof telegramLinkSchema>;

// 404: the channel is not configured here, so there is nothing to turn on.
export const channelOffSchema = z.object({
  statusCode: z.literal(404),
  error: z.literal('Not Found'),
  message: z.string(),
  code: z.literal('channelOff'),
});

// 404 of a public route that also looks a booking up: no such booking (Nest's plain body) or the channel is off.
export const bookingOrChannelNotFoundSchema = z.union([
  channelOffSchema,
  z.object({ statusCode: z.literal(404), message: z.string(), error: z.string().optional() }),
]);
