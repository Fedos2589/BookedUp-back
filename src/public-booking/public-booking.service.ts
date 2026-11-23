import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import type { PublicBusinessDto } from './public-booking.schema.js';

// What a visitor does without signing in. The slug is turned into the business's id once per
// request; every query after it carries that id.
@Injectable()
export class PublicBookingService {
  constructor(private readonly prisma: PrismaService) {}

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
}
