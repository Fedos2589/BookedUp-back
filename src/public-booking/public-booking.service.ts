import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AppointmentsService } from '../appointments/appointments.service.js';
import { ClientsService } from '../clients/clients.service.js';
import { newRandomToken, hashRandomToken } from '../common/random-token.js';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { addDays, dateOfWall, startOfDay, wallAt } from '../schedule/local-time.js';
import { holdsTime } from '../schedule/live-bookings.js';
import { ScheduleService } from '../schedule/schedule.service.js';
import type { PublicSlotsQuery, SlotDto } from '../schedule/schedule.schema.js';
import { orderMasters } from './pick-master.js';
import { manageLink } from './manage-token.js';
import type { PublicBookingInput, PublicBookingResult, PublicBusinessDto } from './public-booking.schema.js';

const notFree = () =>
  new ConflictException({ statusCode: 409, error: 'Conflict', message: 'This time is not free', code: 'notFree' });

const isConflict = (error: unknown, code: string) =>
  error instanceof ConflictException && (error.getResponse() as { code?: string }).code === code;

// Live bookings still to come that one phone may hold at a business.
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
        if (!isConflict(error, 'notFree')) throw error;
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
