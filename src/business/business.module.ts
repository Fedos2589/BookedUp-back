import { Module } from '@nestjs/common';

import { BusinessController } from './business.controller.js';
import { BusinessPolicy } from './business.policy.js';
import { BusinessService } from './business.service.js';

// BusinessPolicy is found by AuthorizationModule wherever it is registered.
@Module({
  controllers: [BusinessController],
  providers: [BusinessPolicy, BusinessService],
  exports: [BusinessPolicy],
})
export class BusinessModule {}
