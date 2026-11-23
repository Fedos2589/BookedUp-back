import { z } from 'zod';

import { localeSchema } from './locale.js';

// The user as every answer shows them: sign-up, the invitation's sign-up and GET /me.
export const userSchema = z.object({ id: z.uuid(), email: z.email(), name: z.string(), locale: localeSchema });

export type User = z.infer<typeof userSchema>;

// What to select from `users` to build a User.
export const userSelect = { id: true, email: true, name: true, locale: true } as const;

// The column is text (a CHECK keeps it to the known languages): narrowed once, here.
export const toUser = (row: { id: string; email: string; name: string; locale: string }): User => ({
  ...row,
  locale: localeSchema.parse(row.locale),
});
