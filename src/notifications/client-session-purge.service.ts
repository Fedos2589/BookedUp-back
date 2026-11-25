import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

// Client sign-ins nobody will use again: logins past their 10 minutes, sessions past their expiry.
// Lives here, not in client-session, so the notifications job can call it without a module cycle.
@Injectable()
export class ClientSessionPurgeService {
  constructor(private readonly prisma: PrismaService) {}

  async purgeExpired(now: Date): Promise<number> {
    const [logins, sessions] = await this.prisma.$transaction([
      this.prisma.clientLogin.deleteMany({ where: { expiresAt: { lte: now } } }),
      this.prisma.clientSession.deleteMany({ where: { expiresAt: { lte: now } } }),
    ]);
    return logins.count + sessions.count;
  }
}
