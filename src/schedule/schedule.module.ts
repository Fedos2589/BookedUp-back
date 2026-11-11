import { Module } from '@nestjs/common';

import { StaffModule } from '../staff/staff.module.js';
import { SlotsController, StaffScheduleController } from './schedule.controller.js';
import { ScheduleService } from './schedule.service.js';

@Module({
  imports: [StaffModule],
  controllers: [StaffScheduleController, SlotsController],
  providers: [ScheduleService],
})
export class ScheduleModule {}
