import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { ChannelRegistry } from './channels/channel-registry.js';
import { turnClientChannelOn } from './client-channels.js';
import { channelOff } from './link-tokens.service.js';
import type { PushSubscription } from './push.schema.js';

// A client's Web Push subscription on one online booking. The caller has found the booking by its manage
// token and checked it can still change; everything here is filtered by that booking's business and id.
@Injectable()
export class ClientPushService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: ChannelRegistry,
  ) {}

  assertOn(): void {
    if (!this.channels.isOn('PUSH')) throw channelOff();
  }

  async turnOn(
    booking: { businessId: string; id: string; clientId: string; startsAt: Date },
    subscription: PushSubscription,
    locale: string,
    manageLink: string,
  ): Promise<void> {
    this.assertOn();
    await this.prisma.$transaction((tx) =>
      turnClientChannelOn(tx, {
        businessId: booking.businessId,
        appointment: booking,
        kind: 'PUSH',
        address: subscription.endpoint,
        keys: subscription.keys,
        locale,
        manageLink,
      }),
    );
  }

  // Never deletes: events and deliveries hang on the row. Only this booking's subscription is touched.
  async turnOff(businessId: string, appointmentId: string, endpoint: string, now: Date): Promise<void> {
    this.assertOn();
    await this.prisma.clientChannel.updateMany({
      where: { businessId, appointmentId, kind: 'PUSH', address: endpoint, disabledAt: null },
      data: { disabledAt: now },
    });
  }
}
