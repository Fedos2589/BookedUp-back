import { Public } from '@nestjs/authentication';
import { Body, Controller, Delete, Get, Header, HttpCode, Post, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { hours, Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import { openApi, validationErrorSchema } from '../common/api-errors.js';
import { channelOffSchema, telegramLinkInput, type TelegramLinkInput } from '../notifications/link.schema.js';
import { ClientCookies } from './client-cookies.js';
import { ClientLoginsService } from './client-logins.service.js';
import { ClientSessionsService } from './client-sessions.service.js';
import {
  type ClientLoginStartDto,
  type ClientLoginStatusDto,
  type ClientSessionDto,
  clientLoginStartSchema,
  clientLoginStatusSchema,
  clientSessionSchema,
} from './client-session.schema.js';

// A client's sign-in on the public pages: no account, the phone is confirmed in Telegram.
@ApiTags('client-session')
@Public()
@Controller('public')
export class ClientSessionController {
  constructor(
    private readonly logins: ClientLoginsService,
    private readonly sessions: ClientSessionsService,
    private readonly cookies: ClientCookies,
  ) {}

  // 30, not the booking's 10: a school's parents sit behind one mobile network's address (CGNAT).
  @Post('client-login')
  @Throttle({ default: { limit: 30, ttl: hours(1) } })
  @ApiCreatedResponse({
    description:
      'Open the link in Telegram and share your phone. This browser gets a cookie that, for 10 minutes, is the only one that can take the session the confirmation opens. A second call replaces the first login.',
    schema: openApi(clientLoginStartSchema),
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
  ): Promise<ClientLoginStartDto> {
    const { login, browserSecret } = await this.logins.start(locale, this.cookies.browserOf(req));
    this.cookies.setBrowser(res, browserSecret);
    return login;
  }

  @Get('client-login')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({
    description:
      "Where this browser's login stands (by its cookie). `confirmed`: the phone is confirmed, the login is used up and the session cookie is set by this answer; asking again gives `expired`. Poll every couple of seconds for up to 10 minutes.",
    schema: openApi(clientLoginStatusSchema),
  })
  async status(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<ClientLoginStatusDto> {
    const taken = await this.logins.take(this.cookies.browserOf(req));
    if ('sessionToken' in taken) {
      this.cookies.setSession(res, taken.sessionToken);
      this.cookies.clearBrowser(res);
      return { status: 'confirmed' };
    }
    return taken;
  }

  @Get('client-session')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({
    description:
      'The phone this browser has confirmed, or null without a live session (not an error). A live session is kept 30 days from now, cookie included; a dead cookie is cleared.',
    schema: openApi(clientSessionSchema),
  })
  async current(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<ClientSessionDto> {
    const token = this.cookies.sessionOf(req);
    if (token === undefined) return { phone: null };
    const session = await this.sessions.find(token);
    // The cookie follows the session: kept alive while it lives, dropped when it is gone.
    if (session) this.cookies.setSession(res, token);
    else this.cookies.clearSession(res);
    return { phone: session?.phone ?? null };
  }

  @Delete('client-session')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Signed out; the same when there was no session' })
  async end(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = this.cookies.sessionOf(req);
    if (token !== undefined) await this.sessions.end(token);
    this.cookies.clearSession(res);
  }
}
