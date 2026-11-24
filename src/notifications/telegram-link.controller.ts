import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import { Controller, Delete, HttpCode, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { openApi } from '../common/api-errors.js';
import { MyChannelsService } from './my-channels.service.js';
import { LinkTokensService } from './link-tokens.service.js';
import { channelOffSchema, type TelegramLinkDto, telegramLinkSchema } from './link.schema.js';

@ApiTags('notifications')
// Any signed-in user, about their own account.
@Can.Anyone()
@Controller('me')
export class TelegramLinkController {
  constructor(
    private readonly tokens: LinkTokensService,
    private readonly channels: MyChannelsService,
  ) {}

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

  @Delete('notifications/telegram')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'No Telegram chat any more (also when there was none)' })
  @ApiUnauthorizedResponse({ description: 'No live session' })
  @ApiTooManyRequestsResponse({ description: 'Too many requests; try again later' })
  unlink(@CurrentUser('id') userId: string): Promise<void> {
    return this.channels.removeTelegram(userId);
  }
}
