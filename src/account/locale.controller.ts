import { Authenticate, CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import { Body, Controller, HttpCode, Put, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';

import { openApi, validationErrorSchema } from '../common/api-errors.js';
import { AccountService } from './account.service.js';
import { type LocaleBody, localeBodySchema, LocaleCookie } from './locale.js';

@ApiTags('account')
// Open to a visitor without an account too (sign-in, the booking page): they get the cookie only.
@Authenticate({ optional: true })
@Can.Anyone()
@Controller('locale')
export class LocaleController {
  constructor(
    private readonly accounts: AccountService,
    private readonly cookie: LocaleCookie,
  ) {}

  @Put()
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Chosen: the language cookie is set, and the account keeps it if signed in' })
  @ApiBadRequestResponse({ schema: openApi(validationErrorSchema) })
  @ApiForbiddenResponse({ description: "Sent from another site's page" })
  @ApiTooManyRequestsResponse({ description: 'Too many requests; try again later' })
  async choose(
    @Body({ schema: localeBodySchema }) { locale }: LocaleBody,
    @CurrentUser('id') userId: string | null,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    if (userId) await this.accounts.setLocale(userId, locale);
    this.cookie.set(res, locale);
  }
}
