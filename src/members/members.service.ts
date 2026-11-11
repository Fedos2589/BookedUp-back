import { AuthorizationService } from '@nestjs/authorization';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-types.js';
import { BusinessPolicy } from '../business/business.policy.js';
import { rolesManagedBy } from '../business/roles.js';
import type { Prisma } from '../generated/prisma/client.js';
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

// Revokes what `userId` invited to `businessId` and is still pending, narrowed by `where`.
const revokeInvitationsBy = (
  tx: Prisma.TransactionClient,
  businessId: string,
  userId: string,
  where: Prisma.InvitationWhereInput = {},
) =>
  tx.invitation.updateMany({
    where: { ...where, businessId, invitedById: userId, acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });

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
  // between the check and the update. Their pending invitations as a role the new one may not
  // give are revoked with it: an invitation is as good as its inviter's right to give it.
  async changeRole(actor: AuthUser, businessId: string, userId: string, { role }: ChangeRoleInput): Promise<Member> {
    const current = await this.roleOf(businessId, userId);
    await this.authorization.authorize(BusinessPolicy, 'manageRole', actor, businessId, current);
    await this.authorization.authorize(BusinessPolicy, 'manageRole', actor, businessId, role);

    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.membership.updateMany({
        where: { businessId, userId, role: current },
        data: { role },
      });
      if (count === 0) throw new ChangedMeanwhile();
      await revokeInvitationsBy(tx, businessId, userId, { role: { notIn: [...rolesManagedBy(role)] } });
    });
    return this.describe(businessId, userId);
  }

  // Their schedule stays, without an account: bookings (E6) still point at it. It is unlinked
  // first, in the same transaction, or the staff → memberships foreign key refuses the delete.
  // The membership row is locked first: a schedule linked to them meanwhile (POST /staff) waits
  // for the delete and is then refused as not a member, instead of failing the delete with a 500.
  // Their pending invitations go with them, or a removed admin keeps a way back in.
  async remove(actor: AuthUser, businessId: string, userId: string): Promise<void> {
    const current = await this.roleOf(businessId, userId);
    await this.authorization.authorize(BusinessPolicy, 'manageRole', actor, businessId, current);

    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<unknown[]>`
        SELECT 1 FROM memberships
        WHERE business_id = ${businessId}::uuid AND user_id = ${userId}::uuid AND role = ${current}::member_role
        FOR UPDATE`;
      if (locked.length === 0) throw new ChangedMeanwhile();
      await tx.staff.updateMany({ where: { businessId, userId }, data: { userId: null } });
      await tx.membership.delete({ where: { userId_businessId: { userId, businessId } } });
      await revokeInvitationsBy(tx, businessId, userId);
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
