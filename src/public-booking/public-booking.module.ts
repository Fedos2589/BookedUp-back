import { Module } from '@nestjs/common';

import { AppointmentsModule } from '../appointments/appointments.module.js';
import { ClientsModule } from '../clients/clients.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { ScheduleModule } from '../schedule/schedule.module.js';
import { PublicBookingController } from './public-booking.controller.js';
import { PublicBookingService } from './public-booking.service.js';

@Module({
  imports: [AppointmentsModule, ClientsModule, NotificationsModule, ScheduleModule],
  controllers: [PublicBookingController],
  providers: [PublicBookingService],
})
export class PublicBookingModule {}
