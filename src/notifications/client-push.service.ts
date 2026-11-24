import { Injectable } from '@nestjs/common';

import { statusConflict } from '../appointments/appointments.service.js';
import { canChange } from '../public-booking/can-change.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ChannelRegistry } from './channels/channel-registry.js';
import { turnClientChannelOn } from './client-channels.js';
import { channelOff } from './link-tokens.service.js';
import type { PushSubscription } from './push.schema.js';

// A client's Web Push subscription on one online booking. The caller has found the booking by its manage
// token; everything here is filtered by that booking's business and id.
@Injectable()
export class ClientPushService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: ChannelRegistry,
  ) {}

  assertOn(): void {
    if (!this.channels.isOn('PUSH')) throw channelOff();
  }

  // The booking is read and checked in the transaction that writes the channel, so a cancel at the same moment
  // can't slip in between.
  async turnOn(
    booking: { businessId: string; id: string },
    subscription: PushSubscription,
    locale: string,
    manageLink: string,
  ): Promise<void> {
    const { businessId, id } = booking;
    await this.prisma.$transaction(async (tx) => {
      const appointment = await tx.appointment.findFirstOrThrow({
        where: { id, businessId },
        select: { id: true, clientId: true, startsAt: true, status: true },
      });
      if (!canChange(appointment, new Date()))
        throw statusConflict('badTransition', 'The booking can no longer change');
      await turnClientChannelOn(tx, {
        businessId,
        appointment,
        kind: 'PUSH',
        address: subscription.endpoint,
        keys: subscription.keys,
        locale,
        manageLink,
      });
    });
  }

  // Never deletes: events and deliveries hang on the row. Only this booking's subscription is touched. Works
  // with the channel off too: someone who asked not to be told must not be told when it comes back on.
  async turnOff(businessId: string, appointmentId: string, endpoint: string, now: Date): Promise<void> {
    await this.prisma.clientChannel.updateMany({
      where: { businessId, appointmentId, kind: 'PUSH', address: endpoint, disabledAt: null },
      data: { disabledAt: now },
    });
  }
}
