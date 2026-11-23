import { Injectable, Logger } from '@nestjs/common';

import { localeSchema } from '../account/locale.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { MessageLocale } from './messages.js';
import { type Member, recipientsOf, type RecipientsContext, STAFF_KINDS } from './recipients.js';

const BATCH = 50;

// Until the real channels exist (step M) every message goes to the log.
const FALLBACK_TO_LOG = true;

// `en` or `ru`: a CHECK constraint keeps the columns to these two; a new language fails loudly here.
const localeOf = (value: string): MessageLocale => localeSchema.parse(value);

// MOVED events keep where the booking was in their payload: `{ fromStaffId, fromStartsAt }`.
const fromStaffIdOf = (payload: Prisma.JsonValue): string | null => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const { fromStaffId } = payload;
  return typeof fromStaffId === 'string' ? fromStaffId : null;
};

type Event = Prisma.NotificationEventGetPayload<object>;

@Injectable()
export class DispatcherService {
  private readonly logger = new Logger(DispatcherService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Turns the events nobody has looked at yet into one delivery per recipient and marks them processed.
  // Returns how many it took, at most BATCH. Each event has a transaction of its own: one that cannot be
  // read is logged and left for the next run, and holds nobody back. Two runs at once take different
  // events (SKIP LOCKED); a run that dies halfway rolls its event back, and a delivery is never written
  // twice (unique key + skipDuplicates).
  async expand(now: Date): Promise<number> {
    const failed: string[] = [];
    let taken = 0;
    while (taken + failed.length < BATCH) {
      const outcome = await this.expandOne(now, failed);
      if (outcome === 'none') break;
      if (outcome === 'done') taken++;
    }
    return taken;
  }

  private async expandOne(now: Date, failed: string[]): Promise<'done' | 'failed' | 'none'> {
    const picked: { id?: string } = {};
    try {
      return await this.prisma.$transaction(async (tx) => {
        // The scan crosses businesses by design: the outbox is one queue for all of them. Everything
        // read for the event below is filtered by that event's businessId.
        const [row] = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM notification_events
          WHERE processed_at IS NULL AND id <> ALL(${failed}::uuid[])
          ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`;
        if (!row) return 'none';
        picked.id = row.id;
        const event = await tx.notificationEvent.findUniqueOrThrow({ where: { id: row.id } });
        const recipients = recipientsOf(event, await this.contextOf(tx, event));
        await tx.notificationDelivery.createMany({
          data: recipients.map((r) => ({ ...r, businessId: event.businessId, eventId: event.id })),
          skipDuplicates: true,
        });
        await tx.notificationEvent.update({ where: { id: event.id }, data: { processedAt: now } });
        return 'done';
      });
    } catch (error) {
      // Not about an event (the database is down): the caller sees it.
      if (picked.id === undefined) throw error;
      this.logger.warn({ err: error, eventId: picked.id }, 'Expanding a notification event failed');
      failed.push(picked.id);
      return 'failed';
    }
  }

  private async contextOf(tx: Prisma.TransactionClient, event: Event): Promise<RecipientsContext> {
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
    // Reminders and «channel on» go to the client only: no need to read the team for them.
    const forStaff = STAFF_KINDS.includes(event.kind);
    const fromStaffId = fromStaffIdOf(event.payload);
    const previousMaster =
      !forStaff || fromStaffId === null || fromStaffId === appointment.staff.id
        ? null
        : await tx.staff.findFirst({ where: { businessId, id: fromStaffId }, select: { userId: true } });
    const memberships = forStaff
      ? await tx.membership.findMany({
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
        })
      : [];
    // The client's WhatsApp sits on their card, or on their guardian's when they have no phone;
    // every other channel belongs to this booking (E9, decision 4). A channel turned on after the event
    // wasn't there for it: it hears of itself through its own CHANNEL_ON.
    const cards =
      appointment.client.guardianId === null
        ? [appointment.clientId]
        : [appointment.clientId, appointment.client.guardianId];
    const clientChannels = await tx.clientChannel.findMany({
      where: {
        businessId,
        disabledAt: null,
        ...(event.kind === 'CHANNEL_ON' ? {} : { createdAt: { lte: event.createdAt } }),
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
