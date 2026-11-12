import { Injectable, NotFoundException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-types.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StaffService } from '../staff/staff.service.js';
import { DAY, wallOfDate } from './local-time.js';
import type {
  SlotDto,
  SlotsQuery,
  TimeOffDto,
  TimeOffInput,
  WeeklySchedule,
  WeeklyScheduleInput,
} from './schedule.schema.js';
import { freeSlots } from './slots.js';

const weeklySelect = { weekday: true, startMinute: true, durationMinutes: true, slotMinutes: true, title: true };
const weeklyOrder = [{ weekday: 'asc' }, { startMinute: 'asc' }] as const;

const withIsoTimes = <T extends { startsAt: Date; endsAt: Date }>({ startsAt, endsAt, ...rest }: T) => ({
  ...rest,
  startsAt: startsAt.toISOString(),
  endsAt: endsAt.toISOString(),
});

@Injectable()
export class ScheduleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly staff: StaffService,
  ) {}

  async weekly(businessId: string, staffId: string): Promise<WeeklySchedule> {
    await this.staff.findIn(businessId, staffId);
    const windows = await this.prisma.weeklyWindow.findMany({
      where: { businessId, staffId },
      orderBy: [...weeklyOrder],
      select: weeklySelect,
    });
    return { windows };
  }

  // The whole week at once: the schema has refused overlaps, and the lock on the staff row makes
  // two saves of one week take turns, so neither can leave its windows beside the other's.
  async replaceWeekly(
    actor: AuthUser,
    businessId: string,
    staffId: string,
    { windows }: WeeklyScheduleInput,
  ): Promise<WeeklySchedule> {
    await this.staff.authorizeChangeOf(actor, businessId, staffId);
    const saved = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM staff WHERE id = ${staffId}::uuid AND business_id = ${businessId}::uuid FOR UPDATE`;
      await tx.weeklyWindow.deleteMany({ where: { businessId, staffId } });
      await tx.weeklyWindow.createMany({ data: windows.map((window) => ({ businessId, staffId, ...window })) });
      return tx.weeklyWindow.findMany({
        where: { businessId, staffId },
        orderBy: [...weeklyOrder],
        select: weeklySelect,
      });
    });
    return { windows: saved };
  }

  // The ones not over yet, earliest first.
  async timeOff(businessId: string, staffId: string, now: Date): Promise<TimeOffDto[]> {
    await this.staff.findIn(businessId, staffId);
    const timeOff = await this.prisma.timeOff.findMany({
      where: { businessId, staffId, endsAt: { gt: now } },
      orderBy: { startsAt: 'asc' },
      select: { id: true, staffId: true, startsAt: true, endsAt: true, note: true },
    });
    return timeOff.map(withIsoTimes);
  }

  async addTimeOff(actor: AuthUser, businessId: string, staffId: string, input: TimeOffInput): Promise<TimeOffDto> {
    await this.staff.authorizeChangeOf(actor, businessId, staffId);
    const timeOff = await this.prisma.timeOff.create({
      data: { businessId, staffId, ...input },
      select: { id: true, staffId: true, startsAt: true, endsAt: true, note: true },
    });
    return withIsoTimes(timeOff);
  }

  async removeTimeOff(actor: AuthUser, businessId: string, staffId: string, id: string): Promise<void> {
    await this.staff.authorizeChangeOf(actor, businessId, staffId);
    const { count } = await this.prisma.timeOff.deleteMany({ where: { id, businessId, staffId } });
    if (count === 0) throw new NotFoundException();
  }

  // Masters still on the team. The instants read are a generous margin around the days asked:
  // a time zone is at most 14 hours from UTC, and a one-off window lasts at most a day.
  async slots(businessId: string, { from, to, staffId }: SlotsQuery, now: Date): Promise<SlotDto[]> {
    const staffWhere = { businessId, staff: { archivedAt: null }, ...(staffId && { staffId }) };
    const around = {
      startsAt: { lt: new Date(wallOfDate(to) + 3 * DAY) },
      endsAt: { gt: new Date(wallOfDate(from) - 2 * DAY) },
    };
    const [business, weekly, busy] = await Promise.all([
      this.prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { timeZone: true } }),
      this.prisma.weeklyWindow.findMany({ where: staffWhere }),
      this.prisma.timeOff.findMany({ where: { ...staffWhere, ...around } }),
    ]);
    return freeSlots({
      timeZone: business.timeZone,
      weekly,
      dayOverrides: [],
      groups: [],
      cancellations: [],
      oneOffSessions: [],
      busy,
      from,
      to,
      notBefore: now,
    }).map(withIsoTimes);
  }
}
