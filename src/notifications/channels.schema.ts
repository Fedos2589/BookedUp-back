import { z } from 'zod';

// Which channels this server can send on: what the front may offer.
export const availableChannelsSchema = z.object({
  telegram: z.boolean(),
  whatsapp: z.boolean(),
  push: z.boolean(),
  email: z.boolean(),
});
export type AvailableChannels = z.infer<typeof availableChannelsSchema>;

// What is on for one online booking, as its booker sees it by the link.
export const clientNotificationsSchema = z.object({
  telegram: z.boolean(),
  whatsapp: z.boolean().describe('The card’s number (or the guardian’s), so every booking of that phone has it'),
  push: z.array(z.string()).describe('The endpoints on, so a browser knows whether it is one of them'),
  email: z.string().nullable().describe('Masked: `m***@example.com`'),
});
export type ClientNotifications = z.infer<typeof clientNotificationsSchema>;
