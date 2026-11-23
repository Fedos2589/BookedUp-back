import { z } from 'zod';

import { bookingConflictSchema } from '../appointments/appointments.schema.js';
import { blankIsNone, clientName, clientPhone } from '../clients/clients.schema.js';
import { instant, whenFieldsValid } from '../schedule/schedule.schema.js';
import { AppointmentStatus, ScheduleMode } from '../generated/prisma/enums.js';

// What a visitor sees of a business: its name and zone, and the masters they can book. Nothing
// about clients.
export const publicBusinessSchema = z.object({
  name: z.string(),
  slug: z.string(),
  timeZone: z.string(),
  masters: z.array(z.object({ id: z.uuid(), name: z.string(), scheduleMode: z.enum(ScheduleMode) })),
});
export type PublicBusinessDto = z.infer<typeof publicBusinessSchema>;

// A booking from the business's page: the slot, and who by name and phone.
export const publicBookingInput = z
  .object({
    staffId: z.uuid().optional().describe('The master; none: any master who is free at exactly this time'),
    startsAt: instant,
    endsAt: instant,
    groupId: z.uuid().optional().describe('Book a seat in the meeting of this group at this time'),
    oneOffSessionId: z.uuid().optional().describe('Book a seat in this one-off session'),
    name: clientName,
    phone: clientPhone,
    note: blankIsNone(2000),
  })
  .refine((booking) => booking.startsAt < booking.endsAt, {
    path: ['endsAt'],
    message: 'Not after startsAt',
    ...whenFieldsValid,
  })
  .refine((booking) => !(booking.groupId && booking.oneOffSessionId), {
    path: ['oneOffSessionId'],
    message: 'A seat is in a group or in a one-off session, not both',
    ...whenFieldsValid,
  })
  .refine((booking) => booking.staffId || !(booking.groupId || booking.oneOffSessionId), {
    path: ['staffId'],
    message: 'A meeting is one master’s: give staffId with groupId or oneOffSessionId',
    ...whenFieldsValid,
  });
export type PublicBookingInput = z.infer<typeof publicBookingInput>;

// What the booker is told of their booking: nothing of other clients, and the same for a phone the
// business knows and for a new one.
export const publicBookingResultSchema = z.object({
  booking: z.object({
    id: z.uuid(),
    staffId: z.uuid(),
    staffName: z.string(),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    title: z.string().nullable().describe("The meeting's title; none for an hours booking"),
    groupId: z.uuid().nullable(),
    oneOffSessionId: z.uuid().nullable(),
  }),
  manageLink: z.url().describe('Private: whoever has it can see, cancel and move this booking'),
});
export type PublicBookingResult = z.infer<typeof publicBookingResultSchema>;

export const publicBookingConflictSchema = bookingConflictSchema.omit({ code: true }).extend({
  code: z
    .enum(['notFree', 'full', 'tooManyBookings'])
    .describe(
      'notFree: no such slot or taken; full: every seat of the meeting is taken; tooManyBookings: this phone already has 3 bookings to come',
    ),
});

// The private link's token: 32 random bytes in base64url.
export const manageTokenSchema = z
  .string()
  .length(43)
  .regex(/^[\w-]+$/);

// A booking as its booker sees it by the link: the business to show, the booking without any id or
// client, and whether it can still be changed (live and not started).
export const managedBookingSchema = z.object({
  business: z.object({ name: z.string(), slug: z.string(), timeZone: z.string() }),
  booking: z.object({
    staffId: z.uuid(),
    staffName: z.string(),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    title: z.string().nullable().describe("The meeting's title; none for an hours booking"),
    status: z.enum(AppointmentStatus),
    groupId: z.uuid().nullable(),
    oneOffSessionId: z.uuid().nullable(),
  }),
  canChange: z.boolean().describe('BOOKED or CONFIRMED and not started: it can be cancelled or moved'),
});
export type ManagedBookingDto = z.infer<typeof managedBookingSchema>;

export const managedBookingConflictSchema = bookingConflictSchema.omit({ code: true }).extend({
  code: z.literal('badTransition').describe('The booking has started or is not BOOKED / CONFIRMED any more'),
});

export const publicMoveConflictSchema = bookingConflictSchema.omit({ code: true }).extend({
  code: z.enum(['notFree', 'full', 'badTransition']),
});

// The business's web app manifest: what makes /book/<slug> installable as its own app.
export const businessManifestSchema = z.object({
  id: z.string(),
  name: z.string(),
  short_name: z.string(),
  start_url: z.string(),
  scope: z.string(),
  display: z.literal('standalone'),
  background_color: z.string(),
  theme_color: z.string(),
  icons: z.array(z.object({ src: z.string(), sizes: z.string(), type: z.string(), purpose: z.string().optional() })),
});
export type BusinessManifestDto = z.infer<typeof businessManifestSchema>;
