import { CurrentUser } from '@nestjs/authentication';
import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
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
import { MayInBusiness, MemberOfBusiness } from '../business/business.policy.js';
import { openApi, validationErrorSchema } from '../common/api-errors.js';
import {
  type CreatedInvitation,
  createdInvitationSchema,
  type CreateInvitationInput,
  createInvitationSchema,
  invitationSchema,
  type InvitationView,
} from './invitations.schema.js';
import { InvitationsService } from './invitations.service.js';

// Invitations a business has given out. The owner and admins; which roles each may invite as
// is roles.ts (an admin: masters).
@ApiTags('invitations')
@MemberOfBusiness()
@ApiUnauthorizedResponse({ description: 'No live session' })
@ApiForbiddenResponse({
  description: 'Not a member of this business (or no such business), or the role may not do this',
})
@ApiTooManyRequestsResponse({ description: 'Too many requests; try again later' })
@Controller('businesses/:businessId/invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post()
  @MayInBusiness('manageTeam')
  @ApiCreatedResponse({
    description: 'The invitation and its link, shown only now',
    schema: openApi(createdInvitationSchema),
  })
  @ApiBadRequestResponse({
    description: 'A field is invalid, or staffId is not a schedule without an account in this business',
    schema: openApi(validationErrorSchema),
  })
  create(
    @CurrentUser() actor: AuthUser,
    @Param('businessId', { schema: z.uuid() }) businessId: string,
    @Body({ schema: createInvitationSchema }) body: CreateInvitationInput,
  ): Promise<CreatedInvitation> {
    return this.invitations.create(actor, businessId, body);
  }

  @Get()
  @MayInBusiness('manageTeam')
  @ApiOkResponse({
    description: 'Invitations not yet accepted, revoked or expired, oldest first',
    schema: openApi(z.array(invitationSchema)),
  })
  list(@Param('businessId', { schema: z.uuid() }) businessId: string): Promise<InvitationView[]> {
    return this.invitations.listPending(businessId);
  }

  @Delete(':invitationId')
  @HttpCode(204)
  @MayInBusiness('manageTeam')
  @ApiNoContentResponse({ description: 'Revoked (or already was): the link no longer works' })
  @ApiNotFoundResponse({ description: 'No such invitation in this business' })
  @ApiConflictResponse({ description: 'Already accepted; remove the member instead' })
  revoke(
    @CurrentUser() actor: AuthUser,
    @Param('businessId', { schema: z.uuid() }) businessId: string,
    @Param('invitationId', { schema: z.uuid() }) invitationId: string,
  ): Promise<void> {
    return this.invitations.revoke(actor, businessId, invitationId);
  }
}
