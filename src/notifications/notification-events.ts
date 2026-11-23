import type { Prisma } from '../generated/prisma/client.js';

// The outbox (E9, decision 1): a booking's change writes its event on the same transaction as the
// change, so there is no change without its event and no event for a change that rolled back.
// `actorUserId` is who made the change; null = the client online.
export const recordEvent = (
  tx: Prisma.TransactionClient,
  event: {
    businessId: string;
    appointmentId: string;
    kind: 'BOOKED' | 'MOVED' | 'CANCELLED';
    actorUserId: string | null;
    startsAt: Date;
  },
) => tx.notificationEvent.create({ data: event, select: { id: true } });
