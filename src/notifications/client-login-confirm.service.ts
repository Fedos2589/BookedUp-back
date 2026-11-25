import { Injectable } from '@nestjs/common';

import { type Locale, localeSchema } from '../account/locale.js';
import { PrismaService } from '../prisma/prisma.service.js';

// The bot's half of a client's sign-in (E7b): Start with the nonce binds the chat to the login, the
// shared contact confirms the phone. The browser takes the session later (client-session module).
// Each step is one UPDATE, so a nonce forwarded to a second chat can't take the login from the first.
@Injectable()
export class ClientLoginConfirmService {
  constructor(private readonly prisma: PrismaService) {}

  // The login's language, or null when no live unconfirmed login with this nonce is free for this chat
  // (unknown, expired, confirmed, or already bound to another chat).
  async begin(nonceHash: string, chatId: string): Promise<Locale | null> {
    const [login] = await this.prisma.$queryRaw<{ locale: string }[]>`
      UPDATE client_logins SET chat_id = ${chatId}
      WHERE nonce_hash = ${nonceHash} AND confirmed_at IS NULL AND expires_at > now()
        AND (chat_id IS NULL OR chat_id = ${chatId})
      RETURNING locale`;
    return login ? localeSchema.parse(login.locale) : null;
  }

  // The newest live login of this chat, confirmed with `phone` (E.164); null when there is none.
  async confirm(chatId: string, phone: string): Promise<Locale | null> {
    const [login] = await this.prisma.$queryRaw<{ locale: string }[]>`
      UPDATE client_logins SET phone = ${phone}, confirmed_at = now()
      WHERE chat_id = ${chatId} AND confirmed_at IS NULL AND id = (
        SELECT id FROM client_logins
        WHERE chat_id = ${chatId} AND confirmed_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC LIMIT 1)
      RETURNING locale`;
    return login ? localeSchema.parse(login.locale) : null;
  }

  // Whether this chat ever started a sign-in (even one that has expired): a contact from a chat that
  // never did is not ours to answer.
  async hasLogin(chatId: string): Promise<boolean> {
    return (await this.prisma.clientLogin.count({ where: { chatId } })) > 0;
  }
}
