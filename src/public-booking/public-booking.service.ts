import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AppointmentsService } from '../appointments/appointments.service.js';
import { ClientsService } from '../clients/clients.service.js';
import { newRandomToken, hashRandomToken } from '../common/random-token.js';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { holdsTime } from '../schedule/live-bookings.js';
import { ScheduleService } from '../schedule/schedule.service.js';
import type { PublicSlotsQuery, SlotDto } from '../schedule/schedule.schema.js';
import { manageLink } from './manage-token.js';
import type { PublicBookingInput, PublicBookingResult, PublicBusinessDto } from './public-booking.schema.js';

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

  async businessIdOf(slug: string): Promise<string> {
    const business = await this.prisma.business.findUnique({ where: { slug }, select: { id: true } });
    if (!business) throw new NotFoundException();
    return business.id;
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

  // Books a slot for whoever types a name and a phone. The answer is the same for a phone the
  // business knows and for a new one. The limit is counted in the booking's transaction, on the
  // locked client, so two parallel bookings can't both pass it.
  async book(slug: string, input: PublicBookingInput): Promise<PublicBookingResult> {
    const businessId = await this.businessIdOf(slug);
    const now = new Date();
    const token = newRandomToken();
    const { appointment, title } = await this.appointments.bookOnline(
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
}
