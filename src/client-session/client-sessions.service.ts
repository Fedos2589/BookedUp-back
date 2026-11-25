import { Injectable } from '@nestjs/common';

import { hashRandomToken, newRandomToken } from '../common/random-token.js';
import type { PrismaService } from '../prisma/prisma.service.js';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type Db = Pick<PrismaService, 'clientSession'>;

// A client's session on the public pages (D9): global, one per confirmed phone and browser. Only the
// token's hash is stored.
@Injectable()
export class ClientSessionsService {
  // `db`: the transaction that used up the login, so a session never exists without it having been used.
  async create(db: Db, { phone, chatId }: { phone: string; chatId: string }): Promise<string> {
    const token = newRandomToken();
    await db.clientSession.create({
      data: { tokenHash: hashRandomToken(token), phone, chatId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
    });
    return token;
  }
}
