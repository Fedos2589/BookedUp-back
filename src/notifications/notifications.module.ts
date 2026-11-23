import { Module } from '@nestjs/common';

import { ChannelRegistry } from './channels/channel-registry.js';
import { LogChannel } from './channels/log.channel.js';
import { DispatcherService } from './dispatcher.service.js';

@Module({
  providers: [DispatcherService, ChannelRegistry, LogChannel],
  exports: [DispatcherService],
})
export class NotificationsModule {}
