import { Injectable, NotFoundException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-types.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StaffService } from '../staff/staff.service.js';
import { addDays, DAY, type LocalDate, wallOfDate } from './local-time.js';
import type {
  ScheduleModeDto,
  SlotDto,
  SlotsQuery,
  TimeOffDto,
  TimeOffInput,
  WeeklySchedule,
  WeeklyScheduleInput,
} from './schedule.schema.js';
import { type DayWindow, freeSlots } from './slots.js';

const weeklySelect = { weekday: true, startMinute: true, durationMinutes: true, slotMinutes: true, title: true };
const weeklyOrder = [{ weekday: 'asc' }, { startMinute: 'asc' }] as const;

// A DATE column comes back as midnight UTC of that day.
const localDate = (date: Date): LocalDate => date.toISOString().slice(0, 10);
const dateColumn = (date: LocalDate) => new Date(`${date}T00:00:00Z`);

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

  async setMode(
    actor: AuthUser,
    businessId: string,
    staffId: string,
    { mode }: ScheduleModeDto,
  ): Promise<ScheduleModeDto> {
    await this.staff.authorizeChangeOf(actor, businessId, staffId);
    await this.prisma.staff.updateMany({ where: { id: staffId, businessId }, data: { scheduleMode: mode } });
    return { mode };
  }

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

  // Masters still on the team, each from the sources of their mode only. The instants read are a
  // generous margin around the days asked: a time zone is at most 14 hours from UTC, and a
  // one-off session lasts at most a day; dates start the day before, for windows past midnight.
  async slots(businessId: string, { from, to, staffId }: SlotsQuery, now: Date): Promise<SlotDto[]> {
    const onTeam = (scheduleMode: 'HOURS' | 'GROUPS') => ({
      businessId,
      staff: { archivedAt: null, scheduleMode },
      ...(staffId && { staffId }),
    });
    const anyMode = { businessId, staff: { archivedAt: null }, ...(staffId && { staffId }) };
    const around = {
      startsAt: { lt: new Date(wallOfDate(to) + 3 * DAY) },
      endsAt: { gt: new Date(wallOfDate(from) - 2 * DAY) },
    };
    const dates = { gte: dateColumn(addDays(from, -1)), lte: dateColumn(to) };
    const [business, weekly, overrides, groups, cancellations, oneOffSessions, busy] = await Promise.all([
      this.prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { timeZone: true } }),
      this.prisma.weeklyWindow.findMany({ where: onTeam('HOURS') }),
      this.prisma.dayOverride.findMany({ where: { ...onTeam('HOURS'), date: dates } }),
      this.prisma.group.findMany({ where: onTeam('GROUPS') }),
      this.prisma.groupCancellation.findMany({
        where: { businessId, date: dates, group: onTeam('GROUPS') },
        select: { groupId: true, date: true },
      }),
      this.prisma.oneOffSession.findMany({ where: { ...onTeam('GROUPS'), ...around } }),
      this.prisma.timeOff.findMany({ where: { ...anyMode, ...around } }),
    ]);
    return freeSlots({
      timeZone: business.timeZone,
      weekly,
      // Checked by the schema on the way in.
      dayOverrides: overrides.map(({ staffId, date, windows }) => ({
        staffId,
        date: localDate(date),
        windows: windows as unknown as DayWindow[],
      })),
      groups,
      cancellations: cancellations.map(({ groupId, date }) => ({ groupId, date: localDate(date) })),
      oneOffSessions,
      busy,
      from,
      to,
      notBefore: now,
    }).map(withIsoTimes);
  }
}
