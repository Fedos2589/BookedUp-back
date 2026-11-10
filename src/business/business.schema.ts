import { z } from 'zod';

import { MemberRole } from '../generated/prisma/enums.js';

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
