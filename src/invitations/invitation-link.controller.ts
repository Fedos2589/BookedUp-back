import { CurrentUser, Public, SignInService } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import { Body, Controller, Get, HttpCode, Logger, Param, Post } from '@nestjs/common';
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
import { hours, Throttle } from '@nestjs/throttler';

import { type MemberBusiness, memberBusinessSchema } from '../business/business.schema.js';
import { openApi, validationErrorSchema } from '../common/api-errors.js';
import {
  type InvitationPreview,
  invitationPreviewSchema,
  invitationSignUpConflictSchema,
  type InvitationSignUpInput,
  type InvitationSignUpResult,
  invitationSignUpResultSchema,
  invitationSignUpSchema,
  invitationTokenSchema,
} from './invitations.schema.js';
import { InvitationsService } from './invitations.service.js';

// What the holder of an invitation link does with it. Not under /businesses/:businessId: the
// holder is not a member yet. The token is the check (256 random bits); the page and sign-up
// are public on purpose, accepting needs a session.
@ApiTags('invitations')
@ApiNotFoundResponse({ description: 'The invitation is used, revoked, expired or never existed' })
@ApiTooManyRequestsResponse({ description: 'Too many requests; try again later' })
@Controller('invitations/:token')
export class InvitationLinkController {
  private readonly logger = new Logger(InvitationLinkController.name);

  constructor(
    private readonly invitations: InvitationsService,
    private readonly signInService: SignInService,
  ) {}

  @Get()
  @Public()
  @ApiOkResponse({ description: 'Which business, role and inviter', schema: openApi(invitationPreviewSchema) })
  preview(@Param('token', { schema: invitationTokenSchema }) token: string): Promise<InvitationPreview> {
    return this.invitations.preview(token);
  }

  @Post('accept')
  @HttpCode(200)
  @Can.Anyone()
  @ApiOkResponse({ description: 'Now a member; the business and the role', schema: openApi(memberBusinessSchema) })
  @ApiUnauthorizedResponse({ description: 'No live session' })
  @ApiConflictResponse({ description: 'Already a member, or the offered schedule is taken; the link stays good' })
  @ApiForbiddenResponse({ description: "Posted from another site's page" })
  accept(
    @CurrentUser('id') userId: string,
    @Param('token', { schema: invitationTokenSchema }) token: string,
  ): Promise<MemberBusiness> {
    return this.invitations.accept(token, userId);
  }

  // The same limit as sign-up: it creates an account.
  @Post('sign-up')
  @Public()
  @Throttle({ default: { limit: 10, ttl: hours(1) } })
  @ApiCreatedResponse({
    description: 'The account is created, joined and signed in (no cookie if signing in failed)',
    schema: openApi(invitationSignUpResultSchema),
  })
  @ApiBadRequestResponse({ description: 'A field is invalid', schema: openApi(validationErrorSchema) })
  @ApiConflictResponse({
    description: 'The email is registered (sign in and accept instead), or the offered schedule is taken',
    schema: openApi(invitationSignUpConflictSchema),
  })
  @ApiForbiddenResponse({ description: "Posted from another site's page" })
  async signUp(
    @Param('token', { schema: invitationTokenSchema }) token: string,
    @Body({ schema: invitationSignUpSchema }) body: InvitationSignUpInput,
  ): Promise<InvitationSignUpResult> {
    const result = await this.invitations.signUp(token, body);
    // As in sign-up: the account is committed, so a failed sign-in is a 201 without a cookie.
    await this.signInService
      .signIn(result.user.id, { method: 'password' })
      .catch((error: unknown) =>
        this.logger.warn({ err: error, userId: result.user.id }, 'Joined, but sign-in failed'),
      );
    return result;
  }
}
