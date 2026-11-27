import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { MailModule } from '../mail/mail.module.js';

import { ChannelRegistry } from './channels/channel-registry.js';
import { EmailChannel } from './channels/email.channel.js';
import { LogChannel } from './channels/log.channel.js';
import { PushChannel } from './channels/push.channel.js';
import { TelegramChannel } from './channels/telegram.channel.js';
import { TelegramClient } from './channels/telegram.client.js';
import { WhatsappChannel } from './channels/whatsapp.channel.js';
import { WhatsappClient } from './channels/whatsapp.client.js';
import { ClientSessionPurgeService } from './client-session-purge.service.js';
import { ClientWhatsappService } from './client-whatsapp.service.js';
import { ClientEmailService } from './client-email.service.js';
import { ClientNotificationsService } from './client-notifications.service.js';
import { ClientPushService } from './client-push.service.js';
import { ClientLoginConfirmService } from './client-login-confirm.service.js';
import { LinkTokensService } from './link-tokens.service.js';
import { DispatcherService } from './dispatcher.service.js';
import { TelegramPolling } from './telegram-polling.js';
import { TelegramUpdatesService } from './telegram-updates.service.js';
import { TelegramWebhookController } from './telegram-webhook.controller.js';
import { TelegramLinkController } from './telegram-link.controller.js';
import { MyBusinessNotificationsController, MyNotificationsController } from './my-notifications.controller.js';
import { MyChannelsService } from './my-channels.service.js';
import { MyNotificationsService } from './my-notifications.service.js';
import { NOTIFICATIONS_QUEUE, NotificationsProcessor } from './notifications.processor.js';
import { RemindersService } from './reminders.service.js';

@Module({
  imports: [BullModule.registerQueue({ name: NOTIFICATIONS_QUEUE }), MailModule],
  controllers: [
    MyNotificationsController,
    MyBusinessNotificationsController,
    TelegramLinkController,
    TelegramWebhookController,
  ],
  providers: [
    MyNotificationsService,
    MyChannelsService,
    LinkTokensService,
    ClientSessionPurgeService,
    TelegramUpdatesService,
    ClientLoginConfirmService,
    TelegramPolling,
    NotificationsProcessor,
    DispatcherService,
    RemindersService,
    ChannelRegistry,
    LogChannel,
    TelegramClient,
    TelegramChannel,
    PushChannel,
    WhatsappClient,
    WhatsappChannel,
    EmailChannel,
    ClientPushService,
    ClientWhatsappService,
    ClientEmailService,
    ClientNotificationsService,
  ],
  exports: [
    ChannelRegistry,
    DispatcherService,
    RemindersService,
    LinkTokensService,
    ClientPushService,
    ClientWhatsappService,
    ClientEmailService,
    ClientNotificationsService,
  ],
})
export class NotificationsModule {}
