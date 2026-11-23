import { Injectable, UnauthorizedException } from '@nestjs/common';

import { businessSelect } from '../business/business.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Locale } from './locale.js';
import { toUser, userSelect } from './user.schema.js';
import type { Account } from './account.schema.js';

@Injectable()
export class AccountService {
  constructor(private readonly prisma: PrismaService) {}

  // The account and the businesses it belongs to: what the front needs right after sign-in.
  async describe(userId: string): Promise<Account> {
    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        ...userSelect,
        memberships: {
          orderBy: { createdAt: 'asc' },
          select: { role: true, business: { select: businessSelect } },
        },
      },
    });
    // Deleted between the session check and here: the session is gone with it.
    if (!account) throw new UnauthorizedException();
    const { memberships, ...user } = account;
    return {
      user: toUser(user),
      businesses: memberships.map(({ role, business }) => ({ ...business, role })),
    };
  }

  async setLocale(userId: string, locale: Locale): Promise<void> {
    // updateMany: a user deleted since the session check is nothing to update, not a 500 (P2025).
    await this.prisma.user.updateMany({ where: { id: userId }, data: { locale } });
  }
}
