import { CurrentUser } from '@nestjs/authentication';
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { z } from 'zod';

import type { AuthUser } from '../auth/auth-types.js';
import { MemberOfBusiness } from '../business/business.policy.js';
import { openApi, validationErrorSchema } from '../common/api-errors.js';
import {
  oneOffConflictSchema,
  type OneOffWindowDto,
  type OneOffWindowInput,
  oneOffWindowInput,
  oneOffWindowSchema,
  type SlotDto,
  slotSchema,
  type SlotsQuery,
  slotsQuery,
  type TimeOffDto,
  type TimeOffInput,
  timeOffInput,
  timeOffSchema,
  type WeeklySchedule,
  type WeeklyScheduleInput,
  weeklyScheduleInput,
  weeklyScheduleSchema,
} from './schedule.schema.js';
import { ScheduleService } from './schedule.service.js';

const uuid = { schema: z.uuid() };

// When a master takes clients and when not. Every member sees every schedule; a change follows
// the staff rules (StaffService.authorizeChangeOf): one's own always, others' as roles.ts allows.
@ApiTags('schedule')
@MemberOfBusiness()
@ApiUnauthorizedResponse({ description: 'No live session' })
@ApiForbiddenResponse({
  description: 'Not a member of this business (or no such business), or the role may not change this schedule',
})
@ApiNotFoundResponse({ description: 'No such staff (or window, or time off) in this business' })
@ApiTooManyRequestsResponse({ description: 'Too many requests; try again later' })
@Controller('businesses/:businessId/staff/:staffId')
export class StaffScheduleController {
  constructor(private readonly schedule: ScheduleService) {}

  @Get('weekly-windows')
  @ApiOkResponse({ description: 'The week, Monday first', schema: openApi(weeklyScheduleSchema) })
  weekly(
    @Param('businessId', uuid) businessId: string,
    @Param('staffId', uuid) staffId: string,
  ): Promise<WeeklySchedule> {
    return this.schedule.weekly(businessId, staffId);
  }

  @Put('weekly-windows')
  @ApiOkResponse({ description: 'The week as saved, Monday first', schema: openApi(weeklyScheduleSchema) })
  @ApiBadRequestResponse({
    description: 'A window is invalid, or two windows overlap',
    schema: openApi(validationErrorSchema),
  })
  replaceWeekly(
    @CurrentUser() actor: AuthUser,
    @Param('businessId', uuid) businessId: string,
    @Param('staffId', uuid) staffId: string,
    @Body({ schema: weeklyScheduleInput }) body: WeeklyScheduleInput,
  ): Promise<WeeklySchedule> {
    return this.schedule.replaceWeekly(actor, businessId, staffId, body);
  }

  @Get('one-off-windows')
  @ApiOkResponse({ description: 'The ones not over yet, earliest first', schema: openApi(z.array(oneOffWindowSchema)) })
  oneOffWindows(
    @Param('businessId', uuid) businessId: string,
    @Param('staffId', uuid) staffId: string,
  ): Promise<OneOffWindowDto[]> {
    return this.schedule.oneOffWindows(businessId, staffId, new Date());
  }

  @Post('one-off-windows')
  @ApiCreatedResponse({ description: 'Added', schema: openApi(oneOffWindowSchema) })
  @ApiBadRequestResponse({ description: 'A field is invalid', schema: openApi(validationErrorSchema) })
  @ApiConflictResponse({
    description: 'Overlaps another one-off window of this master',
    schema: openApi(oneOffConflictSchema),
  })
  addOneOffWindow(
    @CurrentUser() actor: AuthUser,
    @Param('businessId', uuid) businessId: string,
    @Param('staffId', uuid) staffId: string,
    @Body({ schema: oneOffWindowInput }) body: OneOffWindowInput,
  ): Promise<OneOffWindowDto> {
    return this.schedule.addOneOffWindow(actor, businessId, staffId, body);
  }

  @Delete('one-off-windows/:id')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Removed' })
  removeOneOffWindow(
    @CurrentUser() actor: AuthUser,
    @Param('businessId', uuid) businessId: string,
    @Param('staffId', uuid) staffId: string,
    @Param('id', uuid) id: string,
  ): Promise<void> {
    return this.schedule.removeOneOffWindow(actor, businessId, staffId, id);
  }

  @Get('time-off')
  @ApiOkResponse({ description: 'The time off not over yet, earliest first', schema: openApi(z.array(timeOffSchema)) })
  timeOff(
    @Param('businessId', uuid) businessId: string,
    @Param('staffId', uuid) staffId: string,
  ): Promise<TimeOffDto[]> {
    return this.schedule.timeOff(businessId, staffId, new Date());
  }

  @Post('time-off')
  @ApiCreatedResponse({ description: 'Added', schema: openApi(timeOffSchema) })
  @ApiBadRequestResponse({ description: 'A field is invalid', schema: openApi(validationErrorSchema) })
  addTimeOff(
    @CurrentUser() actor: AuthUser,
    @Param('businessId', uuid) businessId: string,
    @Param('staffId', uuid) staffId: string,
    @Body({ schema: timeOffInput }) body: TimeOffInput,
  ): Promise<TimeOffDto> {
    return this.schedule.addTimeOff(actor, businessId, staffId, body);
  }

  @Delete('time-off/:id')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Removed' })
  removeTimeOff(
    @CurrentUser() actor: AuthUser,
    @Param('businessId', uuid) businessId: string,
    @Param('staffId', uuid) staffId: string,
    @Param('id', uuid) id: string,
  ): Promise<void> {
    return this.schedule.removeTimeOff(actor, businessId, staffId, id);
  }
}

// What can be booked, for the cabinet. The public booking page (E7) gets its own route under /book.
@ApiTags('schedule')
@MemberOfBusiness()
@ApiUnauthorizedResponse({ description: 'No live session' })
@ApiForbiddenResponse({ description: 'Not a member of this business (or no such business)' })
@ApiTooManyRequestsResponse({ description: 'Too many requests; try again later' })
@Controller('businesses/:businessId/slots')
export class SlotsController {
  constructor(private readonly schedule: ScheduleService) {}

  @Get()
  @ApiOkResponse({
    description: "Free slots starting on the days asked (business's clock), from now on, earliest first",
    schema: openApi(z.array(slotSchema)),
  })
  @ApiBadRequestResponse({
    description: 'from or to is not a date, to is before from, or more than 31 days are asked',
    schema: openApi(validationErrorSchema),
  })
  slots(
    @Param('businessId', uuid) businessId: string,
    @Query({ schema: slotsQuery }) query: SlotsQuery,
  ): Promise<SlotDto[]> {
    return this.schedule.slots(businessId, query, new Date());
  }
}
