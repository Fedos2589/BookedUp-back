import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { z } from 'zod';

import { MemberOfBusiness } from '../business/business.policy.js';
import { openApi, validationErrorSchema } from '../common/api-errors.js';
import {
  type MyBusinessNotifications,
  myBusinessNotificationsSchema,
  type MyNotifications,
  myNotificationsSchema,
  type SetMyBusinessNotificationsInput,
  setMyBusinessNotificationsSchema,
} from './my-notifications.schema.js';
import { MyNotificationsService } from './my-notifications.service.js';

@ApiTags('notifications')
// Any signed-in user, about their own account.
@Can.Anyone()
@Controller('me/notifications')
export class MyNotificationsController {
  constructor(private readonly notifications: MyNotificationsService) {}

  @Get()
  @ApiOkResponse({ description: 'My account-wide notification switches', schema: openApi(myNotificationsSchema) })
  @ApiUnauthorizedResponse({ description: 'No live session' })
  @ApiTooManyRequestsResponse({ description: 'Too many requests; try again later' })
  get(@CurrentUser('id') userId: string): Promise<MyNotifications> {
    return this.notifications.email(userId);
  }

  @Put()
  @ApiOkResponse({ description: 'The switches now', schema: openApi(myNotificationsSchema) })
  @ApiBadRequestResponse({ schema: openApi(validationErrorSchema) })
  @ApiUnauthorizedResponse({ description: 'No live session' })
  @ApiTooManyRequestsResponse({ description: 'Too many requests; try again later' })
  set(
    @CurrentUser('id') userId: string,
    @Body({ schema: myNotificationsSchema }) { email }: MyNotifications,
  ): Promise<MyNotifications> {
    return this.notifications.setEmail(userId, email);
  }
}

@ApiTags('notifications')
@MemberOfBusiness()
@Controller('businesses/:businessId/me/notifications')
export class MyBusinessNotificationsController {
  constructor(private readonly notifications: MyNotificationsService) {}

  @Get()
  @ApiOkResponse({
    description: 'My switches in this business; `allOnline` is null for a master (not offered)',
    schema: openApi(myBusinessNotificationsSchema),
  })
  @ApiUnauthorizedResponse({ description: 'No live session' })
  @ApiForbiddenResponse({ description: 'Not a member of this business, or no such business' })
  @ApiTooManyRequestsResponse({ description: 'Too many requests; try again later' })
  get(
    @CurrentUser('id') userId: string,
    @Param('businessId', { schema: z.uuid() }) businessId: string,
  ): Promise<MyBusinessNotifications> {
    return this.notifications.allOnline(userId, businessId);
  }

  @Put()
  @ApiOkResponse({ description: 'The switches now', schema: openApi(myBusinessNotificationsSchema) })
  @ApiBadRequestResponse({
    description: 'Not a boolean, or the caller is a master (not offered)',
    schema: openApi(validationErrorSchema),
  })
  @ApiUnauthorizedResponse({ description: 'No live session' })
  @ApiForbiddenResponse({ description: 'Not a member of this business, or no such business' })
  @ApiTooManyRequestsResponse({ description: 'Too many requests; try again later' })
  set(
    @CurrentUser('id') userId: string,
    @Param('businessId', { schema: z.uuid() }) businessId: string,
    @Body({ schema: setMyBusinessNotificationsSchema }) { allOnline }: SetMyBusinessNotificationsInput,
  ): Promise<MyBusinessNotifications> {
    return this.notifications.setAllOnline(userId, businessId, allOnline);
  }
}
