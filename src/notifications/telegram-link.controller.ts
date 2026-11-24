import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import { Controller, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { openApi } from '../common/api-errors.js';
import { LinkTokensService } from './link-tokens.service.js';
import { channelOffSchema, type TelegramLinkDto, telegramLinkSchema } from './link.schema.js';

@ApiTags('notifications')
// Any signed-in user, about their own account.
@Can.Anyone()
@Controller('me')
export class TelegramLinkController {
  constructor(private readonly tokens: LinkTokensService) {}

  @Post('telegram-link')
  @ApiCreatedResponse({
    description: 'Open the link in Telegram and press Start: this account gets its bookings there. Valid for an hour.',
    schema: openApi(telegramLinkSchema),
  })
  @ApiUnauthorizedResponse({ description: 'No live session' })
  @ApiNotFoundResponse({
    description: 'Telegram is not turned on here (channelOff)',
    schema: openApi(channelOffSchema),
  })
  @ApiTooManyRequestsResponse({ description: 'Too many requests; try again later' })
  link(@CurrentUser('id') userId: string): Promise<TelegramLinkDto> {
    return this.tokens.forUser(userId);
  }
}
