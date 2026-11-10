import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import type { Account } from './account.schema.js';

@Injectable()
export class AccountService {
  constructor(private readonly prisma: PrismaService) {}

  // The account and the businesses it belongs to: what the front needs right after sign-in.
  async describe(userId: string): Promise<Account> {
    const { memberships, ...user } = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        memberships: {
          orderBy: { createdAt: 'asc' },
          select: { role: true, business: { select: { id: true, name: true, slug: true, timeZone: true } } },
        },
      },
    });
    return { user, businesses: memberships.map(({ role, business }) => ({ ...business, role })) };
  }
}
