import { ForbiddenException, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { businessSelect, type MemberBusiness } from './business.schema.js';

@Injectable()
export class BusinessService {
  constructor(private readonly prisma: PrismaService) {}

  // The business and the user's role in it, read through the membership: the query is
  // scoped to this user, not only the guard in front of it.
  async describe(userId: string, businessId: string): Promise<MemberBusiness> {
    const membership = await this.prisma.membership.findUnique({
      where: { userId_businessId: { userId, businessId } },
      select: { role: true, business: { select: businessSelect } },
    });
    // Removed from the business between the guard and here.
    if (!membership) throw new ForbiddenException();
    return { ...membership.business, role: membership.role };
  }
}
