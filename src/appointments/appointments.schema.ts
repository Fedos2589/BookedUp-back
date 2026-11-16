import { z } from 'zod';

import { instant, whenFieldsValid } from '../schedule/schedule.schema.js';

const blankIsNone = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => value || null);

// The client is a name and a phone on the booking itself (E8 adds clients and merges by phone).
const clientName = z.string().trim().min(1).max(100);
// E.164: «+», a country code that doesn't start with 0, 7 to 15 digits in all. The lower bound is the
// same as the `appointments_client_phone` CHECK in the database: a looser one here would be a 500 there.
const clientPhone = z
  .string()
  .max(16)
  .regex(/^\+[1-9]\d{6,14}$/, 'Not a phone number in the international format');

export const appointmentInput = z
  .object({ staffId: z.uuid(), startsAt: instant, endsAt: instant, clientName, clientPhone, note: blankIsNone(2000) })
  .refine((booking) => booking.startsAt < booking.endsAt, {
    path: ['endsAt'],
    message: 'Not after startsAt',
    ...whenFieldsValid,
  });
export type AppointmentInput = z.infer<typeof appointmentInput>;

export const appointmentStatus = z.enum(['BOOKED', 'CONFIRMED', 'DONE', 'NO_SHOW', 'CANCELLED']);

export const appointmentSchema = z.object({
  id: z.uuid(),
  staffId: z.uuid(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  status: appointmentStatus,
  clientName: z.string(),
  clientPhone: z.string(),
  note: z.string().nullable(),
  groupId: z.uuid().nullable().describe('The group whose meeting it is a seat in'),
  oneOffSessionId: z.uuid().nullable().describe('The one-off session it is a seat in'),
});
export type AppointmentDto = z.infer<typeof appointmentSchema>;

// 409: the time can't be booked. `code` tells the form what to say.
export const bookingConflictSchema = z.object({
  statusCode: z.literal(409),
  error: z.literal('Conflict'),
  message: z.string(),
  code: z.enum(['notFree']),
});
