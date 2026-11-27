import { z } from 'zod';

import { emailSchema, passwordSchema } from './credentials.schema.js';

export const passwordResetRequestSchema = z.object({ email: emailSchema });

export type PasswordResetRequest = z.infer<typeof passwordResetRequestSchema>;

// The token is what `newRandomToken()` makes: 43 URL-safe characters.
export const passwordResetConfirmSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  password: passwordSchema.min(8),
});

export type PasswordResetConfirm = z.infer<typeof passwordResetConfirmSchema>;

// 404: unknown, expired or used link — one answer for all three.
export const resetLinkInvalidSchema = z.object({
  statusCode: z.literal(404),
  error: z.literal('Not Found'),
  message: z.string(),
  code: z.literal('resetLinkInvalid'),
});
