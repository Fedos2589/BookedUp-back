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

// How long before a booking its client hears a reminder, in minutes (the database CHECK
// businesses_reminder_offsets lists the same: an hour, 2, 3, a day, 2 days).
export const REMINDER_OFFSETS = [60, 120, 180, 1440, 2880] as const;
const MAX_REMINDERS = 3;

// The CHECK lets repeats through (`<@` is a subset test): this schema is the only guard. The list is saved sorted.
export const setRemindersSchema = z.object({
  offsets: z
    .array(z.literal(REMINDER_OFFSETS))
    .max(MAX_REMINDERS)
    .refine((offsets) => new Set(offsets).size === offsets.length, 'Each time only once'),
});

export type SetRemindersInput = z.infer<typeof setRemindersSchema>;

// A business as the API answers it (sign-up, GET /me, GET /businesses/:businessId).
export const businessSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  timeZone: z.string(),
  // Minutes before a booking, ascending; empty = no reminders.
  reminderOffsets: z.array(z.number()),
});

// What the queries read for businessSchema. A field added there and not here fails
// typecheck in the services, whose answers are typed by the schema.
export const businessSelect = { id: true, name: true, slug: true, timeZone: true, reminderOffsets: true } as const;

// A business together with the signed-in user's role in it.
export const memberBusinessSchema = businessSchema.extend({ role: z.enum(MemberRole) });

export type MemberBusiness = z.infer<typeof memberBusinessSchema>;
