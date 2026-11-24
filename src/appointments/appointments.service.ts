import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { AppointmentStatus } from '../generated/prisma/enums.js';

import type { AuthUser } from '../auth/auth-types.js';
import { BusinessPolicy } from '../business/business.policy.js';
import { ClientsService } from '../clients/clients.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { recordEvent } from '../notifications/notification-events.js';
import { violatedExclusion } from '../prisma/unique-violation.js';
import { addDays, dateOfWall, type LocalDate, startOfDay, todayIn, wallAt } from '../schedule/local-time.js';
import { withIsoTimes } from '../schedule/db-values.js';
import { ScheduleService } from '../schedule/schedule.service.js';
import { StaffService } from '../staff/staff.service.js';
import { appointmentSelect } from './appointments.select.js';
import {
  type AppointmentDto,
  type AppointmentInput,
  type AppointmentsQuery,
  type MoveInput,
  nextStatuses,
  type StatusInput,
} from './appointments.schema.js';

const NOT_FREE = 'notFree';

export const notFree = () =>
  new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    message: 'This time is not free',
    code: NOT_FREE,
  });

export const isNotFree = (error: unknown) =>
  error instanceof ConflictException && (error.getResponse() as { code?: string }).code === NOT_FREE;

const full = () =>
  new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    message: 'Every seat is taken',
    code: 'full',
  });

// The slot to book and what is written on it.
export type SlotBooking = {
  staffId: string;
  startsAt: Date;
  endsAt: Date;
  groupId?: string | undefined;
  oneOffSessionId?: string | undefined;
  note?: string | null | undefined;
};

// Finds or makes the person in the booking's transaction.
export type Person = (
  tx: Prisma.TransactionClient,
) => Promise<{ clientId: string; clientName: string; clientPhone: string }>;

export const statusConflict = (code: 'badTransition' | 'notStarted', message: string) =>
  new ConflictException({ statusCode: 409, error: 'Conflict', message, code });

@Injectable()
export class AppointmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly staff: StaffService,
    private readonly schedule: ScheduleService,
    private readonly policy: BusinessPolicy,
    private readonly clients: ClientsService,
  ) {}

  // Books exactly one free slot of the master, ahead of its start.
  create(actor: AuthUser, businessId: string, input: AppointmentInput, now: Date): Promise<AppointmentDto> {
    return this.take(actor, businessId, input, now, 'ahead');
  }

  // Someone who came to a meeting without a booking: a seat in a meeting that has started today,
  // straight as DONE, and past `capacity` if need be — capacity limits booking ahead, not people
  // already in the room. Only today: a day gone by is rebuilt from today's schedule, not what was.
  walkIn(actor: AuthUser, businessId: string, input: AppointmentInput, now: Date): Promise<AppointmentDto> {
    return this.take(actor, businessId, input, now, 'walkIn');
  }

  // Two requests for one slot take turns on the lock of the staff row, and the second finds the slot
  // taken; the exclusion constraint in the database is the guarantee behind that, and only its
  // refusal is turned into the same clear answer.
  private async take(
    actor: AuthUser,
    businessId: string,
    {
      staffId,
      startsAt,
      endsAt,
      groupId: seatGroup,
      oneOffSessionId: seatSession,
      clientId,
      newClient,
      note,
    }: AppointmentInput,
    now: Date,
    mode: 'ahead' | 'walkIn',
  ): Promise<AppointmentDto> {
    await this.staff.authorizeChangeOf(actor, businessId, staffId);
    const { appointment } = await this.book(
      businessId,
      actor.id,
      { staffId, startsAt, endsAt, groupId: seatGroup, oneOffSessionId: seatSession, note },
      now,
      mode,
      // The person, found or made in this transaction: neither is left if the slot turns out taken.
      (tx) => this.clients.resolveForBooking(tx, businessId, newClient ? { newClient } : { clientId: clientId! }),
    );
    return appointment;
  }

  // Someone who booked on the business's page: no account, no actor. The same lock, slot and seat
  // checks as the cabinet; the person comes from `person`, which runs in the booking's transaction
  // (the phone's client, the limit on bookings). Only ahead of the start.
  bookOnline(
    businessId: string,
    input: SlotBooking & { manageTokenHash: string },
    now: Date,
    person: Person,
  ): Promise<{ appointment: AppointmentDto; title: string | null }> {
    return this.book(businessId, null, input, now, 'ahead', person);
  }

  private async book(
    businessId: string,
    actorUserId: string | null,
    {
      staffId,
      startsAt,
      endsAt,
      groupId: seatGroup,
      oneOffSessionId: seatSession,
      note,
      manageTokenHash,
    }: SlotBooking & { manageTokenHash?: string },
    now: Date,
    mode: 'ahead' | 'walkIn',
    person: Person,
  ): Promise<{ appointment: AppointmentDto; title: string | null }> {
    const groupId = seatGroup ?? null;
    const oneOffSessionId = seatSession ?? null;
    const { timeZone } = await this.prisma.business.findUniqueOrThrow({
      where: { id: businessId },
      select: { timeZone: true },
    });
    // A slot belongs to the day it starts, on the business's clock.
    const date = dateOfWall(wallAt(timeZone, startsAt.getTime()));
    if (mode === 'walkIn' && date !== todayIn(timeZone, now)) throw notFree();
    // Booking ahead is offered what is still to come; a walk-in, the whole day it came on.
    const notBefore = mode === 'walkIn' ? new Date(startOfDay(timeZone, date)) : now;
    try {
      const { created, title } = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM staff WHERE id = ${staffId}::uuid AND business_id = ${businessId}::uuid FOR UPDATE`;
        const slot = await this.findSlot(
          tx,
          businessId,
          { staffId, startsAt, endsAt, groupId, oneOffSessionId },
          date,
          notBefore,
        );
        // Only a real meeting can be told "book a seat instead"; a time that is none is just not free.
        if (mode === 'walkIn' && startsAt > now) {
          throw statusConflict('notStarted', 'The meeting has not started yet: book a seat instead');
        }
        if (mode === 'ahead' && slot.full) throw full();
        const who = await person(tx);
        const created = await tx.appointment.create({
          data: {
            businessId,
            ...who,
            staffId,
            startsAt,
            endsAt,
            groupId,
            oneOffSessionId,
            note,
            manageTokenHash,
            ...(mode === 'walkIn' && { status: 'DONE' }),
          },
          select: appointmentSelect,
        });
        // Someone who came without a booking has already been served: nobody is told.
        if (mode === 'ahead') {
          await recordEvent(tx, {
            businessId,
            appointmentId: created.id,
            kind: 'BOOKED',
            actorUserId,
            startsAt,
          });
        }
        return { created, title: slot.title };
      });
      return { appointment: withIsoTimes(created), title };
    } catch (error) {
      if (violatedExclusion(error) === 'Appointment') throw notFree();
      throw error;
    }
  }

  // The slot meant: same master, start and end, and the same group or session (none: hours). A booking
  // being moved (`exceptId`) doesn't hold its own time or seat.
  private async findSlot(
    tx: Prisma.TransactionClient,
    businessId: string,
    want: { staffId: string; startsAt: Date; endsAt: Date; groupId: string | null; oneOffSessionId: string | null },
    date: LocalDate,
    notBefore: Date,
    exceptId?: string,
  ) {
    const slots = await this.schedule.slots(
      businessId,
      { from: date, to: date, staffId: want.staffId },
      notBefore,
      tx,
      exceptId,
    );
    const slot = slots.find(
      (each) =>
        each.groupId === want.groupId &&
        each.oneOffSessionId === want.oneOffSessionId &&
        each.startsAt === want.startsAt.toISOString() &&
        each.endsAt === want.endsAt.toISOString(),
    );
    if (!slot) throw notFree();
    return slot;
  }

  // Moves a BOOKED or CONFIRMED booking to another slot, the same master's or another's, by the same
  // checks as booking, in one transaction. Both masters' rows are locked in id order, so two moves
  // across the same two masters can't deadlock and two moves into one slot take turns.
  async move(actor: AuthUser, businessId: string, id: string, input: MoveInput, now: Date): Promise<AppointmentDto> {
    const current = await this.prisma.appointment.findFirst({ where: { id, businessId }, select: { staffId: true } });
    if (!current) throw new NotFoundException();
    await this.staff.authorizeChangeOf(actor, businessId, current.staffId);
    if (input.staffId && input.staffId !== current.staffId) {
      await this.staff.authorizeChangeOf(actor, businessId, input.staffId);
    }
    return this.relocate(businessId, actor.id, id, current.staffId, input, now, false);
  }

  // The booker moves what they booked online, until it starts: no actor, the business is the token's.
  async moveOnline(businessId: string, id: string, input: MoveInput, now: Date): Promise<AppointmentDto> {
    const current = await this.prisma.appointment.findFirst({ where: { id, businessId }, select: { staffId: true } });
    if (!current) throw new NotFoundException();
    return this.relocate(businessId, null, id, current.staffId, input, now, true);
  }

  private async relocate(
    businessId: string,
    actorUserId: string | null,
    id: string,
    currentStaffId: string,
    { staffId: target, startsAt, endsAt, groupId: seatGroup, oneOffSessionId: seatSession }: MoveInput,
    now: Date,
    notStartedOnly: boolean,
  ): Promise<AppointmentDto> {
    const current = { staffId: currentStaffId };
    const staffId = target ?? current.staffId;
    const { timeZone } = await this.prisma.business.findUniqueOrThrow({
      where: { id: businessId },
      select: { timeZone: true },
    });
    const date = dateOfWall(wallAt(timeZone, startsAt.getTime()));
    const lock = [...new Set([current.staffId, staffId])].sort();
    try {
      const moved = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM staff WHERE id IN (${Prisma.join(lock.map((each) => Prisma.sql`${each}::uuid`))}) AND business_id = ${businessId}::uuid ORDER BY id FOR UPDATE`;
        // Read again under the lock, still with the master it was authorized on: a status change or a
        // move to another master that got in first is seen. A move to another time with the same master
        // waited for this lock and is simply moved on from.
        const booking = await tx.appointment.findFirst({
          where: { id, businessId, staffId: current.staffId },
          select: { status: true, startsAt: true },
        });
        if (!booking) throw statusConflict('badTransition', 'The booking has just changed');
        const stays = booking.startsAt.getTime() === startsAt.getTime() && current.staffId === staffId;
        if (notStartedOnly && booking.startsAt <= now) {
          throw statusConflict('badTransition', 'The booking has already started');
        }
        if (booking.status !== 'BOOKED' && booking.status !== 'CONFIRMED') {
          throw statusConflict('badTransition', `A booking that is ${booking.status} can't be moved`);
        }
        const groupId = seatGroup ?? null;
        const oneOffSessionId = seatSession ?? null;
        const slot = await this.findSlot(
          tx,
          businessId,
          { staffId, startsAt, endsAt, groupId, oneOffSessionId },
          date,
          now,
          id,
        );
        if (slot.full) throw full();
        // A status change takes no staff lock, so it may have got in since the read: the update still
        // asks for a booking that can be moved. Confirming it meanwhile doesn't stop the move.
        const [moved] = await tx.appointment.updateManyAndReturn({
          where: { id, businessId, staffId: current.staffId, status: { in: ['BOOKED', 'CONFIRMED'] } },
          data: { staffId, startsAt, endsAt, groupId, oneOffSessionId },
          select: appointmentSelect,
        });
        if (!moved) throw statusConflict('badTransition', 'The booking has just changed');
        // A save that changes nothing (a double click) is no news for anyone.
        if (!stays) {
          await recordEvent(tx, {
            businessId,
            appointmentId: id,
            kind: 'MOVED',
            actorUserId,
            startsAt,
            payload: { fromStaffId: current.staffId, fromStartsAt: booking.startsAt.toISOString() },
          });
        }
        return moved;
      });
      return withIsoTimes(moved);
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
    const [{ timeZone }, seeAll] = await Promise.all([
      this.prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { timeZone: true } }),
      this.policy.seeAllBookings(actor, businessId),
    ]);
    const rows = await this.prisma.appointment.findMany({
      where: {
        businessId,
        staffId,
        ...(!seeAll && { staff: { userId: actor.id } }),
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
    return this.transition(businessId, actor.id, id, current, status, now);
  }

  // The booker cancels what they booked online, until it starts. Same rule and same conditional
  // update as the cabinet's status change; the booker is no actor, the business is the token's.
  async cancelOnline(businessId: string, id: string, now: Date): Promise<AppointmentDto> {
    const current = await this.prisma.appointment.findFirst({
      where: { id, businessId },
      select: { staffId: true, status: true, startsAt: true },
    });
    if (!current) throw new NotFoundException();
    if (current.startsAt <= now) throw statusConflict('badTransition', 'The booking has already started');
    return this.transition(businessId, null, id, current, 'CANCELLED', now);
  }

  private async transition(
    businessId: string,
    actorUserId: string | null,
    id: string,
    current: { staffId: string; status: AppointmentStatus; startsAt: Date },
    status: AppointmentStatus,
    now: Date,
  ): Promise<AppointmentDto> {
    if (!nextStatuses[current.status].includes(status)) {
      throw statusConflict('badTransition', `A booking that is ${current.status} can't become ${status}`);
    }
    if ((status === 'DONE' || status === 'NO_SHOW') && current.startsAt > now) {
      throw statusConflict('notStarted', 'The booking has not started yet');
    }
    // The update and the event are one transaction; only a cancel is told, DONE and NO_SHOW happened.
    const updated = await this.prisma.$transaction(async (tx) => {
      const [changed] = await tx.appointment.updateManyAndReturn({
        where: { id, businessId, staffId: current.staffId, status: current.status },
        data: { status },
        select: appointmentSelect,
      });
      if (changed && status === 'CANCELLED') {
        await recordEvent(tx, {
          businessId,
          appointmentId: id,
          kind: 'CANCELLED',
          actorUserId,
          // From the row just updated: a move that got in since the read has changed the start.
          startsAt: changed.startsAt,
        });
      }
      return changed;
    });
    if (!updated) throw statusConflict('badTransition', 'The booking has just changed');
    return withIsoTimes(updated);
  }
}
