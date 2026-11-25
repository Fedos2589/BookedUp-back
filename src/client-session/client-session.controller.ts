import { Public } from '@nestjs/authentication';
import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { hours, Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import { openApi, validationErrorSchema } from '../common/api-errors.js';
import {
  channelOffSchema,
  telegramLinkInput,
  type TelegramLinkInput,
  type TelegramLinkDto,
  telegramLinkSchema,
} from '../notifications/link.schema.js';
import { ClientCookies } from './client-cookies.js';
import { ClientLoginsService } from './client-logins.service.js';

// A client's sign-in on the public pages: no account, the phone is confirmed in Telegram.
@ApiTags('client-session')
@Public()
@Controller('public')
export class ClientSessionController {
  constructor(
    private readonly logins: ClientLoginsService,
    private readonly cookies: ClientCookies,
  ) {}

  @Post('client-login')
  @Throttle({ default: { limit: 10, ttl: hours(1) } })
  @ApiCreatedResponse({
    description:
      'Open the link in Telegram and share your phone. This browser gets a cookie that, for 10 minutes, is the only one that can take the session the confirmation opens. A second call replaces the first login.',
    schema: openApi(telegramLinkSchema),
  })
  @ApiBadRequestResponse({ description: 'The locale is invalid', schema: openApi(validationErrorSchema) })
  @ApiNotFoundResponse({
    description: 'Telegram is not turned on here (channelOff)',
    schema: openApi(channelOffSchema),
  })
  @ApiTooManyRequestsResponse({ description: 'Too many requests; try again later' })
  async start(
    @Body({ schema: telegramLinkInput }) { locale }: TelegramLinkInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TelegramLinkDto> {
    const { link, browserSecret } = await this.logins.start(locale, this.cookies.browserOf(req));
    this.cookies.setBrowser(res, browserSecret);
    return link;
  }
}
