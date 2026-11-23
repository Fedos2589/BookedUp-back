import { z } from 'zod';

// The account's own switches (GET and PUT /me/notifications). M7–M8 add the channels.
export const myNotificationsSchema = z.object({
  // Staff messages to the address of the account.
  email: z.boolean(),
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
