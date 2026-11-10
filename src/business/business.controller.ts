import { CurrentUser } from '@nestjs/authentication';
import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { openApi } from '../common/api-errors.js';
import { MemberOfBusiness } from './business.policy.js';
import { type MemberBusiness, memberBusinessSchema } from './business.schema.js';
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
  describe(@CurrentUser('id') userId: string, @Param('businessId') businessId: string): Promise<MemberBusiness> {
    return this.businesses.describe(userId, businessId);
  }
}
