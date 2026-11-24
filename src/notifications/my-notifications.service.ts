import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { ChannelRegistry } from './channels/channel-registry.js';
import type { MyBusinessNotifications, MyNotifications } from './my-notifications.schema.js';

@Injectable()
export class MyNotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: ChannelRegistry,
  ) {}

  async mine(userId: string): Promise<MyNotifications> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { notifyEmail: true, channels: { select: { kind: true, address: true }, orderBy: { createdAt: 'asc' } } },
    });
    return {
      email: user.notifyEmail,
      available: this.channels.available(),
      pushKey: this.channels.pushKey(),
      telegram: user.channels.some((c) => c.kind === 'TELEGRAM'),
      whatsapp: user.channels.find((c) => c.kind === 'WHATSAPP')?.address ?? null,
      push: user.channels.filter((c) => c.kind === 'PUSH').map((c) => c.address),
    };
  }

  async setEmail(userId: string, email: boolean): Promise<MyNotifications> {
    await this.prisma.user.update({ where: { id: userId }, data: { notifyEmail: email } });
    return this.mine(userId);
  }

  async allOnline(userId: string, businessId: string): Promise<MyBusinessNotifications> {
    const membership = await this.prisma.membership.findUnique({
      where: { userId_businessId: { userId, businessId } },
      select: { role: true, notifyAllOnline: true },
    });
    // Removed from the business between the guard and here.
    if (!membership) throw new ForbiddenException();
    return { allOnline: membership.role === 'MASTER' ? null : membership.notifyAllOnline };
  }

  // Only the caller's own membership, found by (user, business).
  async setAllOnline(userId: string, businessId: string, allOnline: boolean): Promise<MyBusinessNotifications> {
    if ((await this.allOnline(userId, businessId)).allOnline === null) {
      throw new BadRequestException(['allOnline: Not offered to a master']);
    }
    await this.prisma.membership.update({
      where: { userId_businessId: { userId, businessId } },
      data: { notifyAllOnline: allOnline },
    });
    return { allOnline };
  }
}
