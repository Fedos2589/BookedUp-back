import { AuthorizationService } from '@nestjs/authorization';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-types.js';
import { BusinessPolicy } from '../business/business.policy.js';
import type { MemberRole } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ChangeRoleInput, Member } from './members.schema.js';

const memberSelect = {
  userId: true,
  role: true,
  user: { select: { name: true, email: true } },
  staff: { select: { id: true } },
} as const;

const toMember = ({
  userId,
  role,
  user,
  staff,
}: {
  userId: string;
  role: MemberRole;
  user: { name: string; email: string };
  staff: { id: string } | null;
}): Member => ({ userId, ...user, role, staffId: staff?.id ?? null });

// Raised inside a transaction to roll it back when the member's role moved since it was checked.
class ChangedMeanwhile extends ConflictException {
  constructor() {
    super('This member was changed meanwhile; reload and try again');
  }
}

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
  ) {}

  async list(businessId: string): Promise<Member[]> {
    const members = await this.prisma.membership.findMany({
      where: { businessId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: memberSelect,
    });
    return members.map(toMember);
  }

  // Both the role they have and the one they get must be the actor's to manage (roles.ts).
  // The write is conditioned on the role that was checked, so a concurrent change can't slip
  // between the check and the update.
  async changeRole(actor: AuthUser, businessId: string, userId: string, { role }: ChangeRoleInput): Promise<Member> {
    const current = await this.roleOf(businessId, userId);
    await this.authorization.authorize(BusinessPolicy, 'manageRole', actor, businessId, current);
    await this.authorization.authorize(BusinessPolicy, 'manageRole', actor, businessId, role);

    const [member] = await this.prisma.membership.updateManyAndReturn({
      where: { businessId, userId, role: current },
      data: { role },
      select: { userId: true },
    });
    if (!member) throw new ChangedMeanwhile();
    return this.describe(businessId, userId);
  }

  // Their schedule stays, without an account: bookings (E6) still point at it. It is unlinked
  // first, in the same transaction, or the staff → memberships foreign key refuses the delete.
  async remove(actor: AuthUser, businessId: string, userId: string): Promise<void> {
    const current = await this.roleOf(businessId, userId);
    await this.authorization.authorize(BusinessPolicy, 'manageRole', actor, businessId, current);

    await this.prisma.$transaction(async (tx) => {
      await tx.staff.updateMany({ where: { businessId, userId }, data: { userId: null } });
      const { count } = await tx.membership.deleteMany({ where: { businessId, userId, role: current } });
      if (count === 0) throw new ChangedMeanwhile();
    });
  }

  private async roleOf(businessId: string, userId: string): Promise<MemberRole> {
    const membership = await this.prisma.membership.findUnique({
      where: { userId_businessId: { userId, businessId } },
      select: { role: true },
    });
    if (!membership) throw new NotFoundException();
    return membership.role;
  }

  private async describe(businessId: string, userId: string): Promise<Member> {
    return toMember(
      await this.prisma.membership.findUniqueOrThrow({
        where: { userId_businessId: { userId, businessId } },
        select: memberSelect,
      }),
    );
  }
}
