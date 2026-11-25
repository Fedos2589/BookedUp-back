import { Injectable } from '@nestjs/common';

import { statusConflict } from '../appointments/appointments.service.js';
import { canChange } from '../public-booking/can-change.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ChannelRegistry } from './channels/channel-registry.js';
import { switchClientChannelOff, turnClientChannelOn } from './client-channels.js';
import { channelOff } from './link-tokens.service.js';

// A client's WhatsApp, found through one online booking. The number belongs to their card — or to their
// guardian's, when they have no phone (E9, decision 4) — so every booking of that phone gets the messages.
// The caller has found the booking by its manage token; everything here is filtered by that booking's business.
@Injectable()
export class ClientWhatsappService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: ChannelRegistry,
  ) {}

  assertOn(): void {
    if (!this.channels.isOn('WHATSAPP')) throw channelOff();
  }

  // The booking is read and checked in the transaction that writes the channel, so a cancel at the same moment
  // can't slip in between.
  async turnOn(booking: { businessId: string; id: string }, locale: string, manageLink: string): Promise<void> {
    const { businessId, id } = booking;
    await this.prisma.$transaction(async (tx) => {
      const appointment = await tx.appointment.findFirstOrThrow({
        where: { id, businessId },
        select: {
          id: true,
          clientId: true,
          startsAt: true,
          status: true,
          client: { select: { phone: true, guardian: { select: { id: true, phone: true } } } },
        },
      });
      if (!canChange(appointment, new Date()))
        throw statusConflict('badTransition', 'The booking can no longer change');
      const { client } = appointment;
      const card =
        client.phone === null
          ? { id: client.guardian?.id, phone: client.guardian?.phone }
          : { id: appointment.clientId, phone: client.phone };
      // A booking nobody's phone is on has nowhere to send to: WhatsApp can't be turned on for it.
      if (!card.id || !card.phone) throw channelOff();
      await turnClientChannelOn(tx, {
        businessId,
        appointment,
        card: card.id,
        kind: 'WHATSAPP',
        address: card.phone,
        locale,
        manageLink,
      });
    });
  }

  // The card's and the guardian's, whichever the booking reaches. Works with the channel off too: someone who asked
  // not to be told must not be told when it comes back on.
  async turnOff(booking: { businessId: string; id: string }, now: Date): Promise<void> {
    await switchClientChannelOff(this.prisma, booking, 'WHATSAPP', now);
  }
}
