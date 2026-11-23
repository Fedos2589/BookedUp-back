import { Module } from '@nestjs/common';

import { DispatcherService } from './dispatcher.service.js';

@Module({
  providers: [DispatcherService],
  exports: [DispatcherService],
})
export class NotificationsModule {}
