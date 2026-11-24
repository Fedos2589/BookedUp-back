import { z } from 'zod';

import { localeSchema } from '../account/locale.js';

// What the browser's `PushSubscription.toJSON()` gives, cut to what we use. The endpoint is an https URL
// the push service chose; the keys are base64url strings of fixed small size.
export const pushSubscriptionSchema = z.object({
  endpoint: z.url({ protocol: /^https$/ }).max(1000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});
export type PushSubscription = z.infer<typeof pushSubscriptionSchema>;

// A client turns push on for one booking, in the language of the page.
export const pushOnInput = z.object({ subscription: pushSubscriptionSchema, locale: localeSchema });
export type PushOnInput = z.infer<typeof pushOnInput>;

export const pushOffInput = z.object({ endpoint: pushSubscriptionSchema.shape.endpoint });
export type PushOffInput = z.infer<typeof pushOffInput>;
