import { Injectable } from '@nestjs/common';

import { statusConflict } from '../appointments/appointments.service.js';
import { canChange } from '../public-booking/can-change.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ChannelRegistry } from './channels/channel-registry.js';
import { turnClientChannelOn } from './client-channels.js';
import { channelOff } from './link-tokens.service.js';

// A client's email on one online booking (E9, decision 4: an address given on this booking is this booking's, not
// the card's). The caller has found the booking by its manage token; everything here is filtered by that
// booking's business and id.
@Injectable()
export class ClientEmailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: ChannelRegistry,
  ) {}

  assertOn(): void {
    if (!this.channels.isOn('EMAIL')) throw channelOff();
  }

  // One address per booking: a new one switches the old one off, in the transaction that writes it. The booking is
  // read and checked there too, so a cancel at the same moment can't slip in between.
  async turnOn(
    booking: { businessId: string; id: string },
    email: string,
    locale: string,
    manageLink: string,
  ): Promise<void> {
    const { businessId, id } = booking;
    await this.prisma.$transaction(async (tx) => {
      // Two addresses at once: the second waits for the first to commit, then switches it off.
      await tx.$executeRaw`SELECT 1 FROM appointments WHERE business_id = ${businessId}::uuid AND id = ${id}::uuid FOR UPDATE`;
      const appointment = await tx.appointment.findFirstOrThrow({
        where: { id, businessId },
        select: { id: true, clientId: true, startsAt: true, status: true },
      });
      if (!canChange(appointment, new Date()))
        throw statusConflict('badTransition', 'The booking can no longer change');
      await tx.clientChannel.updateMany({
        where: { businessId, appointmentId: id, kind: 'EMAIL', address: { not: email }, disabledAt: null },
        data: { disabledAt: new Date() },
      });
      await turnClientChannelOn(tx, { businessId, appointment, kind: 'EMAIL', address: email, locale, manageLink });
    });
  }

  // Never deletes: events and deliveries hang on the row. Works with the channel off too: someone who asked not to
  // be told must not be told when it comes back on.
  async turnOff(businessId: string, appointmentId: string, now: Date): Promise<void> {
    await this.prisma.clientChannel.updateMany({
      where: { businessId, appointmentId, kind: 'EMAIL', disabledAt: null },
      data: { disabledAt: now },
    });
  }
}
