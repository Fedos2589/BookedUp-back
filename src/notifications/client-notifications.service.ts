import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { cardsOf } from './booking-cards.js';
import type { ClientNotifications } from './channels.schema.js';

// `maria@example.com` → `m***@example.com`: enough for the booker to know which address it is, and never the whole
// local part, since anyone with the link can read this.
export const maskEmail = (email: string): string => {
  const at = email.lastIndexOf('@');
  return `${email.slice(0, 1)}***${email.slice(at)}`;
};

// What is on for one online booking. The caller has found the booking by its manage token; everything here is
// filtered by that booking's business and id.
@Injectable()
export class ClientNotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  // The same rows the dispatcher reads for the booking: its own, and the card rows of its cards (E9, decision 4; E7b D8).
  async of(booking: {
    businessId: string;
    id: string;
    clientId: string;
    client: { guardianId: string | null };
  }): Promise<ClientNotifications> {
    const { businessId, id } = booking;
    const rows = await this.prisma.clientChannel.findMany({
      where: {
        businessId,
        disabledAt: null,
        OR: [{ appointmentId: id }, { appointmentId: null, clientId: { in: cardsOf(booking) } }],
      },
      select: { kind: true, address: true },
      orderBy: { createdAt: 'asc' },
    });
    const email = rows.find((row) => row.kind === 'EMAIL');
    return {
      telegram: rows.some((row) => row.kind === 'TELEGRAM'),
      whatsapp: rows.some((row) => row.kind === 'WHATSAPP'),
      push: rows.filter((row) => row.kind === 'PUSH').map((row) => row.address),
      email: email === undefined ? null : maskEmail(email.address),
    };
  }

  // The client's Telegram off, whichever of it this booking reaches: its own and its cards' (E7b D8). Never
  // deletes: events and deliveries hang on the row. Works with Telegram off on the deployment too.
  async telegramOff(booking: { businessId: string; id: string }, now: Date): Promise<void> {
    const { businessId, id } = booking;
    const appointment = await this.prisma.appointment.findFirstOrThrow({
      where: { id, businessId },
      select: { clientId: true, client: { select: { guardianId: true } } },
    });
    await this.prisma.clientChannel.updateMany({
      where: {
        businessId,
        kind: 'TELEGRAM',
        disabledAt: null,
        OR: [{ appointmentId: id }, { appointmentId: null, clientId: { in: cardsOf(appointment) } }],
      },
      data: { disabledAt: now },
    });
  }
}
