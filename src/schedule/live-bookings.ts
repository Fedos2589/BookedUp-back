import { ConflictException } from '@nestjs/common';

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
