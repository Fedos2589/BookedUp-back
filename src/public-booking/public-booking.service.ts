import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { ScheduleService } from '../schedule/schedule.service.js';
import type { PublicSlotsQuery, SlotDto } from '../schedule/schedule.schema.js';
import type { PublicBusinessDto } from './public-booking.schema.js';

// What a visitor does without signing in. The slug is turned into the business's id once per
// request; every query after it carries that id.
@Injectable()
export class PublicBookingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly schedule: ScheduleService,
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
}
