import { z } from 'zod';

import { availableChannelsSchema } from './channels.schema.js';
import { clientPhone } from '../clients/clients.schema.js';
import { pushSubscriptionSchema } from './push.schema.js';

// What may change in the account's own switches (PUT /me/notifications).
export const setMyNotificationsSchema = z.object({
  // Staff messages to the address of the account.
  email: z.boolean(),
});
export type SetMyNotificationsInput = z.infer<typeof setMyNotificationsSchema>;

// The account's own notifications (GET and PUT /me/notifications): what the server offers, and what is on.
export const myNotificationsSchema = setMyNotificationsSchema.extend({
  available: availableChannelsSchema,
  pushKey: z.string().nullable().describe('The VAPID public key a browser subscribes with; null when push is off'),
  telegram: z.boolean(),
  whatsapp: z.string().nullable().describe('My number'),
  push: z.array(z.string()).describe('The endpoints of my devices, so a browser knows whether it is one of them'),
});

export type MyNotifications = z.infer<typeof myNotificationsSchema>;

// The member's switches in one business (GET and PUT /businesses/:businessId/me/notifications).
export const myBusinessNotificationsSchema = z.object({
  // Hear of every online booking, not only of the ones with one's own master. `null` for a master: not offered.
  allOnline: z.boolean().nullable(),
});

export type MyBusinessNotifications = z.infer<typeof myBusinessNotificationsSchema>;

export const setMyBusinessNotificationsSchema = z.object({ allOnline: z.boolean() });

export type SetMyBusinessNotificationsInput = z.infer<typeof setMyBusinessNotificationsSchema>;

// The member's own WhatsApp number (PUT /me/notifications/whatsapp). One per account: a new one replaces the old.
export const myWhatsappInput = z.object({ phone: clientPhone });
export type MyWhatsappInput = z.infer<typeof myWhatsappInput>;

// A browser the member turns Web Push on in (PUT /me/notifications/push). One row per device.
export const myPushInput = z.object({ subscription: pushSubscriptionSchema });
export type MyPushInput = z.infer<typeof myPushInput>;
