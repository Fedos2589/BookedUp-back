import { Can, Policy } from '@nestjs/authorization';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';

import type { AuthUser } from '../auth/auth-types.js';
import type { MemberRole } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type BusinessAbility, roleCan, roleManages } from './roles.js';

const uuid = z.uuid();

// Who may act inside a business. The multi-tenancy rule from AGENTS.md lives here: a route
// under /businesses/:businessId/ is reachable only by a member of that business.
@Policy()
export class BusinessPolicy {
  constructor(private readonly prisma: PrismaService) {}

  // A guest, an id that is not a UUID, a business that doesn't exist and someone else's
  // business all get the same `false`: the answer doesn't tell which ids exist.
  async member(user: AuthUser | null, businessId: string): Promise<boolean> {
    return (await this.roleOf(user, businessId)) !== null;
  }

  // Abilities by role (roles.ts). Each runs after `member` on its route, so a stranger is
  // refused by the membership check, never by one of these.
  async manageTeam(user: AuthUser | null, businessId: string): Promise<boolean> {
    const role = await this.roleOf(user, businessId);
    return role !== null && roleCan(role, 'manageTeam');
  }

  // Whether the user may invite someone as `target`, or change or remove a member who is one.
  // The role comes from the request or the row, so services call it through
  // AuthorizationService.authorize(), after the route's manageTeam.
  async manageRole(user: AuthUser | null, businessId: string, target: MemberRole): Promise<boolean> {
    const role = await this.roleOf(user, businessId);
    return role !== null && roleManages(role, target);
  }

  private async roleOf(user: AuthUser | null, businessId: string): Promise<MemberRole | null> {
    // Checked before the query: Postgres would refuse a non-UUID with an error, not a row.
    if (!user || !uuid.safeParse(businessId).success) return null;
    const membership = await this.prisma.membership.findUnique({
      where: { userId_businessId: { userId: user.id, businessId } },
      select: { role: true },
    });
    return membership?.role ?? null;
  }
}

// The route's :businessId, as the arguments of a BusinessPolicy ability.
const businessIdParam = (context: ExecutionContext) => {
  const { businessId } = context.switchToHttp().getRequest<Request<{ businessId?: string }>>().params;
  // A programmer's mistake (`:id` instead of `:businessId`): a 500 with this in the log, not
  // a 403 that looks like a stranger's.
  if (businessId === undefined) throw new Error('A BusinessPolicy check on a route without a :businessId param');
  return [businessId] as const;
};

// On every controller under /businesses/:businessId. Without it, the global authorization
// guard denies the route anyway (a handler with no check is denied).
export const MemberOfBusiness = () => Can(BusinessPolicy, 'member', businessIdParam);

// On a method of a @MemberOfBusiness() controller: the class's check runs first, then this one.
export const MayInBusiness = (ability: BusinessAbility) => Can(BusinessPolicy, ability, businessIdParam);
