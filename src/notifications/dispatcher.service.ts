import { Injectable } from '@nestjs/common';

import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { MessageLocale } from './messages.js';
import { type Member, recipientsOf, type RecipientsContext } from './recipients.js';

const BATCH = 50;

// Until the real channels exist (step M) every message goes to the log.
const FALLBACK_TO_LOG = true;

// `en` or `ru`: a CHECK constraint keeps the columns to these two.
const localeOf = (value: string): MessageLocale => (value === 'ru' ? 'ru' : 'en');

// MOVED events keep where the booking was in their payload: `{ fromStaffId, fromStartsAt }`.
const fromStaffIdOf = (payload: Prisma.JsonValue): string | null => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const { fromStaffId } = payload;
  return typeof fromStaffId === 'string' ? fromStaffId : null;
};

@Injectable()
export class DispatcherService {
  constructor(private readonly prisma: PrismaService) {}

  // Turns the events nobody has looked at yet into one delivery per recipient and marks them processed.
  // Returns how many events it took. Two runs at once take different events (SKIP LOCKED); a run that
  // dies halfway rolls back, so its events are taken again, and a delivery is never written twice
  // (unique key + skipDuplicates).
  expand(now: Date): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      // The scan crosses businesses by design: the outbox is one queue for all of them. Everything
      // read for an event below is filtered by that event's businessId.
      const ids = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM notification_events WHERE processed_at IS NULL
        ORDER BY created_at, id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`;
      const events = await tx.notificationEvent.findMany({
        where: { id: { in: ids.map((row) => row.id) } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      for (const event of events) {
        const ctx = await this.contextOf(tx, event);
        const recipients = recipientsOf(event, ctx);
        await tx.notificationDelivery.createMany({
          data: recipients.map((r) => ({ ...r, businessId: event.businessId, eventId: event.id })),
          skipDuplicates: true,
        });
      }
      await tx.notificationEvent.updateMany({
        where: { id: { in: events.map((event) => event.id) } },
        data: { processedAt: now },
      });
      return events.length;
    });
  }

  private async contextOf(
    tx: Prisma.TransactionClient,
    event: { businessId: string; appointmentId: string; payload: Prisma.JsonValue },
  ): Promise<RecipientsContext> {
    const { businessId } = event;
    const appointment = await tx.appointment.findFirstOrThrow({
      where: { businessId, id: event.appointmentId },
      select: {
        id: true,
        clientId: true,
        staff: { select: { id: true, userId: true } },
        client: { select: { guardianId: true } },
      },
    });
    const fromStaffId = fromStaffIdOf(event.payload);
    const previousMaster =
      fromStaffId === null || fromStaffId === appointment.staff.id
        ? null
        : await tx.staff.findFirst({ where: { businessId, id: fromStaffId }, select: { userId: true } });
    const memberships = await tx.membership.findMany({
      where: { businessId },
      select: {
        role: true,
        notifyAllOnline: true,
        user: {
          select: {
            id: true,
            email: true,
            locale: true,
            notifyEmail: true,
            channels: { select: { kind: true, address: true } },
          },
        },
      },
    });
    // The client's WhatsApp sits on their card, or on their guardian's when they have no phone;
    // every other channel belongs to this booking (E9, decision 4).
    const cards =
      appointment.client.guardianId === null
        ? [appointment.clientId]
        : [appointment.clientId, appointment.client.guardianId];
    const clientChannels = await tx.clientChannel.findMany({
      where: {
        businessId,
        disabledAt: null,
        OR: [{ appointmentId: appointment.id }, { kind: 'WHATSAPP', clientId: { in: cards } }],
      },
      select: { id: true, kind: true, address: true, locale: true },
      orderBy: { id: 'asc' },
    });
    const members: Member[] = memberships.map(({ role, notifyAllOnline, user }) => ({
      userId: user.id,
      role,
      notifyAllOnline,
      email: user.email,
      locale: localeOf(user.locale),
      notifyEmail: user.notifyEmail,
      channels: user.channels,
    }));
    return {
      masterUserId: appointment.staff.userId,
      previousMasterUserId: previousMaster?.userId ?? null,
      members,
      clientChannels: clientChannels.map((c) => ({ ...c, locale: localeOf(c.locale) })),
      fallbackToLog: FALLBACK_TO_LOG,
    };
  }
}
