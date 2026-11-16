import { ConflictException, Injectable } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-types.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { violatedExclusion } from '../prisma/unique-violation.js';
import { addDays, dateOfWall, HOUR, instantOf, wallAt, wallOfDate } from '../schedule/local-time.js';
import { withIsoTimes } from '../schedule/db-values.js';
import { ScheduleService } from '../schedule/schedule.service.js';
import { StaffService } from '../staff/staff.service.js';
import type { AppointmentDto, AppointmentInput, AppointmentsQuery } from './appointments.schema.js';

const appointmentSelect = {
  id: true,
  staffId: true,
  startsAt: true,
  endsAt: true,
  status: true,
  clientName: true,
  clientPhone: true,
  note: true,
  groupId: true,
  oneOffSessionId: true,
} as const;

const notFree = () =>
  new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    message: 'This time is not free',
    code: 'notFree',
  });

const full = () =>
  new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    message: 'Every seat is taken',
    code: 'full',
  });

@Injectable()
export class AppointmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly staff: StaffService,
    private readonly schedule: ScheduleService,
  ) {}

  // Books exactly one free slot of the master. Two requests for one slot take turns on the lock of
  // the staff row, and the second finds the slot taken; the exclusion constraint in the database is
  // the guarantee behind that, and only its refusal is turned into the same clear answer.
  async create(
    actor: AuthUser,
    businessId: string,
    { staffId, startsAt, endsAt, groupId: seatGroup, oneOffSessionId: seatSession, ...client }: AppointmentInput,
    now: Date,
  ): Promise<AppointmentDto> {
    const groupId = seatGroup ?? null;
    const oneOffSessionId = seatSession ?? null;
    await this.staff.authorizeChangeOf(actor, businessId, staffId);
    const { timeZone } = await this.prisma.business.findUniqueOrThrow({
      where: { id: businessId },
      select: { timeZone: true },
    });
    // A slot belongs to the day it starts, on the business's clock.
    const date = dateOfWall(wallAt(timeZone, startsAt.getTime()));
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM staff WHERE id = ${staffId}::uuid AND business_id = ${businessId}::uuid FOR UPDATE`;
        const slots = await this.schedule.slots(businessId, { from: date, to: date, staffId }, now, tx);
        // The slot is the one meant: same start and end, and the same group or session (none: hours).
        const slot = slots.find(
          (each) =>
            each.groupId === groupId &&
            each.oneOffSessionId === oneOffSessionId &&
            each.startsAt === startsAt.toISOString() &&
            each.endsAt === endsAt.toISOString(),
        );
        if (!slot) throw notFree();
        if (slot.full) throw full();
        return tx.appointment.create({
          data: { businessId, staffId, startsAt, endsAt, groupId, oneOffSessionId, ...client },
          select: appointmentSelect,
        });
      });
      return withIsoTimes(created);
    } catch (error) {
      if (violatedExclusion(error) === 'Appointment') throw notFree();
      throw error;
    }
  }

  // Bookings that start on the days from..to of the business's clock, in the order of their start.
  // A master sees only their own: the `staffId` of another gives an empty list, not a 403.
  async list(
    actor: AuthUser,
    businessId: string,
    { from, to, staffId, includeCancelled }: AppointmentsQuery,
  ): Promise<AppointmentDto[]> {
    const [{ timeZone }, membership] = await Promise.all([
      this.prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { timeZone: true } }),
      this.prisma.membership.findUnique({
        where: { userId_businessId: { userId: actor.id, businessId } },
        select: { role: true },
      }),
    ]);
    // Where a local day begins; a midnight skipped by a clock change begins at the first hour that exists.
    const startOf = (date: string) => {
      const wall = wallOfDate(date);
      return new Date(instantOf(timeZone, wall) ?? instantOf(timeZone, wall + HOUR) ?? wall);
    };
    const rows = await this.prisma.appointment.findMany({
      where: {
        businessId,
        staffId,
        ...(membership?.role === 'MASTER' && { staff: { userId: actor.id } }),
        ...(!includeCancelled && { status: { not: 'CANCELLED' } }),
        startsAt: {
          gte: startOf(from),
          lt: startOf(addDays(to, 1)),
        },
      },
      select: appointmentSelect,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(withIsoTimes);
  }
}
