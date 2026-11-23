import { Module } from '@nestjs/common';

import { AccountService } from './account.service.js';
import { LocaleController } from './locale.controller.js';
import { LocaleCookie } from './locale.js';
import { MeController } from './me.controller.js';

@Module({
  controllers: [MeController, LocaleController],
  providers: [AccountService, LocaleCookie],
  exports: [AccountService, LocaleCookie],
})
export class AccountModule {}
