import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import { Body, Controller, Delete, Get, HttpCode, Param, Put } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { z } from 'zod';

import { MemberOfBusiness } from '../business/business.policy.js';
import { openApi, validationErrorSchema } from '../common/api-errors.js';
import { MyChannelsService } from './my-channels.service.js';
import { channelOffSchema } from './link.schema.js';
import { type PushOffInput, pushOffInput } from './push.schema.js';
import {
  type MyBusinessNotifications,
  myBusinessNotificationsSchema,
  type MyPushInput,
  myPushInput,
  type MyWhatsappInput,
  myWhatsappInput,
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
  constructor(
    private readonly notifications: MyNotificationsService,
    private readonly channels: MyChannelsService,
  ) {}

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

  @Put('whatsapp')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'This number is my WhatsApp now; the old one, if any, is gone' })
  @ApiBadRequestResponse({ description: 'Not an E.164 number', schema: openApi(validationErrorSchema) })
  @ApiUnauthorizedResponse({ description: 'No live session' })
  @ApiNotFoundResponse({
    description: 'WhatsApp is not turned on here (channelOff)',
    schema: openApi(channelOffSchema),
  })
  @ApiTooManyRequestsResponse({ description: 'Too many requests; try again later' })
  whatsappOn(@CurrentUser('id') userId: string, @Body({ schema: myWhatsappInput }) { phone }: MyWhatsappInput) {
    return this.channels.setWhatsapp(userId, phone);
  }

  @Delete('whatsapp')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'No WhatsApp number any more (also when there was none)' })
  @ApiUnauthorizedResponse({ description: 'No live session' })
  @ApiTooManyRequestsResponse({ description: 'Too many requests; try again later' })
  whatsappOff(@CurrentUser('id') userId: string) {
    return this.channels.removeWhatsapp(userId);
  }

  @Put('push')
  @HttpCode(204)
  @ApiNoContentResponse({
    description: 'Web Push is on in this browser. The same endpoint again only refreshes its keys.',
  })
  @ApiBadRequestResponse({
    description: 'A field is invalid, or the endpoint is not a known push service',
    schema: openApi(validationErrorSchema),
  })
  @ApiUnauthorizedResponse({ description: 'No live session' })
  @ApiNotFoundResponse({
    description: 'Web Push is not turned on here (channelOff)',
    schema: openApi(channelOffSchema),
  })
  @ApiTooManyRequestsResponse({ description: 'Too many requests; try again later' })
  pushOn(@CurrentUser('id') userId: string, @Body({ schema: myPushInput }) { subscription }: MyPushInput) {
    return this.channels.addPush(userId, subscription);
  }

  @Delete('push')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'This browser is off; my other devices stay (also when it was not on)' })
  @ApiBadRequestResponse({ schema: openApi(validationErrorSchema) })
  @ApiUnauthorizedResponse({ description: 'No live session' })
  @ApiTooManyRequestsResponse({ description: 'Too many requests; try again later' })
  pushOff(@CurrentUser('id') userId: string, @Body({ schema: pushOffInput }) { endpoint }: PushOffInput) {
    return this.channels.removePush(userId, endpoint);
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
