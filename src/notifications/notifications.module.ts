import { Module } from '@nestjs/common';

import { ChannelRegistry } from './channels/channel-registry.js';
import { LogChannel } from './channels/log.channel.js';
import { DispatcherService } from './dispatcher.service.js';
import { RemindersService } from './reminders.service.js';

@Module({
  providers: [DispatcherService, RemindersService, ChannelRegistry, LogChannel],
  exports: [DispatcherService, RemindersService],
})
export class NotificationsModule {}
