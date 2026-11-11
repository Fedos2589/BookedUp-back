import { CurrentUser } from '@nestjs/authentication';
import { Body, Controller, Delete, Get, HttpCode, Param, Patch } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
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
import { MayInBusiness, MemberOfBusiness } from '../business/business.policy.js';
import { openApi, validationErrorSchema } from '../common/api-errors.js';
import { type ChangeRoleInput, changeRoleSchema, type Member, memberSchema } from './members.schema.js';
import { MembersService } from './members.service.js';

// Who signs in to a business and with what role. The owner and admins only; which members each
// may change is roles.ts (an admin: masters).
@ApiTags('members')
@MemberOfBusiness()
@ApiUnauthorizedResponse({ description: 'No live session' })
@ApiForbiddenResponse({
  description: 'Not a member of this business (or no such business), or the role may not do this',
})
@ApiTooManyRequestsResponse({ description: 'Too many requests; try again later' })
@Controller('businesses/:businessId/members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  @MayInBusiness('manageTeam')
  @ApiOkResponse({ description: 'The members, oldest first', schema: openApi(z.array(memberSchema)) })
  list(@Param('businessId', { schema: z.uuid() }) businessId: string): Promise<Member[]> {
    return this.members.list(businessId);
  }

  @Patch(':userId')
  @MayInBusiness('manageTeam')
  @ApiOkResponse({ description: 'The role is changed', schema: openApi(memberSchema) })
  @ApiBadRequestResponse({ description: 'The role is not ADMIN or MASTER', schema: openApi(validationErrorSchema) })
  @ApiNotFoundResponse({ description: 'Not a member of this business' })
  @ApiConflictResponse({ description: 'The member was changed meanwhile' })
  changeRole(
    @CurrentUser() actor: AuthUser,
    @Param('businessId', { schema: z.uuid() }) businessId: string,
    @Param('userId', { schema: z.uuid() }) userId: string,
    @Body({ schema: changeRoleSchema }) body: ChangeRoleInput,
  ): Promise<Member> {
    return this.members.changeRole(actor, businessId, userId, body);
  }

  @Delete(':userId')
  @HttpCode(204)
  @MayInBusiness('manageTeam')
  @ApiNoContentResponse({ description: 'Removed; their schedule stays, without an account' })
  @ApiNotFoundResponse({ description: 'Not a member of this business' })
  @ApiConflictResponse({ description: 'The member was changed meanwhile' })
  remove(
    @CurrentUser() actor: AuthUser,
    @Param('businessId', { schema: z.uuid() }) businessId: string,
    @Param('userId', { schema: z.uuid() }) userId: string,
  ): Promise<void> {
    return this.members.remove(actor, businessId, userId);
  }
}
