import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import { type Locale, localeSchema } from '../account/locale.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { hashRandomToken } from '../common/random-token.js';
import { canChange } from '../public-booking/can-change.js';
import { TelegramClient } from './channels/telegram.client.js';
import { turnClientChannelOn } from './client-channels.js';

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
      const reply = await this.connect(text.slice('/start '.length), chat.id, spoken.success ? spoken.data : 'en');
      if (reply !== null) await this.reply(chat.id, reply);
    } catch (err) {
      this.logger.warn({ err }, 'Handling a Telegram update failed');
    }
  }

  // The reply to send, or null when the CHANNEL_ON message will do. `spoken`: the chat's language, for a link
  // that is no longer known (its own language went with it).
  private async connect(token: string, chatId: number, spoken: Locale): Promise<string | null> {
    const hash = hashRandomToken(token);
    return this.prisma.$transaction(async (tx) => {
      const [link] = await tx.$queryRaw<Link[]>`
        DELETE FROM channel_link_tokens WHERE token_hash = ${hash} AND expires_at > now()
        RETURNING user_id, business_id, appointment_id, locale, manage_link`;
      if (!link) return TEXTS[spoken].expired;
      // The language the person chose where they asked for the link.
      const texts = TEXTS[localeSchema.parse(link.locale)];
      const address = String(chatId);

      if (link.user_id !== null) {
        // One chat per account: a new one replaces the old.
        await tx.userChannel.deleteMany({ where: { userId: link.user_id, kind: 'TELEGRAM' } });
        await tx.userChannel.create({ data: { userId: link.user_id, kind: 'TELEGRAM', address } });
        return texts.connected;
      }

      const businessId = link.business_id!;
      const appointment = await tx.appointment.findFirst({
        where: { id: link.appointment_id!, businessId },
        select: { id: true, clientId: true, startsAt: true, status: true },
      });
      // The link was good when it was given; the booking may have been cancelled or started since.
      if (!appointment || !canChange(appointment, new Date())) return texts.expired;
      // Already on: not news, but the person pressed Start and waits for a word.
      const isNew = await turnClientChannelOn(tx, {
        businessId,
        appointment,
        kind: 'TELEGRAM',
        address,
        locale: link.locale,
        manageLink: link.manage_link!,
      });
      if (!isNew) return texts.connected;
      return null;
    });
  }

  // Straight to the chat, not through the outbox: the person is waiting for an answer to a button.
  private async reply(chatId: number, text: string): Promise<void> {
    await this.telegram.call('sendMessage', { chat_id: chatId, text });
  }
}
