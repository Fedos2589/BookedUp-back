import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-types.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { violatedExclusion } from '../prisma/unique-violation.js';
import { StaffService } from '../staff/staff.service.js';
import { dateColumn, localDateOf, refusePastDate, todayOfBusiness, withIsoTimes } from './db-values.js';
import { type Conflict, groupConflict, type GroupsSchedule, sessionConflict } from './group-conflicts.js';
import type { GroupDto, GroupInput, OneOffSessionDto, OneOffSessionInput, ScheduleConflict } from './groups.schema.js';
import { addDays, DAY, isoWeekday, type LocalDate, todayIn } from './local-time.js';

const groupSelect = {
  id: true,
  staffId: true,
  title: true,
  description: true,
  weekdays: true,
  startMinute: true,
  durationMinutes: true,
  capacity: true,
} as const;

const sessionSelect = {
  id: true,
  title: true,
  description: true,
  startsAt: true,
  endsAt: true,
  capacity: true,
} as const;

type Tx = Prisma.TransactionClient;

const conflictError = (field: ScheduleConflict['field'], conflictsWith: Conflict) => {
  const when =
    conflictsWith.kind === 'oneOffSession'
      ? ` at ${conflictsWith.startsAt}`
      : conflictsWith.date
        ? ` on ${conflictsWith.date}`
        : '';
  const body: ScheduleConflict = {
    statusCode: 409,
    error: 'Conflict',
    message: `Overlaps «${conflictsWith.title}»${when}`,
    field,
    conflictsWith,
  };
  return new ConflictException(body);
};

// Groups mode: groups, the dates they don't meet, one-off sessions. A master runs one at a time,
// so every write that could make two overlap takes the staff row's lock, writes, and checks the
// result with what is now there: a conflict throws and the transaction takes the write back.
// Two writes for one master take turns; sessions among themselves are also the EXCLUDE's.
@Injectable()
export class GroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly staff: StaffService,
  ) {}

  async groups(businessId: string, staffId: string, now: Date): Promise<GroupDto[]> {
    await this.staff.findIn(businessId, staffId);
    return this.findGroups({ businessId, staffId }, now);
  }

  async addGroup(
    actor: AuthUser,
    businessId: string,
    staffId: string,
    input: GroupInput,
    now: Date,
  ): Promise<GroupDto> {
    await this.staff.authorizeChangeOf(actor, businessId, staffId);
    const id = await this.underLock(businessId, staffId, now, async (tx, check) => {
      const group = await tx.group.create({ data: { businessId, staffId, ...input }, select: groupSelect });
      await check((schedule, timeZone) => groupConflict(group, schedule, timeZone, now), 'startMinute');
      return group.id;
    });
    return this.groupOf(businessId, staffId, id, now);
  }

  async updateGroup(
    actor: AuthUser,
    businessId: string,
    staffId: string,
    groupId: string,
    input: GroupInput,
    now: Date,
  ): Promise<GroupDto> {
    await this.staff.authorizeChangeOf(actor, businessId, staffId);
    await this.underLock(businessId, staffId, now, async (tx, check) => {
      const [group] = await tx.group.updateManyAndReturn({
        where: { id: groupId, businessId, staffId },
        data: input,
        select: groupSelect,
      });
      if (!group) throw new NotFoundException();
      // A cancelled day it no longer meets on would show on its card, and come back to life if
      // that weekday ever returned.
      await tx.$executeRaw`
        DELETE FROM group_cancellations
        WHERE business_id = ${businessId}::uuid AND group_id = ${groupId}::uuid
          AND NOT (EXTRACT(ISODOW FROM date)::smallint = ANY (${group.weekdays}::smallint[]))`;
      await check((schedule, timeZone) => groupConflict(group, schedule, timeZone, now), 'startMinute');
    });
    return this.groupOf(businessId, staffId, groupId, now);
  }

  async removeGroup(actor: AuthUser, businessId: string, staffId: string, groupId: string): Promise<void> {
    await this.staff.authorizeChangeOf(actor, businessId, staffId);
    const { count } = await this.prisma.group.deleteMany({ where: { id: groupId, businessId, staffId } });
    if (count === 0) throw new NotFoundException();
  }

  // Idempotent: cancelling a cancelled date changes nothing. Only a day the group meets — read
  // under the lock, so a change of its weekdays (which drops such cancellations) can't slip
  // between the check and the insert.
  async cancelDate(
    actor: AuthUser,
    businessId: string,
    staffId: string,
    groupId: string,
    date: LocalDate,
    now: Date,
  ): Promise<GroupDto> {
    await this.staff.authorizeChangeOf(actor, businessId, staffId);
    await refusePastDate(this.prisma, businessId, date, now);
    await this.underLock(businessId, staffId, now, async (tx) => {
      const group = await tx.group.findFirst({ where: { id: groupId, businessId, staffId }, select: groupSelect });
      if (!group) throw new NotFoundException();
      if (!group.weekdays.includes(isoWeekday(date)))
        throw new BadRequestException(['date: Not a day this group meets']);
      await tx.groupCancellation.createMany({
        data: [{ businessId, groupId, date: dateColumn(date) }],
        skipDuplicates: true,
      });
    });
    return this.groupOf(businessId, staffId, groupId, now);
  }

  // The meeting comes back — unless a one-off session took its time meanwhile.
  async uncancelDate(
    actor: AuthUser,
    businessId: string,
    staffId: string,
    groupId: string,
    date: LocalDate,
    now: Date,
  ): Promise<void> {
    await this.staff.authorizeChangeOf(actor, businessId, staffId);
    await this.underLock(businessId, staffId, now, async (tx, check) => {
      const group = await tx.group.findFirst({ where: { id: groupId, businessId, staffId }, select: groupSelect });
      const { count } = await tx.groupCancellation.deleteMany({
        where: { businessId, groupId, date: dateColumn(date) },
      });
      if (!group || count === 0) throw new NotFoundException();
      await check((schedule, timeZone) => groupConflict(group, schedule, timeZone, now), 'date');
    });
  }

  // Not over yet, earliest first.
  async oneOffSessions(businessId: string, staffId: string, now: Date): Promise<OneOffSessionDto[]> {
    await this.staff.findIn(businessId, staffId);
    const sessions = await this.prisma.oneOffSession.findMany({
      where: { businessId, staffId, endsAt: { gt: now } },
      orderBy: { startsAt: 'asc' },
      select: sessionSelect,
    });
    return sessions.map(withIsoTimes);
  }

  async addOneOffSession(
    actor: AuthUser,
    businessId: string,
    staffId: string,
    input: OneOffSessionInput,
    now: Date,
  ): Promise<OneOffSessionDto> {
    await this.staff.authorizeChangeOf(actor, businessId, staffId);
    // Over already: it would never be listed (sessions not over yet), so neither seen nor removed.
    if (input.endsAt <= now) throw new BadRequestException(['endsAt: In the past']);
    // Checked before the insert, under the lock: the 409 is built from what the transaction
    // sees. The EXCLUDE stays the floor under it (a row written around this service).
    try {
      return await this.underLock(businessId, staffId, now, async (tx, check) => {
        await check((schedule, timeZone) => sessionConflict(input, schedule, timeZone), 'startsAt');
        const session = await tx.oneOffSession.create({
          data: { businessId, staffId, ...input },
          select: sessionSelect,
        });
        return withIsoTimes(session);
      });
    } catch (error) {
      // Code and EXCLUDE disagree (a row written around this service): still a 409, not a 500.
      if (violatedExclusion(error) !== 'OneOffSession') throw error;
      const other = await this.prisma.oneOffSession.findFirst({
        where: { businessId, staffId, startsAt: { lt: input.endsAt }, endsAt: { gt: input.startsAt } },
        select: sessionSelect,
      });
      if (!other) throw error;
      throw conflictError('startsAt', {
        kind: 'oneOffSession',
        id: other.id,
        title: other.title,
        startsAt: other.startsAt.toISOString(),
      });
    }
  }

  async removeOneOffSession(actor: AuthUser, businessId: string, staffId: string, id: string): Promise<void> {
    await this.staff.authorizeChangeOf(actor, businessId, staffId);
    const { count } = await this.prisma.oneOffSession.deleteMany({ where: { id, businessId, staffId } });
    if (count === 0) throw new NotFoundException();
  }

  // One transaction behind the staff row's lock. `check` reads the master's groups-mode schedule
  // as the write left it and throws a 409 when the rule finds a conflict. What it reads reaches
  // back as far as anything checked can: a session is not over yet but lasts up to a day, so it
  // may start yesterday — and meet sessions that ended since, and a group meeting from the day
  // before (past midnight), whose cancellation is dated two days ago.
  private async underLock<T>(
    businessId: string,
    staffId: string,
    now: Date,
    work: (
      tx: Tx,
      check: (
        rule: (schedule: GroupsSchedule, timeZone: string) => Conflict | undefined,
        field: ScheduleConflict['field'],
      ) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM staff WHERE id = ${staffId}::uuid AND business_id = ${businessId}::uuid FOR UPDATE`;
      const check = async (
        rule: (schedule: GroupsSchedule, timeZone: string) => Conflict | undefined,
        field: ScheduleConflict['field'],
      ) => {
        const { timeZone } = await tx.business.findUniqueOrThrow({
          where: { id: businessId },
          select: { timeZone: true },
        });
        const since = addDays(todayIn(timeZone, now), -2);
        const [groups, cancellations, sessions] = await Promise.all([
          tx.group.findMany({ where: { businessId, staffId }, select: groupSelect }),
          tx.groupCancellation.findMany({
            where: { businessId, group: { staffId }, date: { gte: dateColumn(since) } },
            select: { groupId: true, date: true },
          }),
          tx.oneOffSession.findMany({
            where: { businessId, staffId, endsAt: { gt: new Date(now.getTime() - DAY) } },
            select: { ...sessionSelect, staffId: true },
          }),
        ]);
        const conflict = rule(
          {
            groups,
            sessions,
            cancellations: cancellations.map(({ groupId, date }) => ({ groupId, date: localDateOf(date) })),
          },
          timeZone,
        );
        if (conflict) throw conflictError(field, conflict);
      };
      return work(tx, check);
    });
  }

  // What a write answers with: the one group, as the list shows it.
  private async groupOf(businessId: string, staffId: string, groupId: string, now: Date): Promise<GroupDto> {
    const [group] = await this.findGroups({ id: groupId, businessId, staffId }, now);
    if (!group) throw new NotFoundException();
    return group;
  }

  // With their cancellations from today on, in the order they were added.
  private async findGroups(
    where: { id?: string; businessId: string; staffId: string },
    now: Date,
  ): Promise<GroupDto[]> {
    const today = await todayOfBusiness(this.prisma, where.businessId, now);
    const groups = await this.prisma.group.findMany({
      where,
      orderBy: { id: 'asc' },
      select: {
        ...groupSelect,
        cancellations: { where: { date: { gte: dateColumn(today) } }, orderBy: { date: 'asc' } },
      },
    });
    return groups.map(({ staffId: _staffId, cancellations, ...group }) => ({
      ...group,
      cancellations: cancellations.map(({ date }) => localDateOf(date)),
    }));
  }
}
