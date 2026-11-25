import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import { type Locale, localeSchema } from '../account/locale.js';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { hashRandomToken } from '../common/random-token.js';
import { canChange } from '../public-booking/can-change.js';
import { TelegramClient } from './channels/telegram.client.js';
import { clientPhone } from '../clients/clients.schema.js';
import { turnClientChannelOn } from './client-channels.js';
import { ClientLoginConfirmService } from './client-login-confirm.service.js';

// The part of an update we read: a text message from a private chat. Anything else is not for us.
const startUpdate = z.object({
  message: z.object({
    text: z.string().regex(/^\/start \S{1,128}$/),
    chat: z.object({ id: z.number().int() }),
    from: z.object({ language_code: z.string().optional() }).optional(),
  }),
});

// The phone a person shares with the button: their own (`user_id` is the sender), from a private chat.
const contactUpdate = z.object({
  message: z.object({
    contact: z.object({ phone_number: z.string().max(32), user_id: z.number().int().optional() }),
    chat: z.object({ id: z.number().int(), type: z.literal('private') }),
    from: z.object({ id: z.number().int(), language_code: z.string().optional() }),
  }),
});

const TEXTS: Record<
  Locale,
  {
    connected: string;
    expired: string;
    sharePhone: (host: string) => string;
    shareButton: string;
    phoneOk: string;
    ownPhone: string;
  }
> = {
  en: {
    connected: "Connected: you'll get your bookings here",
    expired: 'This link has expired, open it again',
    sharePhone: (host) =>
      `You are signing in on ${host}. If you didn't start it yourself, don't press anything. Share your phone to sign in`,
    shareButton: 'Share my phone',
    phoneOk: 'Phone confirmed, go back to the page',
    ownPhone: 'Use the button to share your own phone',
  },
  ru: {
    connected: 'Подключено: записи будут приходить сюда',
    expired: 'Ссылка истекла, откройте её заново',
    sharePhone: (host) =>
      `Вы входите на ${host}. Если вход начали не вы, ничего не нажимайте. Поделитесь номером телефона, чтобы войти`,
    shareButton: 'Поделиться номером',
    phoneOk: 'Телефон подтверждён, вернитесь на страницу',
    ownPhone: 'Нажмите кнопку, чтобы поделиться своим номером',
  },
};

const NOT_A_LINK_TOKEN = Symbol('not a link token');

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
    private readonly logins: ClientLoginConfirmService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // Never throws: a failed update is logged, Telegram would only send it again.
  async handleUpdate(update: unknown): Promise<void> {
    const contact = contactUpdate.safeParse(update);
    if (contact.success) return this.handleContact(contact.data.message);
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
    const reply = await this.prisma.$transaction(async (tx) => {
      const [link] = await tx.$queryRaw<Link[]>`
        DELETE FROM channel_link_tokens WHERE token_hash = ${hash} AND expires_at > now()
        RETURNING user_id, business_id, appointment_id, locale, manage_link`;
      if (!link) return NOT_A_LINK_TOKEN;
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
    // After the transaction: the sign-in talks to Telegram, which must not hold a transaction open.
    return reply === NOT_A_LINK_TOKEN ? this.startLogin(hash, chatId, spoken) : reply;
  }

  // Not a link token: maybe a client's sign-in. Its reply asks for the phone, with the share button.
  private async startLogin(nonceHash: string, chatId: number, spoken: Locale): Promise<string | null> {
    const locale = await this.logins.begin(nonceHash, String(chatId));
    if (locale === null) return TEXTS[spoken].expired;
    const texts = TEXTS[locale];
    await this.reply(chatId, texts.sharePhone(new URL(this.config.get('APP_URL', { infer: true })).host), {
      keyboard: [[{ text: texts.shareButton, request_contact: true }]],
      one_time_keyboard: true,
      resize_keyboard: true,
    });
    return null;
  }

  private async handleContact({ contact, chat, from }: z.infer<typeof contactUpdate>['message']): Promise<void> {
    const spoken = localeSchema.safeParse(from.language_code);
    const texts = TEXTS[spoken.success ? spoken.data : 'en'];
    try {
      // Someone else's contact (forwarded, or picked from the address book) proves nothing.
      if (contact.user_id !== from.id) return await this.reply(chat.id, texts.ownPhone);
      const phone = clientPhone.safeParse(`+${contact.phone_number.replace(/\D/g, '')}`);
      if (!phone.success) return await this.reply(chat.id, texts.ownPhone);
      const locale = await this.logins.confirm(String(chat.id), phone.data);
      if (locale === null) return await this.replyToStrayContact(chat.id, texts.expired);
      await this.reply(chat.id, TEXTS[locale].phoneOk, { remove_keyboard: true });
    } catch (err) {
      this.logger.warn({ err }, 'Handling a Telegram contact failed');
    }
  }

  // A chat that signed in before gets «expired»; one that never did sent a contact for no reason of ours.
  private async replyToStrayContact(chatId: number, expired: string): Promise<void> {
    if (await this.logins.hasLogin(String(chatId))) await this.reply(chatId, expired);
  }

  // Straight to the chat, not through the outbox: the person is waiting for an answer to a button.
  private async reply(chatId: number, text: string, replyMarkup?: object): Promise<void> {
    await this.telegram.call('sendMessage', {
      chat_id: chatId,
      text,
      ...(replyMarkup && { reply_markup: replyMarkup }),
    });
  }
}
