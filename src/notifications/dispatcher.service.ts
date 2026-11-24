import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { localeSchema } from '../account/locale.js';
import { appLink } from '../common/app-link.js';
import type { Env } from '../config/env.js';
import { type AppointmentStatus, type ChannelKind, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ChannelRegistry } from './channels/channel-registry.js';
import type { RenderInput, SendResult } from './channels/channel.js';
import type { MessageLocale } from './messages.js';
import { type Member, recipientsOf, type RecipientsContext, STAFF_KINDS } from './recipients.js';

const BATCH = 50;
const DISPATCH_BUDGET_MS = 20_000;

// The statuses of a booking that still expects its client (the same as the reminders').
const LIVE: readonly AppointmentStatus[] = ['BOOKED', 'CONFIRMED'];

// How long a FAILED delivery waits before its next try, by the number of tries so far: a provider that is down
// for a few minutes doesn't use up every try. After the last pause comes the last try; then it stays FAILED.
const RETRY_AFTER_MINUTES = [1, 10] as const;
const MAX_ATTEMPTS = RETRY_AFTER_MINUTES.length + 1;

const retryAt = (attempts: number, now: Date): Date | null => {
  const minutes = RETRY_AFTER_MINUTES[attempts - 1];
  return minutes === undefined ? null : new Date(now.getTime() + minutes * 60_000);
};

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
  // Tries so far, this one included.
  attempts: number;
};

type Outcome = SendResult | 'stale' | { error: string };

// A reminder whose booking was cancelled or moved after the event was written: not worth sending, not worth
// retrying (the new time has its own reminder).
class StaleReminder extends Error {}

type Event = Prisma.NotificationEventGetPayload<object>;

@Injectable()
export class DispatcherService {
  private readonly logger = new Logger(DispatcherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: ChannelRegistry,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // Batch after batch until a short one or the time is up, so a busy hour drains in one tick, not in many.
  // The budget keeps a tick shorter than the 30 s between ticks.
  async dispatch(now: Date): Promise<void> {
    const until = Date.now() + DISPATCH_BUDGET_MS;
    while ((await this.expand(now)) === BATCH && Date.now() < until);
    while ((await this.send(now)) === BATCH && Date.now() < until);
  }

  // Sends what is due, at most BATCH deliveries. A delivery is claimed (SENDING, attempts + 1) in a
  // transaction of its own, committed before any call to the outside: a crash in between leaves it SENDING,
  // and it is never picked again — a message twice is worse than a message lost (E9, decision 3).
  // Two runs at once claim different rows (SKIP LOCKED).
  async send(now: Date): Promise<number> {
    // The scan crosses businesses by design: the outbox is one queue for all of them.
    // Only the kinds this process has: a delivery of another kind (a channel configured elsewhere) is not its to
    // fail and burn the tries of.
    const kinds = this.channels.kinds();
    const claimed = await this.prisma.$queryRaw<Claimed[]>`
      UPDATE notification_deliveries SET status = 'SENDING', attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM notification_deliveries
        WHERE status IN ('PENDING', 'FAILED') AND attempts < ${MAX_ATTEMPTS}
          AND channel = ANY(${kinds}::"ChannelKind"[])
          AND (retry_at IS NULL OR retry_at <= ${now}::timestamptz)
        ORDER BY created_at, id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
      RETURNING id, business_id AS "businessId", event_id AS "eventId", channel, address, audience, locale, attempts`;
    for (const delivery of claimed) await this.deliver(delivery, now);
    return claimed.length;
  }

  // One delivery, start to finish; never throws, so one failure doesn't leave the rest of the claimed batch
  // SENDING for good. What happens to the row depends on how far it got:
  // - the message was not sent (render or channel failed): FAILED, tried again while attempts last;
  // - the message went out but the database refuses the record: the row stays SENDING and is never sent again
  //   (a message twice is worse than a message lost, decision 3), and the failure is in the log.
  private async deliver(delivery: Claimed, now: Date): Promise<void> {
    const outcome = await this.trySending(delivery);
    try {
      await this.record(delivery, outcome, now);
    } catch (error) {
      this.logger.error({ err: error, deliveryId: delivery.id }, 'Recording a delivery failed; it stays SENDING');
      return;
    }
    try {
      await this.wipePayloadIfOut(delivery.businessId, delivery.eventId);
    } catch (error) {
      this.logger.error(
        { err: error, eventId: delivery.eventId },
        'Wiping the manage link failed; it stays in the payload until the next delivery of the event',
      );
    }
  }

  private async trySending(delivery: Claimed): Promise<Outcome> {
    try {
      const input = await this.inputOf(delivery);
      const keys = delivery.channel === 'PUSH' ? await this.pushKeysOf(delivery) : undefined;
      // The client switched the subscription off after the message was queued: nothing to send, nothing to retry.
      if (keys === null) return 'stale';
      return await this.channels.get(delivery.channel).send(delivery.address, input, keys);
    } catch (error) {
      if (error instanceof StaleReminder) return 'stale';
      this.logger.warn({ err: error, deliveryId: delivery.id }, 'Sending a notification failed');
      return { error: error instanceof Error ? error.message : 'unknown error' };
    }
  }

  // A push subscription's keys sit with its channel row (a booking's, or a member's), not on the delivery; null when
  // no active row has them any more. The row is found by its address: the keys belong to the subscription, which
  // is the same under every row with that endpoint.
  private async pushKeysOf({ businessId, audience, address }: Claimed): Promise<Prisma.JsonValue | null> {
    const channel =
      audience === 'client'
        ? await this.prisma.clientChannel.findFirst({
            where: { businessId, kind: 'PUSH', address, disabledAt: null },
            select: { keys: true },
          })
        : await this.prisma.userChannel.findFirst({ where: { kind: 'PUSH', address }, select: { keys: true } });
    return channel?.keys ?? null;
  }

  // The delivery's own row, found by its business too.
  private async record(delivery: Claimed, outcome: Outcome, now: Date) {
    const { id, businessId } = delivery;
    const write = (data: Prisma.NotificationDeliveryUpdateManyMutationInput) =>
      this.prisma.notificationDelivery.updateMany({ where: { id, businessId }, data });
    if (outcome === 'sent') {
      await write({ status: 'SENT', sentAt: new Date(), lastError: null });
    } else if (outcome === 'unreachable' || outcome === 'stale') {
      await write({
        status: 'FAILED',
        attempts: MAX_ATTEMPTS,
        lastError: outcome === 'stale' ? 'booking changed' : outcome,
      });
    } else {
      await write({ status: 'FAILED', lastError: outcome.error, retryAt: retryAt(delivery.attempts, now) });
    }
    if (outcome === 'unreachable') await this.switchOff(delivery, now);
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

  // What the channel renders its message from.
  private async inputOf({ businessId, eventId, audience, locale }: Claimed): Promise<RenderInput> {
    const event = await this.prisma.notificationEvent.findFirstOrThrow({
      where: { businessId, id: eventId },
      include: {
        appointment: {
          select: {
            clientName: true,
            status: true,
            startsAt: true,
            staffId: true,
            staff: { select: { name: true } },
            group: { select: { title: true } },
            oneOffSession: { select: { title: true } },
            business: { select: { name: true, slug: true, timeZone: true } },
          },
        },
      },
    });
    const { appointment } = event;
    if (
      event.kind === 'REMINDER' &&
      !(LIVE.includes(appointment.status) && appointment.startsAt.getTime() === event.startsAt.getTime())
    ) {
      throw new StaleReminder();
    }
    const fromStaffId = fromStaffIdOf(event.payload);
    const fromStartsAt = fieldOf(event.payload, 'fromStartsAt');
    const manageLink = fieldOf(event.payload, 'manageLink');
    const previousMaster =
      fromStaffId === null || fromStaffId === appointment.staffId
        ? null
        : await this.prisma.staff.findFirst({ where: { businessId, id: fromStaffId }, select: { name: true } });
    // Where a tap on a push goes: a client to the business's page, staff to the calendar.
    const url = appLink(
      this.config.get('APP_URL', { infer: true }),
      audience === 'client' ? `book/${appointment.business.slug}` : 'calendar',
    );
    return {
      url,
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
    };
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
      isOn: (kind) => this.channels.isOn(kind),
      fallbackToLog: this.channels.fallbackToLog,
    };
  }
}
