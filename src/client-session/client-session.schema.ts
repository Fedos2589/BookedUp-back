import { z } from 'zod';

import { telegramLinkSchema } from '../notifications/link.schema.js';

// The bot's link plus the code the page shows next to it, for the person to compare with the bot's message.
export const clientLoginStartSchema = telegramLinkSchema.extend({ code: z.string().regex(/^\d{4}$/) });
export type ClientLoginStartDto = z.infer<typeof clientLoginStartSchema>;

// Where this browser's login stands. `confirmed`: the session cookie is set by this very answer.
// `code` is repeated while `pending`, so a reloaded page can still show it.
export const clientLoginStatusSchema = z.object({
  status: z.enum(['pending', 'confirmed', 'expired']),
  code: z
    .string()
    .regex(/^\d{4}$/)
    .optional(),
});
export type ClientLoginStatusDto = z.infer<typeof clientLoginStatusSchema>;

// What the front shows on a done screen; null: no live session in this browser.
export const clientSessionSchema = z.object({ phone: z.string().nullable() });
export type ClientSessionDto = z.infer<typeof clientSessionSchema>;

// 401 of a route that needs the client's confirmed phone: the front starts the Telegram sign-in.
export const clientSignInSchema = z.object({
  statusCode: z.literal(401),
  error: z.literal('Unauthorized'),
  message: z.string(),
  code: z.literal('clientSignIn'),
});
