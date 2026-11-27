import { Public } from '@nestjs/authentication';
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { hours, Throttle } from '@nestjs/throttler';

import { openApi, validationErrorSchema } from '../common/api-errors.js';
import { type PasswordResetRequest, passwordResetRequestSchema } from './password-reset.schema.js';
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
}
