import { z } from 'zod';

import { localeSchema } from '../account/locale.js';

// The push services browsers use (Chrome, Firefox, Safari, Edge). The server POSTs to the endpoint, so a
// hostname we don't know would let a visitor aim those requests at any host.
const PUSH_HOSTS = [
  /(^|\.)fcm\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)push\.apple\.com$/,
  /(^|\.)notify\.windows\.com$/,
];

const endpointSchema = z
  .url({ protocol: /^https$/ })
  .max(1000)
  .refine((url) => PUSH_HOSTS.some((host) => host.test(new URL(url).hostname)), 'Not a known push service');

// What the browser's `PushSubscription.toJSON()` gives, cut to what we use. The endpoint is an https URL
// the push service chose; the keys are base64url strings of fixed small size.
export const pushSubscriptionSchema = z.object({
  endpoint: endpointSchema,
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});
export type PushSubscription = z.infer<typeof pushSubscriptionSchema>;

// A client turns push on for one booking, in the language of the page.
export const pushOnInput = z.object({ subscription: pushSubscriptionSchema, locale: localeSchema });
export type PushOnInput = z.infer<typeof pushOnInput>;

// Turning off takes any endpoint: it only names a row of this booking, and a host we stopped knowing may still be in one.
export const pushOffInput = z.object({ endpoint: z.string().min(1).max(1000) });
export type PushOffInput = z.infer<typeof pushOffInput>;
