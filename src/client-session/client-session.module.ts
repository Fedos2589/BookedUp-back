import { Module } from '@nestjs/common';

import { NotificationsModule } from '../notifications/notifications.module.js';
import { ClientCookies } from './client-cookies.js';
import { ClientLoginsService } from './client-logins.service.js';
import { ClientSessionsService } from './client-sessions.service.js';
import { ClientSessionController } from './client-session.controller.js';

@Module({
  imports: [NotificationsModule],
  controllers: [ClientSessionController],
  providers: [ClientCookies, ClientLoginsService, ClientSessionsService],
})
export class ClientSessionModule {}
