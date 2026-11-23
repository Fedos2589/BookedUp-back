import { Module } from '@nestjs/common';

import { AccountService } from './account.service.js';
import { LocaleController } from './locale.controller.js';
import { LocaleCookie } from './locale.js';
import { SessionStarter } from './session-starter.js';
import { MeController } from './me.controller.js';

@Module({
  controllers: [MeController, LocaleController],
  providers: [AccountService, LocaleCookie, SessionStarter],
  exports: [AccountService, LocaleCookie, SessionStarter],
})
export class AccountModule {}
