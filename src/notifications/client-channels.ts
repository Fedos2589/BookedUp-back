import type { Prisma, ChannelKind } from '../generated/prisma/client.js';

export type ClientChannelOn = {
  businessId: string;
  appointment: { id: string; clientId: string; startsAt: Date };
  // The client's card the channel hangs on, when it is not the booking's: a WhatsApp number belongs to the
  // card (or the guardian's), not to one booking. Unset, the channel is the booking's own.
  card?: string;
  kind: ChannelKind;
  address: string;
  // A push subscription's keys.
  keys?: { p256dh: string; auth: string };
  locale: string;
  // The booking's private link, repeated in the first message and wiped once it is out (decision 5).
  manageLink: string;
};

// Turns a channel on for one booking, in the caller's transaction, and queues its first message.
// New, or switched off and now on again: the row is written and a CHANNEL_ON event follows. Already
// on: nothing changes, and false comes back. One statement, so two requests at once are one channel.
export async function turnClientChannelOn(tx: Prisma.TransactionClient, on: ClientChannelOn): Promise<boolean> {
  const { businessId, appointment, kind, address } = on;
  const clientId = on.card ?? appointment.clientId;
  const appointmentId = on.card === undefined ? appointment.id : null;
  const [channel] = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO client_channels (business_id, client_id, appointment_id, kind, address, keys, locale)
    VALUES (${businessId}::uuid, ${clientId}::uuid, ${appointmentId}::uuid,
            ${kind}::"ChannelKind", ${address}, ${on.keys === undefined ? null : JSON.stringify(on.keys)}::jsonb,
            ${on.locale})
    ON CONFLICT (business_id, client_id, kind, address, appointment_id)
    DO UPDATE SET disabled_at = NULL, locale = EXCLUDED.locale, keys = EXCLUDED.keys
    WHERE client_channels.disabled_at IS NOT NULL
    RETURNING id`;
  // Already on: a push subscription may have a new key (the same endpoint, re-subscribed), no new event.
  if (!channel && on.keys !== undefined) {
    await tx.clientChannel.updateMany({
      where: { businessId, appointmentId, clientId, kind, address },
      data: { keys: on.keys },
    });
  }
  // A chat that never worked answers again: the other bookings of this business it was switched off for hear
  // it too (the dispatcher switches off every channel with an address that never worked). Not a push: a
  // gone endpoint never comes back, and a row the client switched off stays off.
  if (kind !== 'PUSH') {
    await tx.clientChannel.updateMany({
      where: { businessId, kind, address, disabledAt: { not: null } },
      data: { disabledAt: null },
    });
  }
  if (!channel) return false;
  await tx.notificationEvent.create({
    data: {
      businessId,
      appointmentId: appointment.id,
      kind: 'CHANNEL_ON',
      actorUserId: null,
      startsAt: appointment.startsAt,
      channelId: channel.id,
      payload: { manageLink: on.manageLink },
    },
  });
  return true;
}
