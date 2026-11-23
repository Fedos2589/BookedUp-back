import { Module } from '@nestjs/common';

import { BusinessModule } from '../business/business.module.js';
import { ClientsModule } from '../clients/clients.module.js';
import { ScheduleModule } from '../schedule/schedule.module.js';
import { StaffModule } from '../staff/staff.module.js';
import { AppointmentsController } from './appointments.controller.js';
import { AppointmentsService } from './appointments.service.js';

@Module({
  imports: [BusinessModule, ClientsModule, StaffModule, ScheduleModule],
  controllers: [AppointmentsController],
  providers: [AppointmentsService],
  exports: [AppointmentsService],
})
export class AppointmentsModule {}
