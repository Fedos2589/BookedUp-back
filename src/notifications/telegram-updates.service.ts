import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import { type Locale, localeSchema } from '../account/locale.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { hashRandomToken } from '../common/random-token.js';
import { TelegramClient } from './channels/telegram.client.js';

// The part of an update we read: a text message from a private chat. Anything else is not for us.
const startUpdate = z.object({
  message: z.object({
    text: z.string().regex(/^\/start \S{1,128}$/),
    chat: z.object({ id: z.number().int() }),
    from: z.object({ language_code: z.string().optional() }).optional(),
  }),
});

const TEXTS: Record<Locale, { connected: string; expired: string }> = {
  en: { connected: "Connected: you'll get your bookings here", expired: 'This link has expired, open it again' },
  ru: { connected: 'Подключено: записи будут приходить сюда', expired: 'Ссылка истекла, откройте её заново' },
};

type Link = {
  user_id: string | null;
  business_id: string | null;
  appointment_id: string | null;
  locale: string;
  manage_link: string | null;
};

// What the bot does with what Telegram sends: a Start press with a link token connects the chat (M2 made
// the token). The token is used up in the same transaction that saves the chat.
@Injectable()
export class TelegramUpdatesService {
  private readonly logger = new Logger(TelegramUpdatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramClient,
  ) {}

  // Never throws: a failed update is logged, Telegram would only send it again.
  async handleUpdate(update: unknown): Promise<void> {
    const parsed = startUpdate.safeParse(update);
    if (!parsed.success) return;
    const { text, chat, from } = parsed.data.message;
    const spoken = localeSchema.safeParse(from?.language_code);
    try {
      const reply = await this.connect(text.slice('/start '.length), chat.id, spoken.success ? spoken.data : null);
      if (reply !== null) await this.reply(chat.id, reply);
    } catch (err) {
      this.logger.warn({ err }, 'Handling a Telegram update failed');
    }
  }

  // The reply to send, or null when the CHANNEL_ON message will do.
  private async connect(token: string, chatId: number, spoken: Locale | null): Promise<string | null> {
    const hash = hashRandomToken(token);
    return this.prisma.$transaction(async (tx) => {
      const [link] = await tx.$queryRaw<Link[]>`
        DELETE FROM channel_link_tokens WHERE token_hash = ${hash} AND expires_at > now()
        RETURNING user_id, business_id, appointment_id, locale, manage_link`;
      if (!link) return TEXTS[spoken ?? 'en'].expired;

      if (link.user_id !== null) {
        const user = await tx.user.findUniqueOrThrow({ where: { id: link.user_id }, select: { locale: true } });
        // One chat per account: a new one replaces the old.
        await tx.userChannel.deleteMany({ where: { userId: link.user_id, kind: 'TELEGRAM' } });
        await tx.userChannel.create({ data: { userId: link.user_id, kind: 'TELEGRAM', address: String(chatId) } });
        return TEXTS[localeSchema.parse(user.locale)].connected;
      }

      const businessId = link.business_id!;
      const appointment = await tx.appointment.findFirst({
        where: { id: link.appointment_id!, businessId },
        select: { id: true, clientId: true, startsAt: true },
      });
      if (!appointment) return TEXTS[spoken ?? localeSchema.parse(link.locale)].expired;
      const locale = spoken ?? localeSchema.parse(link.locale);
      const address = String(chatId);
      const existing = await tx.clientChannel.findFirst({
        where: { businessId, clientId: appointment.clientId, kind: 'TELEGRAM', address, appointmentId: appointment.id },
        select: { id: true, disabledAt: true },
      });
      // The same chat again is not news, unless it had been switched off.
      if (existing && existing.disabledAt === null) return null;
      const channel = existing
        ? await tx.clientChannel.update({ where: { id: existing.id }, data: { disabledAt: null, locale } })
        : await tx.clientChannel.create({
            data: {
              businessId,
              clientId: appointment.clientId,
              appointmentId: appointment.id,
              kind: 'TELEGRAM',
              address,
              locale,
            },
          });
      await tx.notificationEvent.create({
        data: {
          businessId,
          appointmentId: appointment.id,
          kind: 'CHANNEL_ON',
          actorUserId: null,
          startsAt: appointment.startsAt,
          channelId: channel.id,
          payload: { manageLink: link.manage_link },
        },
      });
      return null;
    });
  }

  // Straight to the chat, not through the outbox: the person is waiting for an answer to a button.
  private async reply(chatId: number, text: string): Promise<void> {
    await this.telegram.call('sendMessage', { chat_id: chatId, text });
  }
}
