import { CurrentUser } from '@nestjs/authentication';
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

import { openApi, validationErrorSchema } from '../common/api-errors.js';
import { MayInBusiness, MemberOfBusiness } from './business.policy.js';
import {
  type MemberBusiness,
  memberBusinessSchema,
  type SetRemindersInput,
  setRemindersSchema,
} from './business.schema.js';
import { BusinessService } from './business.service.js';

@ApiTags('businesses')
@MemberOfBusiness()
@Controller('businesses/:businessId')
export class BusinessController {
  constructor(private readonly businesses: BusinessService) {}

  @Get()
  @ApiOkResponse({ description: "The business and the user's role in it", schema: openApi(memberBusinessSchema) })
  @ApiUnauthorizedResponse({ description: 'No live session' })
  @ApiForbiddenResponse({ description: 'Not a member of this business, or no such business' })
  @ApiTooManyRequestsResponse({ description: 'Too many requests; try again later' })
  describe(
    @CurrentUser('id') userId: string,
    @Param('businessId', { schema: z.uuid() }) businessId: string,
  ): Promise<MemberBusiness> {
    return this.businesses.describe(userId, businessId);
  }

  @Put('reminders')
  @MayInBusiness('manageSettings')
  @ApiOkResponse({ description: 'The business with its new reminder times', schema: openApi(memberBusinessSchema) })
  @ApiBadRequestResponse({
    description: 'A time not on the list, a repeat, or more than three',
    schema: openApi(validationErrorSchema),
  })
  @ApiUnauthorizedResponse({ description: 'No live session' })
  @ApiForbiddenResponse({ description: 'Not the owner or an admin of this business, or no such business' })
  @ApiTooManyRequestsResponse({ description: 'Too many requests; try again later' })
  setReminders(
    @CurrentUser('id') userId: string,
    @Param('businessId', { schema: z.uuid() }) businessId: string,
    @Body({ schema: setRemindersSchema }) body: SetRemindersInput,
  ): Promise<MemberBusiness> {
    return this.businesses.setReminders(userId, businessId, body);
  }
}
