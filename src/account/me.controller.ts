import { CurrentUser } from '@nestjs/authentication';
import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags, ApiTooManyRequestsResponse, ApiUnauthorizedResponse } from '@nestjs/swagger';

import { openApi } from '../common/api-errors.js';
import { type Account, accountSchema } from './account.schema.js';
import { AccountService } from './account.service.js';

@ApiTags('account')
@Controller('me')
export class MeController {
  constructor(private readonly accounts: AccountService) {}

  @Get()
  @ApiOkResponse({ description: 'The signed-in account and its businesses', schema: openApi(accountSchema) })
  @ApiUnauthorizedResponse({ description: 'No live session' })
  @ApiTooManyRequestsResponse({ description: 'Too many requests; try again later' })
  me(@CurrentUser('id') userId: string): Promise<Account> {
    return this.accounts.describe(userId);
  }
}
