import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

// How long a login stays after its ten minutes: the bot still knows the chat and can answer «expired» to a
// contact shared late (`ClientLoginConfirmService.hasLogin`).
const LOGIN_KEPT_MS = 24 * 60 * 60 * 1000;

// Client sign-ins nobody will use again: logins a day past their expiry, sessions past theirs.
// Lives here, not in client-session, so the notifications job can call it without a module cycle.
@Injectable()
export class ClientSessionPurgeService {
  constructor(private readonly prisma: PrismaService) {}

  async purgeExpired(now: Date): Promise<number> {
    const [logins, sessions] = await this.prisma.$transaction([
      this.prisma.clientLogin.deleteMany({ where: { expiresAt: { lte: new Date(now.getTime() - LOGIN_KEPT_MS) } } }),
      this.prisma.clientSession.deleteMany({ where: { expiresAt: { lte: now } } }),
    ]);
    return logins.count + sessions.count;
  }
}
