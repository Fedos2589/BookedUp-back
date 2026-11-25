import { Injectable } from '@nestjs/common';

import { hashRandomToken, newRandomToken } from '../common/random-token.js';
import { PrismaService } from '../prisma/prisma.service.js';

export type ClientSession = { id: string; phone: string; chatId: string };

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type Db = Pick<PrismaService, 'clientSession'>;

// A client's session on the public pages (D9): global, one per confirmed phone and browser. Only the
// token's hash is stored.
@Injectable()
export class ClientSessionsService {
  constructor(private readonly prisma: PrismaService) {}

  // `db`: the transaction that used up the login, so a session never exists without it having been used.
  async create(db: Db, { phone, chatId }: { phone: string; chatId: string }): Promise<string> {
    const token = newRandomToken();
    await db.clientSession.create({
      data: { tokenHash: hashRandomToken(token), phone, chatId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
    });
    return token;
  }

  // The live session of a cookie, whose expiry moves 30 days on from now (sliding). One statement: an
  // expired or ended session is never touched back to life.
  async find(token: string): Promise<ClientSession | null> {
    const [row] = await this.prisma.$queryRaw<{ id: string; phone: string; chat_id: string }[]>`
      UPDATE client_sessions
      SET last_used_at = now(), expires_at = now() + ${SESSION_TTL_MS} * interval '1 millisecond'
      WHERE token_hash = ${hashRandomToken(token)} AND expires_at > now()
      RETURNING id, phone, chat_id`;
    return row ? { id: row.id, phone: row.phone, chatId: row.chat_id } : null;
  }

  // Idempotent: no row, no error.
  async end(token: string): Promise<void> {
    await this.prisma.clientSession.deleteMany({ where: { tokenHash: hashRandomToken(token) } });
  }
}
