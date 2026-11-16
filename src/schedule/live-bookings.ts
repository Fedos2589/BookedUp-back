import { ConflictException } from '@nestjs/common';

import { z } from 'zod';

import type { Prisma } from '../generated/prisma/client.js';

// A booking that still expects the master: not cancelled, not marked done or missed.
const live: Prisma.AppointmentWhereInput = { status: { in: ['BOOKED', 'CONFIRMED'] } };

// Which live bookings the schedule change would leave without a slot; none: the change goes on.
// Read under the master's lock, so a booking can't slip in between the check and the change.
export const liveBookingIds = async (
  tx: Prisma.TransactionClient,
  businessId: string,
  where: Prisma.AppointmentWhereInput,
): Promise<string[]> => {
  const found = await tx.appointment.findMany({
    where: { businessId, ...live, ...where },
    orderBy: { startsAt: 'asc' },
    select: { id: true },
  });
  return found.map(({ id }) => id);
};

export const refuseIfAny = (appointmentIds: readonly string[]) => {
  if (appointmentIds.length === 0) return;
  throw new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    message: 'There are bookings on it: cancel or move them first',
    code: 'hasBookings',
    appointmentIds,
  });
};

// 409: bookings are on what is being changed. Cancel or move them first.
export const hasBookingsSchema = z.object({
  statusCode: z.literal(409),
  error: z.literal('Conflict'),
  message: z.string(),
  code: z.literal('hasBookings'),
  appointmentIds: z.array(z.uuid()).describe('The bookings in the way'),
});
