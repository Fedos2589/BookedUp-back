import { Public } from '@nestjs/authentication';
import { Body, Controller, Post, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { hours, Throttle } from '@nestjs/throttler';
import type { Response } from 'express';

import { SessionStarter } from '../account/session-starter.js';
import { openApi, validationErrorSchema } from '../common/api-errors.js';
import {
  signUpConflictSchema,
  type SignUpInput,
  type SignUpResult,
  signUpResultSchema,
  signUpSchema,
} from './sign-up.schema.js';
import { SignUpService } from './sign-up.service.js';

@ApiTags('auth')
@Public()
@Controller('auth')
export class SignUpController {
  constructor(
    private readonly signUpService: SignUpService,
    private readonly session: SessionStarter,
  ) {}

  // Registers an owner with their business and signs them in (sets the session cookie).
  @Post('sign-up')
  @Throttle({ default: { limit: 10, ttl: hours(1) } })
  @ApiCreatedResponse({
    description: 'The owner and the business are created, and the owner is signed in (no cookie if that failed)',
    schema: openApi(signUpResultSchema),
  })
  @ApiBadRequestResponse({
    description: 'A field is invalid; messages are prefixed with its path',
    schema: openApi(validationErrorSchema),
  })
  @ApiConflictResponse({
    description: 'The email or the slug is taken; `field` says which',
    schema: openApi(signUpConflictSchema),
  })
  @ApiForbiddenResponse({ description: "Posted from another site's page" })
  @ApiTooManyRequestsResponse({ description: 'Too many sign-ups from this address; try again later' })
  async signUp(
    @Body({ schema: signUpSchema }) body: SignUpInput,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SignUpResult> {
    const result = await this.signUpService.signUp(body);
    await this.session.start(res, result.user, 'Signed up, but sign-in failed');
    return result;
  }
}
