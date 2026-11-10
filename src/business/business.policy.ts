import { Can, Policy } from '@nestjs/authorization';
import type { Request } from 'express';
import { z } from 'zod';

import type { AuthUser } from '../auth/auth-types.js';
import { PrismaService } from '../prisma/prisma.service.js';

const uuid = z.uuid();

// Who may act inside a business. The multi-tenancy rule from AGENTS.md lives here: a route
// under /businesses/:businessId/ is reachable only by a member of that business.
@Policy()
export class BusinessPolicy {
  constructor(private readonly prisma: PrismaService) {}

  // A guest, an id that is not a UUID, a business that doesn't exist and someone else's
  // business all get the same `false`: the answer doesn't tell which ids exist.
  async member(user: AuthUser | null, businessId: string): Promise<boolean> {
    // Checked before the query: Postgres would refuse a non-UUID with an error, not a row.
    if (!user || !uuid.safeParse(businessId).success) return false;
    const membership = await this.prisma.membership.findUnique({
      where: { userId_businessId: { userId: user.id, businessId } },
      select: { id: true },
    });
    return membership !== null;
  }
}

// On every controller or route with a :businessId param. Without it, the global
// authorization guard denies the route anyway (a handler with no check is denied).
export const MemberOfBusiness = () =>
  Can(BusinessPolicy, 'member', (context) => [
    context.switchToHttp().getRequest<Request<{ businessId?: string }>>().params.businessId ?? '',
  ]);
