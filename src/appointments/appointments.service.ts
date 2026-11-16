import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-types.js';
import { roleCan } from '../business/roles.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { violatedExclusion } from '../prisma/unique-violation.js';
import { addDays, dateOfWall, startOfDay, wallAt } from '../schedule/local-time.js';
import { withIsoTimes } from '../schedule/db-values.js';
import { ScheduleService } from '../schedule/schedule.service.js';
import { StaffService } from '../staff/staff.service.js';
import {
  type AppointmentDto,
  type AppointmentInput,
  type AppointmentsQuery,
  nextStatuses,
  type StatusInput,
} from './appointments.schema.js';

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

const statusConflict = (code: 'badTransition' | 'notStarted', message: string) =>
  new ConflictException({ statusCode: 409, error: 'Conflict', message, code });

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
    const rows = await this.prisma.appointment.findMany({
      where: {
        businessId,
        staffId,
        ...(!(membership && roleCan(membership.role, 'seeAllBookings')) && { staff: { userId: actor.id } }),
        ...(!includeCancelled && { status: { not: 'CANCELLED' } }),
        startsAt: {
          gte: new Date(startOfDay(timeZone, from)),
          lt: new Date(startOfDay(timeZone, addDays(to, 1))),
        },
      },
      select: appointmentSelect,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(withIsoTimes);
  }

  // Moves a booking along Decision 2's statuses. The update names the status it read, so two requests
  // racing over one booking can't both pass: the second finds it changed and gets the same 409.
  async changeStatus(
    actor: AuthUser,
    businessId: string,
    id: string,
    { status }: StatusInput,
    now: Date,
  ): Promise<AppointmentDto> {
    const current = await this.prisma.appointment.findFirst({
      where: { id, businessId },
      select: { staffId: true, status: true, startsAt: true },
    });
    if (!current) throw new NotFoundException();
    await this.staff.authorizeChangeOf(actor, businessId, current.staffId);
    if (!nextStatuses[current.status].includes(status)) {
      throw statusConflict('badTransition', `A booking that is ${current.status} can't become ${status}`);
    }
    if ((status === 'DONE' || status === 'NO_SHOW') && current.startsAt > now) {
      throw statusConflict('notStarted', 'The booking has not started yet');
    }
    const [updated] = await this.prisma.appointment.updateManyAndReturn({
      where: { id, businessId, staffId: current.staffId, status: current.status },
      data: { status },
      select: appointmentSelect,
    });
    if (!updated) throw statusConflict('badTransition', 'The status has just changed');
    return withIsoTimes(updated);
  }
}
