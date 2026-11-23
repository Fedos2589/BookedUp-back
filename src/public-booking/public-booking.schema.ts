import { z } from 'zod';

import { bookingConflictSchema } from '../appointments/appointments.schema.js';
import { blankIsNone, clientName, clientPhone } from '../clients/clients.schema.js';
import { instant, whenFieldsValid } from '../schedule/schedule.schema.js';
import { ScheduleMode } from '../generated/prisma/enums.js';

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
    staffId: z.uuid(),
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
