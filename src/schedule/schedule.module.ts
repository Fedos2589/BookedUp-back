import { Module } from '@nestjs/common';

import { StaffModule } from '../staff/staff.module.js';
import { GroupsController } from './groups.controller.js';
import { GroupsService } from './groups.service.js';
import { SlotsController, StaffScheduleController } from './schedule.controller.js';
import { ScheduleService } from './schedule.service.js';

@Module({
  imports: [StaffModule],
  controllers: [StaffScheduleController, GroupsController, SlotsController],
  providers: [ScheduleService, GroupsService],
})
export class ScheduleModule {}
