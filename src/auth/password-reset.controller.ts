import { Public } from '@nestjs/authentication';
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { hours, minutes, Throttle } from '@nestjs/throttler';

import { openApi, validationErrorSchema } from '../common/api-errors.js';
import {
  type PasswordResetConfirm,
  passwordResetConfirmSchema,
  type PasswordResetRequest,
  passwordResetRequestSchema,
  resetLinkInvalidSchema,
} from './password-reset.schema.js';
import { PasswordResetService } from './password-reset.service.js';

@ApiTags('auth')
@Public()
@Controller('auth')
export class PasswordResetController {
  constructor(private readonly passwordReset: PasswordResetService) {}

  // Always 204, for an unknown email too: the route must not be a cheap «does this email exist» check.
  @Post('password-reset')
  @HttpCode(204)
  @Throttle({ default: { limit: 10, ttl: hours(1) } })
  @ApiNoContentResponse({ description: 'Asked. If the account exists, a letter with a one-hour link is on its way' })
  @ApiBadRequestResponse({ schema: openApi(validationErrorSchema) })
  @ApiForbiddenResponse({ description: "Posted from another site's page" })
  @ApiTooManyRequestsResponse({ description: 'Too many requests from this address; try again later' })
  async request(@Body({ schema: passwordResetRequestSchema }) { email }: PasswordResetRequest): Promise<void> {
    await this.passwordReset.request(email);
  }

  // Sets the password from the link of the letter. No sign-in from a link: the front goes to the sign-in page.
  @Post('password-reset/confirm')
  @HttpCode(204)
  @Throttle({ default: { limit: 30, ttl: minutes(15) } })
  @ApiNoContentResponse({ description: 'The password is set; every session of the account is ended' })
  @ApiBadRequestResponse({
    description: 'The token or the password is malformed',
    schema: openApi(validationErrorSchema),
  })
  @ApiNotFoundResponse({
    description: 'The link is unknown, expired or already used (resetLinkInvalid)',
    schema: openApi(resetLinkInvalidSchema),
  })
  @ApiForbiddenResponse({ description: "Posted from another site's page" })
  @ApiTooManyRequestsResponse({ description: 'Too many attempts from this address; try again later' })
  async confirm(
    @Body({ schema: passwordResetConfirmSchema }) { token, password }: PasswordResetConfirm,
  ): Promise<void> {
    await this.passwordReset.confirm(token, password);
  }
}
