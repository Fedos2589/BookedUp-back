import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { z } from 'zod';

import { MayInBusiness, MemberOfBusiness } from '../business/business.policy.js';
import { openApi, validationErrorSchema } from '../common/api-errors.js';
import {
  type CreateStaffInput,
  createStaffSchema,
  staffConflictSchema,
  type StaffMember,
  staffSchema,
  type UpdateStaffInput,
  updateStaffSchema,
} from './staff.schema.js';
import { StaffService } from './staff.service.js';

// Who takes clients in a business. Every member sees the team; the owner and admins change it.
@ApiTags('staff')
@MemberOfBusiness()
@ApiUnauthorizedResponse({ description: 'No live session' })
@ApiForbiddenResponse({
  description: 'Not a member of this business (or no such business), or the role may not do this',
})
@ApiTooManyRequestsResponse({ description: 'Too many requests; try again later' })
@Controller('businesses/:businessId/staff')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  @ApiOkResponse({ description: 'The staff, archived included, oldest first', schema: openApi(z.array(staffSchema)) })
  list(@Param('businessId', { schema: z.uuid() }) businessId: string): Promise<StaffMember[]> {
    return this.staff.list(businessId);
  }

  @Post()
  @MayInBusiness('manageTeam')
  @ApiCreatedResponse({ description: 'Added', schema: openApi(staffSchema) })
  @ApiBadRequestResponse({
    description: 'A field is invalid, or userId is not a member of this business',
    schema: openApi(validationErrorSchema),
  })
  @ApiConflictResponse({ description: 'This member already has a schedule', schema: openApi(staffConflictSchema) })
  create(
    @Param('businessId', { schema: z.uuid() }) businessId: string,
    @Body({ schema: createStaffSchema }) body: CreateStaffInput,
  ): Promise<StaffMember> {
    return this.staff.create(businessId, body);
  }

  @Patch(':staffId')
  @MayInBusiness('manageTeam')
  @ApiOkResponse({ description: 'Renamed, archived or brought back', schema: openApi(staffSchema) })
  @ApiBadRequestResponse({ description: 'A field is invalid', schema: openApi(validationErrorSchema) })
  @ApiNotFoundResponse({ description: 'No such staff in this business' })
  update(
    @Param('businessId', { schema: z.uuid() }) businessId: string,
    @Param('staffId', { schema: z.uuid() }) staffId: string,
    @Body({ schema: updateStaffSchema }) body: UpdateStaffInput,
  ): Promise<StaffMember> {
    return this.staff.update(businessId, staffId, body);
  }
}
