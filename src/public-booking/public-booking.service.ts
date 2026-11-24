import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { MoveInput } from '../appointments/appointments.schema.js';
import { AppointmentsService, isNotFree, notFree, statusConflict } from '../appointments/appointments.service.js';
import { ClientsService } from '../clients/clients.service.js';
import { newRandomToken, hashRandomToken } from '../common/random-token.js';
import type { Env } from '../config/env.js';
import type { Locale } from '../account/locale.js';
import { ClientPushService } from '../notifications/client-push.service.js';
import { ClientWhatsappService } from '../notifications/client-whatsapp.service.js';
import type { PushOnInput } from '../notifications/push.schema.js';
import { LinkTokensService } from '../notifications/link-tokens.service.js';
import type { TelegramLinkDto } from '../notifications/link.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { addDays, dateOfWall, startOfDay, wallAt } from '../schedule/local-time.js';
import { holdsTime } from '../schedule/live-bookings.js';
import { ScheduleService } from '../schedule/schedule.service.js';
import type { PublicSlotsQuery, SlotDto } from '../schedule/schedule.schema.js';
import { orderMasters } from './pick-master.js';
import { canChange } from './can-change.js';
import { manageLink } from './manage-token.js';
import type {
  BusinessManifestDto,
  ManagedBookingDto,
  PublicBookingInput,
  PublicBookingResult,
  PublicBusinessDto,
} from './public-booking.schema.js';

// Bookings to come that hold time (not cancelled) that one phone may have at a business.
const MAX_AHEAD = 3;

// What a visitor does without signing in. The slug is turned into the business's id once per
// request; every query after it carries that id.
@Injectable()
export class PublicBookingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly schedule: ScheduleService,
    private readonly appointments: AppointmentsService,
    private readonly clients: ClientsService,
    private readonly linkTokens: LinkTokensService,
    private readonly push: ClientPushService,
    private readonly whatsapp: ClientWhatsappService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private async businessOf(slug: string): Promise<{ id: string; timeZone: string }> {
    const business = await this.prisma.business.findUnique({ where: { slug }, select: { id: true, timeZone: true } });
    if (!business) throw new NotFoundException();
    return business;
  }

  async businessIdOf(slug: string): Promise<string> {
    return (await this.businessOf(slug)).id;
  }

  async business(slug: string): Promise<PublicBusinessDto> {
    const business = await this.prisma.business.findUnique({
      where: { slug },
      select: {
        id: true,
        name: true,
        timeZone: true,
        staff: {
          where: { archivedAt: null },
          select: { id: true, name: true, scheduleMode: true },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
        },
      },
    });
    if (!business) throw new NotFoundException();
    return { name: business.name, slug, timeZone: business.timeZone, masters: business.staff };
  }

  // Colors and icons are copied from BookedUp-front vite.config.ts (VitePWA manifest); the icons are
  // absolute because this file is served under /api. Only the name, scope and start_url are the business's.
  async manifest(slug: string): Promise<BusinessManifestDto> {
    const business = await this.prisma.business.findUnique({ where: { slug }, select: { name: true } });
    if (!business) throw new NotFoundException();
    const { name } = business;
    const page = `/book/${slug}`;
    return {
      id: page,
      name,
      short_name: Array.from(name).slice(0, 12).join(''),
      start_url: page,
      scope: page,
      display: 'standalone',
      background_color: '#ffffff',
      theme_color: '#ffffff',
      icons: [
        { src: '/pwa-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/pwa-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    };
  }

  // What can still be booked, counts but no clients. A staffId of another business is filtered
  // out with the business's id, so it matches nothing.
  async slots(slug: string, query: PublicSlotsQuery): Promise<SlotDto[]> {
    const businessId = await this.businessIdOf(slug);
    return this.schedule.slots(businessId, query, new Date());
  }

  // Books a slot for whoever types a name and a phone: the master asked for, or without one, the
  // first free master in `orderMasters` order (one who gets taken meanwhile is skipped). The answer
  // is the same for a phone the business knows and for a new one. The limit is counted in the
  // booking's transaction, on the locked client, so two parallel bookings can't both pass it.
  async book(slug: string, { staffId, ...input }: PublicBookingInput): Promise<PublicBookingResult> {
    const { id: businessId, timeZone } = await this.businessOf(slug);
    const now = new Date();
    const token = newRandomToken();
    const masters = staffId ? [staffId] : await this.freeMasters(businessId, timeZone, input, now);
    const attempt = (master: string) => this.bookWith(businessId, { ...input, staffId: master }, token, now);
    let booked: Awaited<ReturnType<typeof attempt>> | undefined;
    for (const master of masters) {
      try {
        booked = await attempt(master);
        break;
      } catch (error) {
        if (!isNotFree(error)) throw error;
      }
    }
    if (!booked) throw notFree();
    const { appointment, title } = booked;
    const staff = await this.prisma.staff.findFirstOrThrow({
      where: { id: appointment.staffId, businessId },
      select: { name: true },
    });
    return {
      booking: {
        id: appointment.id,
        staffId: appointment.staffId,
        staffName: staff.name,
        startsAt: appointment.startsAt,
        endsAt: appointment.endsAt,
        title,
        groupId: appointment.groupId,
        oneOffSessionId: appointment.oneOffSessionId,
      },
      manageLink: manageLink(this.config.get('APP_URL', { infer: true }), slug, token),
    };
  }

  // The booking the token belongs to, with the business it is in; every later query carries that id.
  private async managedBy(token: string, now: Date): Promise<ManagedBookingDto> {
    return this.managedAt(await this.idsOf(token), now);
  }

  private async managedAt(found: { id: string; businessId: string }, now: Date): Promise<ManagedBookingDto> {
    const row = await this.prisma.appointment.findFirstOrThrow({
      where: { id: found.id, businessId: found.businessId },
      select: {
        startsAt: true,
        endsAt: true,
        status: true,
        staffId: true,
        groupId: true,
        oneOffSessionId: true,
        staff: { select: { name: true } },
        group: { select: { title: true } },
        oneOffSession: { select: { title: true } },
        business: { select: { name: true, slug: true, timeZone: true } },
      },
    });
    return {
      business: row.business,
      booking: {
        staffId: row.staffId,
        staffName: row.staff.name,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
        title: row.group?.title ?? row.oneOffSession?.title ?? null,
        status: row.status,
        groupId: row.groupId,
        oneOffSessionId: row.oneOffSessionId,
      },
      canChange: canChange(row, now),
    };
  }

  async managed(token: string): Promise<ManagedBookingDto> {
    return this.managedBy(token, new Date());
  }

  // A link that connects the booker's Telegram to this booking, while the booking can still change.
  async telegramLink(token: string, locale: Locale): Promise<TelegramLinkDto> {
    const found = await this.idsOf(token);
    const managed = await this.managedAt(found, new Date());
    if (!managed.canChange) throw statusConflict('badTransition', 'The booking can no longer change');
    return this.linkTokens.issue(
      {
        businessId: found.businessId,
        appointmentId: found.id,
        manageLink: manageLink(this.config.get('APP_URL', { infer: true }), managed.business.slug, token),
      },
      locale,
    );
  }

  // The booker's browser takes pushes for this booking, while it can still change. The same subscription twice
  // is one channel; one that was switched off comes back on.
  async pushOn(token: string, { subscription, locale }: PushOnInput): Promise<void> {
    this.push.assertOn();
    const { id, businessId, slug } = await this.idsOf(token);
    await this.push.turnOn(
      { id, businessId },
      subscription,
      locale,
      manageLink(this.config.get('APP_URL', { infer: true }), slug, token),
    );
  }

  // Only this booking's subscription: another booking's, with the same endpoint, is not touched.
  async pushOff(token: string, endpoint: string): Promise<void> {
    const { id, businessId } = await this.idsOf(token);
    await this.push.turnOff(businessId, id, endpoint, new Date());
  }

  // The booker's WhatsApp takes messages for every booking of their phone, while this one can still change.
  async whatsappOn(token: string, locale: Locale): Promise<void> {
    this.whatsapp.assertOn();
    const { id, businessId, slug } = await this.idsOf(token);
    await this.whatsapp.turnOn(
      { id, businessId },
      locale,
      manageLink(this.config.get('APP_URL', { infer: true }), slug, token),
    );
  }

  async whatsappOff(token: string): Promise<void> {
    await this.whatsapp.turnOff(await this.idsOf(token), new Date());
  }

  // The booking's ids, and its business's slug (the manage link needs it).
  private async idsOf(token: string): Promise<{ id: string; businessId: string; slug: string }> {
    const found = await this.prisma.appointment.findUnique({
      where: { manageTokenHash: hashRandomToken(token) },
      select: { id: true, businessId: true, business: { select: { slug: true } } },
    });
    if (!found) throw new NotFoundException();
    return { id: found.id, businessId: found.businessId, slug: found.business.slug };
  }

  async cancel(token: string): Promise<ManagedBookingDto> {
    const now = new Date();
    const { id, businessId } = await this.idsOf(token);
    await this.appointments.cancelOnline(businessId, id, now);
    return this.managedBy(token, now);
  }

  // Another slot, the same master's unless `staffId` says otherwise; the checks are booking's.
  async move(token: string, input: MoveInput): Promise<ManagedBookingDto> {
    const now = new Date();
    const { id, businessId } = await this.idsOf(token);
    await this.appointments.moveOnline(businessId, id, input, now);
    return this.managedBy(token, now);
  }

  private bookWith(
    businessId: string,
    input: Omit<PublicBookingInput, 'staffId'> & { staffId: string },
    token: string,
    now: Date,
  ) {
    return this.appointments.bookOnline(
      businessId,
      { ...input, manageTokenHash: hashRandomToken(token) },
      now,
      async (tx) => {
        const who = await this.clients.resolveByPhone(tx, businessId, input);
        const ahead = await tx.appointment.count({
          where: { businessId, clientId: who.clientId, ...holdsTime, startsAt: { gt: now } },
        });
        if (ahead >= MAX_AHEAD) {
          throw new ConflictException({
            statusCode: 409,
            error: 'Conflict',
            message: 'Too many bookings to come for this phone',
            code: 'tooManyBookings',
          });
        }
        return who;
      },
    );
  }

  // The masters with an hours slot of exactly this time free now, the one to try first at the head.
  private async freeMasters(
    businessId: string,
    timeZone: string,
    { startsAt, endsAt }: { startsAt: Date; endsAt: Date },
    now: Date,
  ): Promise<string[]> {
    const date = dateOfWall(wallAt(timeZone, startsAt.getTime()));
    const slots = await this.schedule.slots(businessId, { from: date, to: date }, now);
    const free = slots.filter(
      (slot) =>
        !slot.groupId &&
        !slot.oneOffSessionId &&
        slot.startsAt === startsAt.toISOString() &&
        slot.endsAt === endsAt.toISOString(),
    );
    if (free.length === 0) return [];
    const staffIds = free.map((slot) => slot.staffId);
    const dayStart = new Date(startOfDay(timeZone, date));
    const dayEnd = new Date(startOfDay(timeZone, addDays(date, 1)));
    const [staff, counts] = await Promise.all([
      this.prisma.staff.findMany({ where: { businessId, id: { in: staffIds } }, select: { id: true, name: true } }),
      this.prisma.appointment.groupBy({
        by: ['staffId'],
        where: { businessId, staffId: { in: staffIds }, ...holdsTime, startsAt: { gte: dayStart, lt: dayEnd } },
        _count: true,
      }),
    ]);
    const bookings = new Map(counts.map((row) => [row.staffId, row._count]));
    return orderMasters(staff.map(({ id, name }) => ({ staffId: id, name, bookings: bookings.get(id) ?? 0 })));
  }
}
