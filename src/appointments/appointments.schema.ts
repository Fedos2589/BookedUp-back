import { z } from 'zod';

import { blankIsNone, clientConflictCode, clientInput } from '../clients/clients.schema.js';
import { instant, slotsQuery, whenFieldsValid } from '../schedule/schedule.schema.js';

export const appointmentInput = z
  .object({
    staffId: z.uuid(),
    startsAt: instant,
    endsAt: instant,
    clientId: z.uuid().optional().describe('A person of this business'),
    newClient: clientInput.optional().describe('A new person: made in the same step as the booking'),
    note: blankIsNone(2000),
    groupId: z.uuid().optional().describe('Book a seat in the meeting of this group at this time'),
    oneOffSessionId: z.uuid().optional().describe('Book a seat in this one-off session'),
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
  .refine((booking) => !booking.clientId !== !booking.newClient, {
    path: ['clientId'],
    message: 'Give clientId or newClient, not both and not neither',
    ...whenFieldsValid,
  });
export type AppointmentInput = z.infer<typeof appointmentInput>;

// Someone who came to a meeting without a booking: always a seat, in a meeting that has started.
export const walkInInput = appointmentInput.refine((booking) => booking.groupId || booking.oneOffSessionId, {
  path: ['groupId'],
  message: 'A walk-in is a seat: give groupId or oneOffSessionId',
  ...whenFieldsValid,
});

// Where a booking goes: the same slot fields as booking, and the master stays if none is given.
export const moveInput = z
  .object({
    staffId: z.uuid().optional().describe('The master to move to; none: the same master'),
    startsAt: instant,
    endsAt: instant,
    groupId: z.uuid().optional().describe('Move to the meeting of this group at this time'),
    oneOffSessionId: z.uuid().optional().describe('Move to this one-off session'),
  })
  .refine((move) => move.startsAt < move.endsAt, {
    path: ['endsAt'],
    message: 'Not after startsAt',
    ...whenFieldsValid,
  })
  .refine((move) => !(move.groupId && move.oneOffSessionId), {
    path: ['oneOffSessionId'],
    message: 'A seat is in a group or in a one-off session, not both',
    ...whenFieldsValid,
  });
export type MoveInput = z.infer<typeof moveInput>;

export const appointmentStatus = z.enum(['BOOKED', 'CONFIRMED', 'DONE', 'NO_SHOW', 'CANCELLED']);

export type AppointmentStatus = z.infer<typeof appointmentStatus>;

export const statusInput = z.object({ status: appointmentStatus });
export type StatusInput = z.infer<typeof statusInput>;

// BOOKED → CONFIRMED; BOOKED | CONFIRMED → DONE | NO_SHOW | CANCELLED: marking a visit needs no
// confirming first. Nothing leaves the last three.
export const nextStatuses: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  BOOKED: ['CONFIRMED', 'DONE', 'NO_SHOW', 'CANCELLED'],
  CONFIRMED: ['DONE', 'NO_SHOW', 'CANCELLED'],
  DONE: [],
  NO_SHOW: [],
  CANCELLED: [],
};

export const appointmentSchema = z.object({
  id: z.uuid(),
  staffId: z.uuid(),
  clientId: z.uuid(),
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
  code: z
    .enum(['notFree', 'full', ...clientConflictCode.options])
    .describe(
      'notFree: no such slot or taken; full: every seat of the meeting is taken; phoneTaken / notHolder: the newClient, as when creating a client',
    ),
  clientId: z.uuid().optional().describe('With phoneTaken: the holder of the phone'),
});

// 409 for a move: the new place can't take it, or the booking can't move any more.
export const moveConflictSchema = z.object({
  statusCode: z.literal(409),
  error: z.literal('Conflict'),
  message: z.string(),
  code: z
    .enum(['notFree', 'full', 'badTransition'])
    .describe('notFree / full: as for booking; badTransition: only BOOKED and CONFIRMED bookings move'),
});

// 409 for a walk-in. `code` tells the form what to say.
export const walkInConflictSchema = z.object({
  statusCode: z.literal(409),
  error: z.literal('Conflict'),
  message: z.string(),
  code: z
    .enum(['notFree', 'notStarted', ...clientConflictCode.options])
    .describe(
      'notFree: no such meeting at this time; notStarted: the meeting is ahead — book a seat instead; phoneTaken / notHolder: the newClient, as when creating a client',
    ),
  clientId: z.uuid().optional().describe('With phoneTaken: the holder of the phone'),
});

// The days of the business's clock, both included (at most 31), as for slots; a booking is on the day it starts.
export const appointmentsQuery = slotsQuery.safeExtend({
  includeCancelled: z.stringbool().default(false),
});
export type AppointmentsQuery = z.infer<typeof appointmentsQuery>;

export const statusConflictSchema = z.object({
  statusCode: z.literal(409),
  error: z.literal('Conflict'),
  message: z.string(),
  code: z
    .enum(['badTransition', 'notStarted'])
    .describe(
      'badTransition: not an allowed move from the current status; notStarted: DONE / NO_SHOW before the start',
    ),
});
