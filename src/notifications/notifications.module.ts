import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { ChannelRegistry } from './channels/channel-registry.js';
import { LogChannel } from './channels/log.channel.js';
import { TelegramChannel } from './channels/telegram.channel.js';
import { TelegramClient } from './channels/telegram.client.js';
import { LinkTokensService } from './link-tokens.service.js';
import { DispatcherService } from './dispatcher.service.js';
import { TelegramLinkController } from './telegram-link.controller.js';
import { MyBusinessNotificationsController, MyNotificationsController } from './my-notifications.controller.js';
import { MyNotificationsService } from './my-notifications.service.js';
import { NOTIFICATIONS_QUEUE, NotificationsProcessor } from './notifications.processor.js';
import { RemindersService } from './reminders.service.js';

@Module({
  imports: [BullModule.registerQueue({ name: NOTIFICATIONS_QUEUE })],
  controllers: [MyNotificationsController, MyBusinessNotificationsController, TelegramLinkController],
  providers: [
    MyNotificationsService,
    LinkTokensService,
    NotificationsProcessor,
    DispatcherService,
    RemindersService,
    ChannelRegistry,
    LogChannel,
    TelegramClient,
    TelegramChannel,
  ],
  exports: [DispatcherService, RemindersService, LinkTokensService],
})
export class NotificationsModule {}
