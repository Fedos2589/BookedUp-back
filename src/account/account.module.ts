import { Module } from '@nestjs/common';

import { AccountService } from './account.service.js';
import { MeController } from './me.controller.js';

@Module({
  controllers: [MeController],
  providers: [AccountService],
  exports: [AccountService],
})
export class AccountModule {}
