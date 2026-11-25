import { Injectable } from '@nestjs/common';

import { type Locale, localeSchema } from '../account/locale.js';
import { hashRandomToken, newRandomToken } from '../common/random-token.js';
import { PrismaService } from '../prisma/prisma.service.js';

export type ClientSession = { id: string; phone: string; chatId: string; locale: Locale };

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SLIDE_EVERY_MS = 60 * 60 * 1000;

type Db = Pick<PrismaService, 'clientSession'>;

// A client's session on the public pages (D9): global, one per confirmed phone and browser. Only the
// token's hash is stored.
@Injectable()
export class ClientSessionsService {
  constructor(private readonly prisma: PrismaService) {}

  // `db`: the transaction that used up the login, so a session never exists without it having been used.
  async create(db: Db, { phone, chatId, locale }: { phone: string; chatId: string; locale: Locale }): Promise<string> {
    const token = newRandomToken();
    await db.clientSession.create({
      data: {
        tokenHash: hashRandomToken(token),
        phone,
        chatId,
        locale,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      },
    });
    return token;
  }

  // The live session of a cookie. Its expiry slides 30 days on from now, but at most once an hour: a read
  // that wrote on every request would make every page view a row update. An expired or ended session is
  // never touched back to life (the update repeats the live condition).
  async find(token: string): Promise<ClientSession | null> {
    const tokenHash = hashRandomToken(token);
    const now = new Date();
    const row = await this.prisma.clientSession.findFirst({ where: { tokenHash, expiresAt: { gt: now } } });
    if (!row) return null;
    if (row.lastUsedAt.getTime() < now.getTime() - SLIDE_EVERY_MS) {
      await this.prisma.clientSession.updateMany({
        where: { tokenHash, expiresAt: { gt: now } },
        data: { lastUsedAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) },
      });
    }
    return { id: row.id, phone: row.phone, chatId: row.chatId, locale: localeSchema.parse(row.locale) };
  }

  // Idempotent: no row, no error.
  async end(token: string): Promise<void> {
    await this.prisma.clientSession.deleteMany({ where: { tokenHash: hashRandomToken(token) } });
  }
}
