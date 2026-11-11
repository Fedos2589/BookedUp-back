import { AuthorizationService } from '@nestjs/authorization';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-types.js';
import { BusinessPolicy } from '../business/business.policy.js';

import { PrismaService } from '../prisma/prisma.service.js';
import { violatedForeignKey, violatedUniqueConstraint } from '../prisma/unique-violation.js';
import type { CreateStaffInput, StaffConflict, StaffMember, UpdateStaffInput } from './staff.schema.js';

const staffSelect = { id: true, name: true, userId: true, archivedAt: true } as const;

const toStaffMember = ({ archivedAt, ...staff }: { archivedAt: Date | null } & Omit<StaffMember, 'archived'>) => ({
  ...staff,
  archived: archivedAt !== null,
});

@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
  ) {}

  // Archived ones too: the front shows them apart, and past bookings (E6) still name them.
  // id breaks ties: rows added in one transaction share created_at (now() is its start), and
  // uuidv7 grows in the order they were inserted.
  async list(businessId: string): Promise<StaffMember[]> {
    const staff = await this.prisma.staff.findMany({
      where: { businessId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: staffSelect,
    });
    return staff.map(toStaffMember);
  }

  // Whether `userId` is a member is the database's answer (the foreign key to memberships),
  // not a query before the insert that a concurrent removal could make stale.
  async create(actor: AuthUser, businessId: string, input: CreateStaffInput): Promise<StaffMember> {
    await this.authorizeFor(actor, businessId, input.userId ?? null);
    try {
      return toStaffMember(await this.prisma.staff.create({ data: { businessId, ...input }, select: staffSelect }));
    } catch (error) {
      if (violatedForeignKey(error) === 'staff_user_id_business_id_fkey')
        throw new BadRequestException(['userId: Not a member of this business']);
      if (violatedUniqueConstraint(error) === 'staff_user_id_business_id_key') {
        const body: StaffConflict = {
          statusCode: 409,
          error: 'Conflict',
          message: 'This member already has a schedule',
          field: 'userId',
        };
        throw new ConflictException(body);
      }
      throw error;
    }
  }

  // Scoped by businessId: a staff id from another business is not found, not changed.
  // The date someone left is set once: archived: true on an archived row keeps it, so a form
  // that sends every field again doesn't move it. One transaction, no read before the write.
  async update(
    actor: AuthUser,
    businessId: string,
    staffId: string,
    { name, archived }: UpdateStaffInput,
  ): Promise<StaffMember> {
    const where = { id: staffId, businessId };
    await this.authorizeChangeOf(actor, businessId, staffId);

    const archive = this.prisma.staff.updateMany({
      where: { ...where, archivedAt: null },
      data: { archivedAt: new Date() },
    });
    const change = this.prisma.staff.updateManyAndReturn({
      where,
      data: { name, ...(archived === false && { archivedAt: null }) },
      select: staffSelect,
    });
    const [staff] = archived ? (await this.prisma.$transaction([archive, change]))[1] : await change;
    if (!staff) throw new NotFoundException();
    return toStaffMember(staff);
  }

  // Whether actor may change this schedule — the staff row itself or its windows and time off.
  // 404 when it is not this business's.
  async authorizeChangeOf(actor: AuthUser, businessId: string, staffId: string): Promise<void> {
    const staff = await this.prisma.staff.findFirst({ where: { id: staffId, businessId }, select: { userId: true } });
    if (!staff) throw new NotFoundException();
    await this.authorizeFor(actor, businessId, staff.userId);
  }

  // Whose schedule one may touch follows roles.ts: a member's counts as that member, one without
  // an account as a master, and one's own is always one's own. A userId that is no member is
  // left to the foreign key on create (400).
  private async authorizeFor(actor: AuthUser, businessId: string, userId: string | null): Promise<void> {
    if (userId === actor.id) return;
    const role = userId
      ? (
          await this.prisma.membership.findUnique({
            where: { userId_businessId: { userId, businessId } },
            select: { role: true },
          })
        )?.role
      : 'MASTER';
    if (role) await this.authorization.authorize(BusinessPolicy, 'manageRole', actor, businessId, role);
  }
}
