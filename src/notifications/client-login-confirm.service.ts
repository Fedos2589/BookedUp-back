import { Injectable } from '@nestjs/common';

import { type Locale, localeSchema } from '../account/locale.js';
import { PrismaService } from '../prisma/prisma.service.js';

// The bot's half of a client's sign-in (E7b): Start with the nonce binds the chat to the login, the
// shared contact confirms the phone. The browser takes the session later (client-session module).
@Injectable()
export class ClientLoginConfirmService {
  constructor(private readonly prisma: PrismaService) {}

  // The login's language, or null when no live unconfirmed login has this nonce.
  async begin(nonceHash: string, chatId: string): Promise<Locale | null> {
    const login = await this.prisma.clientLogin.findFirst({
      where: { nonceHash, confirmedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, locale: true },
    });
    if (!login) return null;
    const { count } = await this.prisma.clientLogin.updateMany({
      where: { id: login.id, confirmedAt: null },
      data: { chatId },
    });
    return count === 1 ? localeSchema.parse(login.locale) : null;
  }

  // The newest live login of this chat, confirmed with `phone` (E.164); null when there is none.
  async confirm(chatId: string, phone: string): Promise<Locale | null> {
    const login = await this.prisma.clientLogin.findFirst({
      where: { chatId, confirmedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, locale: true },
    });
    if (!login) return null;
    const { count } = await this.prisma.clientLogin.updateMany({
      where: { id: login.id, confirmedAt: null },
      data: { phone, confirmedAt: new Date() },
    });
    return count === 1 ? localeSchema.parse(login.locale) : null;
  }
}
