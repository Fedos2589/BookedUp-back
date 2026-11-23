import { Injectable, Logger } from '@nestjs/common';

import { localeSchema } from '../account/locale.js';
import { type ChannelKind, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ChannelRegistry } from './channels/channel-registry.js';
import { type MessageLocale, messageFor } from './messages.js';
import { type Member, recipientsOf, type RecipientsContext, STAFF_KINDS } from './recipients.js';

const BATCH = 50;

// A delivery is tried this many times, then stays FAILED.
const MAX_ATTEMPTS = 3;

// `en` or `ru`: a CHECK constraint keeps the columns to these two; a new language fails loudly here.
const localeOf = (value: string): MessageLocale => localeSchema.parse(value);

const fieldOf = (payload: Prisma.JsonValue, key: string): string | null => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const value = payload[key];
  return typeof value === 'string' ? value : null;
};

// MOVED events keep where the booking was in their payload: `{ fromStaffId, fromStartsAt }`.
const fromStaffIdOf = (payload: Prisma.JsonValue) => fieldOf(payload, 'fromStaffId');

type Claimed = {
  id: string;
  businessId: string;
  eventId: string;
  channel: ChannelKind;
  address: string;
  audience: string;
  locale: string;
};

type Event = Prisma.NotificationEventGetPayload<object>;

@Injectable()
export class DispatcherService {
  private readonly logger = new Logger(DispatcherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: ChannelRegistry,
  ) {}

  async dispatch(now: Date): Promise<void> {
    await this.expand(now);
    await this.send(now);
  }

  // Sends what is due, at most BATCH deliveries. A delivery is claimed (SENDING, attempts + 1) in a
  // transaction of its own, committed before any call to the outside: a crash in between leaves it SENDING,
  // and it is never picked again — a message twice is worse than a message lost (E9, decision 3).
  // Two runs at once claim different rows (SKIP LOCKED).
  async send(now: Date): Promise<number> {
    // The scan crosses businesses by design: the outbox is one queue for all of them.
    const claimed = await this.prisma.$queryRaw<Claimed[]>`
      UPDATE notification_deliveries SET status = 'SENDING', attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM notification_deliveries
        WHERE status IN ('PENDING', 'FAILED') AND attempts < ${MAX_ATTEMPTS}
        ORDER BY created_at, id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
      RETURNING id, business_id AS "businessId", event_id AS "eventId", channel, address, audience, locale`;
    for (const delivery of claimed) await this.deliver(delivery, now);
    return claimed.length;
  }

  private async deliver(delivery: Claimed, now: Date): Promise<void> {
    const { id, businessId, eventId } = delivery;
    try {
      const message = await this.render(delivery);
      const result = await this.channels.get(delivery.channel).send(delivery.address, message);
      if (result === 'sent') {
        await this.prisma.notificationDelivery.update({
          where: { id },
          data: { status: 'SENT', sentAt: now, lastError: null },
        });
      } else {
        await this.prisma.notificationDelivery.update({
          where: { id },
          data: { status: 'FAILED', attempts: MAX_ATTEMPTS, lastError: 'unreachable' },
        });
        await this.switchOff(delivery, now);
      }
    } catch (error) {
      this.logger.warn({ err: error, deliveryId: id }, 'Sending a notification failed');
      const lastError = error instanceof Error ? error.message : 'unknown error';
      await this.prisma.notificationDelivery.update({ where: { id }, data: { status: 'FAILED', lastError } });
    }
    await this.wipePayloadIfOut(businessId, eventId);
  }

  // The address will never work. A client channel stays, switched off: its events and deliveries hang on it.
  // A member's channel has nothing hanging on it, so it goes; their email is their account's, it stays.
  // With the log standing in for every channel the kind is unknown, the address alone finds it.
  private async switchOff({ businessId, audience, channel, address }: Claimed, now: Date) {
    const kind = channel === 'LOG' ? {} : { kind: channel };
    if (audience === 'client') {
      await this.prisma.clientChannel.updateMany({
        where: { businessId, address, disabledAt: null, ...kind },
        data: { disabledAt: now },
      });
    } else if (channel !== 'EMAIL') {
      await this.prisma.userChannel.deleteMany({ where: { address, ...kind } });
    }
  }

  // The manage link lives in a CHANNEL_ON event's payload only until its messages are out (decision 5).
  private async wipePayloadIfOut(businessId: string, eventId: string) {
    const waiting = await this.prisma.notificationDelivery.count({
      where: {
        businessId,
        eventId,
        OR: [{ status: { in: ['PENDING', 'SENDING'] } }, { status: 'FAILED', attempts: { lt: MAX_ATTEMPTS } }],
      },
    });
    if (waiting > 0) return;
    await this.prisma.notificationEvent.updateMany({
      where: { businessId, id: eventId, kind: 'CHANNEL_ON', payload: { not: Prisma.DbNull } },
      data: { payload: Prisma.DbNull },
    });
  }

  private async render({ businessId, eventId, audience, locale }: Claimed) {
    const event = await this.prisma.notificationEvent.findFirstOrThrow({
      where: { businessId, id: eventId },
      include: {
        appointment: {
          select: {
            clientName: true,
            staffId: true,
            staff: { select: { name: true } },
            group: { select: { title: true } },
            oneOffSession: { select: { title: true } },
            business: { select: { name: true, timeZone: true } },
          },
        },
      },
    });
    const { appointment } = event;
    const fromStaffId = fromStaffIdOf(event.payload);
    const fromStartsAt = fieldOf(event.payload, 'fromStartsAt');
    const manageLink = fieldOf(event.payload, 'manageLink');
    const previousMaster =
      fromStaffId === null || fromStaffId === appointment.staffId
        ? null
        : await this.prisma.staff.findFirst({ where: { businessId, id: fromStaffId }, select: { name: true } });
    return messageFor({
      kind: event.kind,
      audience: audience === 'client' ? 'client' : 'staff',
      locale: localeOf(locale),
      businessName: appointment.business.name,
      masterName: appointment.staff.name,
      title: appointment.group?.title ?? appointment.oneOffSession?.title ?? null,
      startsAt: event.startsAt,
      ...(fromStartsAt === null ? {} : { fromStartsAt: new Date(fromStartsAt) }),
      ...(previousMaster === null ? {} : { fromMasterName: previousMaster.name }),
      timeZone: appointment.business.timeZone,
      clientName: appointment.clientName,
      ...(event.offsetMinutes === null ? {} : { offsetMinutes: event.offsetMinutes }),
      ...(manageLink === null ? {} : { manageLink }),
    });
  }

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
      fallbackToLog: this.channels.fallbackToLog,
    };
  }
}
