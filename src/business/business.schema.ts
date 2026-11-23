import { z } from 'zod';

import { MemberRole } from '../generated/prisma/enums.js';

// The format the database enforces too (CHECK businesses_slug_format).
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// A business's address, as it comes in: sign-up, and the public pages found by it.
export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(63)
  .regex(SLUG_PATTERN, 'Use latin letters, digits and single hyphens');

// A business as the API answers it (sign-up, GET /me, GET /businesses/:businessId).
export const businessSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  timeZone: z.string(),
});

// What the queries read for businessSchema. A field added there and not here fails
// typecheck in the services, whose answers are typed by the schema.
export const businessSelect = { id: true, name: true, slug: true, timeZone: true } as const;

// A business together with the signed-in user's role in it.
export const memberBusinessSchema = businessSchema.extend({ role: z.enum(MemberRole) });

export type MemberBusiness = z.infer<typeof memberBusinessSchema>;
