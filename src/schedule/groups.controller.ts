import { CurrentUser } from '@nestjs/authentication';
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
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
  type GroupDto,
  type GroupInput,
  groupInput,
  groupSchema,
  type OneOffSessionDto,
  type OneOffSessionInput,
  oneOffSessionInput,
  oneOffSessionSchema,
  scheduleConflictSchema,
} from './groups.schema.js';
import { GroupsService } from './groups.service.js';
import { localDate } from './schedule.schema.js';

const uuid = { schema: z.uuid() };
const date = { schema: localDate };

// Groups mode of a master's schedule. Who may read and change it: as StaffScheduleController.
@ApiTags('schedule')
@MemberOfBusiness()
@ApiUnauthorizedResponse({ description: 'No live session' })
@ApiForbiddenResponse({
  description: 'Not a member of this business (or no such business), or the role may not change this schedule',
})
@ApiNotFoundResponse({ description: 'No such staff (or group, cancellation, session) in this business' })
@ApiTooManyRequestsResponse({ description: 'Too many requests; try again later' })
@Controller('businesses/:businessId/staff/:staffId')
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  @Get('groups')
  @ApiOkResponse({ description: 'In the order they were added', schema: openApi(z.array(groupSchema)) })
  list(@Param('businessId', uuid) businessId: string, @Param('staffId', uuid) staffId: string): Promise<GroupDto[]> {
    return this.groups.groups(businessId, staffId, new Date());
  }

  @Post('groups')
  @ApiCreatedResponse({ description: 'Added', schema: openApi(groupSchema) })
  @ApiBadRequestResponse({ description: 'A field is invalid', schema: openApi(validationErrorSchema) })
  @ApiConflictResponse({
    description: 'Meets at the time of another group or a one-off session',
    schema: openApi(scheduleConflictSchema),
  })
  add(
    @CurrentUser() actor: AuthUser,
    @Param('businessId', uuid) businessId: string,
    @Param('staffId', uuid) staffId: string,
    @Body({ schema: groupInput }) body: GroupInput,
  ): Promise<GroupDto> {
    return this.groups.addGroup(actor, businessId, staffId, body, new Date());
  }

  @Put('groups/:groupId')
  @ApiOkResponse({ description: 'Changed', schema: openApi(groupSchema) })
  @ApiBadRequestResponse({ description: 'A field is invalid', schema: openApi(validationErrorSchema) })
  @ApiConflictResponse({
    description: 'Would meet at the time of another group or a one-off session',
    schema: openApi(scheduleConflictSchema),
  })
  change(
    @CurrentUser() actor: AuthUser,
    @Param('businessId', uuid) businessId: string,
    @Param('staffId', uuid) staffId: string,
    @Param('groupId', uuid) groupId: string,
    @Body({ schema: groupInput }) body: GroupInput,
  ): Promise<GroupDto> {
    return this.groups.updateGroup(actor, businessId, staffId, groupId, body, new Date());
  }

  @Delete('groups/:groupId')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Removed, with its cancellations' })
  remove(
    @CurrentUser() actor: AuthUser,
    @Param('businessId', uuid) businessId: string,
    @Param('staffId', uuid) staffId: string,
    @Param('groupId', uuid) groupId: string,
  ): Promise<void> {
    return this.groups.removeGroup(actor, businessId, staffId, groupId);
  }

  @Put('groups/:groupId/cancellations/:date')
  @ApiOkResponse({ description: 'The group, that date cancelled (again is fine)', schema: openApi(groupSchema) })
  @ApiBadRequestResponse({
    description: 'Not a date, a date before today, or not a day it meets',
    schema: openApi(validationErrorSchema),
  })
  cancel(
    @CurrentUser() actor: AuthUser,
    @Param('businessId', uuid) businessId: string,
    @Param('staffId', uuid) staffId: string,
    @Param('groupId', uuid) groupId: string,
    @Param('date', date) day: string,
  ): Promise<GroupDto> {
    return this.groups.cancelDate(actor, businessId, staffId, groupId, day, new Date());
  }

  @Delete('groups/:groupId/cancellations/:date')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'It meets that day again' })
  @ApiConflictResponse({
    description: 'A one-off session took that time meanwhile',
    schema: openApi(scheduleConflictSchema),
  })
  uncancel(
    @CurrentUser() actor: AuthUser,
    @Param('businessId', uuid) businessId: string,
    @Param('staffId', uuid) staffId: string,
    @Param('groupId', uuid) groupId: string,
    @Param('date', date) day: string,
  ): Promise<void> {
    return this.groups.uncancelDate(actor, businessId, staffId, groupId, day, new Date());
  }

  @Get('one-off-sessions')
  @ApiOkResponse({ description: 'Not over yet, earliest first', schema: openApi(z.array(oneOffSessionSchema)) })
  sessions(
    @Param('businessId', uuid) businessId: string,
    @Param('staffId', uuid) staffId: string,
  ): Promise<OneOffSessionDto[]> {
    return this.groups.oneOffSessions(businessId, staffId, new Date());
  }

  @Post('one-off-sessions')
  @ApiCreatedResponse({ description: 'Added', schema: openApi(oneOffSessionSchema) })
  @ApiBadRequestResponse({
    description: 'A field is invalid, or it is over already',
    schema: openApi(validationErrorSchema),
  })
  @ApiConflictResponse({
    description: 'Overlaps a meeting of a group (not cancelled) or another one-off session',
    schema: openApi(scheduleConflictSchema),
  })
  addSession(
    @CurrentUser() actor: AuthUser,
    @Param('businessId', uuid) businessId: string,
    @Param('staffId', uuid) staffId: string,
    @Body({ schema: oneOffSessionInput }) body: OneOffSessionInput,
  ): Promise<OneOffSessionDto> {
    return this.groups.addOneOffSession(actor, businessId, staffId, body, new Date());
  }

  @Delete('one-off-sessions/:id')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Removed' })
  removeSession(
    @CurrentUser() actor: AuthUser,
    @Param('businessId', uuid) businessId: string,
    @Param('staffId', uuid) staffId: string,
    @Param('id', uuid) id: string,
  ): Promise<void> {
    return this.groups.removeOneOffSession(actor, businessId, staffId, id);
  }
}
