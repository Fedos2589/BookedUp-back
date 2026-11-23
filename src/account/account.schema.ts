import { z } from 'zod';

import { memberBusinessSchema } from '../business/business.schema.js';
import { userSchema } from './user.schema.js';

export const accountSchema = z.object({
  user: userSchema,
  // Every business the user belongs to, with their role there.
  businesses: z.array(memberBusinessSchema),
});

export type Account = z.infer<typeof accountSchema>;
