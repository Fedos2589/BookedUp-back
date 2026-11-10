import { z } from 'zod';

import { MemberRole } from '../generated/prisma/enums.js';

export const accountSchema = z.object({
  user: z.object({ id: z.uuid(), email: z.email(), name: z.string() }),
  // Every business the user belongs to, with their role there.
  businesses: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      slug: z.string(),
      timeZone: z.string(),
      role: z.enum(MemberRole),
    }),
  ),
});

export type Account = z.infer<typeof accountSchema>;
