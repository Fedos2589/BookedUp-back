import { Public, SignInService } from '@nestjs/authentication';
import { Body, Controller, HttpCode, Post, UnauthorizedException } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { minutes, Throttle } from '@nestjs/throttler';

import { type Account, accountSchema } from '../account/account.schema.js';
import { AccountService } from '../account/account.service.js';
import { openApi, validationErrorSchema } from '../common/api-errors.js';
import { CountPerAccount } from './account-limits.js';
import { type SignInInput, signInSchema } from './credentials.schema.js';
import { CredentialsService } from './credentials.service.js';

@ApiTags('auth')
@Public()
@Controller('auth')
export class SessionController {
  constructor(
    private readonly credentials: CredentialsService,
    private readonly signInService: SignInService,
    private readonly accounts: AccountService,
  ) {}

  // Sets the session cookie and answers what GET /me would.
  @Post('sign-in')
  @HttpCode(200)
  // Per IP address: 30 in 15 minutes. Per account (account-limits.ts): 5 guesses at one
  // email from one client in 15 minutes, 50 from all clients in an hour.
  @CountPerAccount()
  @Throttle({ default: { limit: 30, ttl: minutes(15) } })
  @ApiOkResponse({ description: 'Signed in; the session cookie is set', schema: openApi(accountSchema) })
  @ApiBadRequestResponse({ schema: openApi(validationErrorSchema) })
  // One answer for a wrong password and an unknown email: it must not tell which emails exist.
  @ApiUnauthorizedResponse({ description: 'Invalid email or password' })
  @ApiForbiddenResponse({ description: "Posted from another site's page" })
  @ApiTooManyRequestsResponse({ description: 'Too many attempts; try again later' })
  async signIn(@Body({ schema: signInSchema }) { email, password }: SignInInput): Promise<Account> {
    const userId = await this.credentials.verify(email, password);
    if (!userId) throw new UnauthorizedException('Invalid email or password');
    await this.signInService.signIn(userId, { method: 'password' });
    return this.accounts.describe(userId);
  }

  // Ends this browser's session, if it has one, and clears its cookie. Idempotent: with
  // an expired cookie there is nothing to end, and the answer is the same.
  @Post('sign-out')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Signed out' })
  @ApiForbiddenResponse({ description: "Posted from another site's page" })
  @ApiTooManyRequestsResponse({ description: 'Too many requests; try again later' })
  async signOut(): Promise<void> {
    await this.signInService.signOut();
  }
}
