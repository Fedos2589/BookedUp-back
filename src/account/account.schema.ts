import { z } from 'zod';

import { memberBusinessSchema } from '../business/business.schema.js';
import { localeSchema } from './locale.js';

export const accountSchema = z.object({
  user: z.object({ id: z.uuid(), email: z.email(), name: z.string(), locale: localeSchema }),
  // Every business the user belongs to, with their role there.
  businesses: z.array(memberBusinessSchema),
});

export type Account = z.infer<typeof accountSchema>;
