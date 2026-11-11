import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';

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
  constructor(private readonly prisma: PrismaService) {}

  // Archived ones too: the front shows them apart, and past bookings (E6) still name them.
  async list(businessId: string): Promise<StaffMember[]> {
    const staff = await this.prisma.staff.findMany({
      where: { businessId },
      orderBy: { createdAt: 'asc' },
      select: staffSelect,
    });
    return staff.map(toStaffMember);
  }

  // Whether `userId` is a member is the database's answer (the foreign key to memberships),
  // not a query before the insert that a concurrent removal could make stale.
  async create(businessId: string, input: CreateStaffInput): Promise<StaffMember> {
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
  async update(businessId: string, staffId: string, { name, archived }: UpdateStaffInput): Promise<StaffMember> {
    const [staff] = await this.prisma.staff.updateManyAndReturn({
      where: { id: staffId, businessId },
      data: { name, ...(archived !== undefined && { archivedAt: archived ? new Date() : null }) },
      select: staffSelect,
    });
    if (!staff) throw new NotFoundException();
    return toStaffMember(staff);
  }
}
