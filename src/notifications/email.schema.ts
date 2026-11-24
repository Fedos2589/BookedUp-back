import { z } from 'zod';

import { localeSchema } from '../account/locale.js';

// A client turns email on for one booking: an address (RFC 5321 caps it at 254), in the language of the page.
export const emailOnInput = z.object({
  email: z.email().max(254).toLowerCase(),
  locale: localeSchema,
});
export type EmailOnInput = z.infer<typeof emailOnInput>;
