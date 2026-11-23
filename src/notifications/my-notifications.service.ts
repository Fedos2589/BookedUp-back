import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import type { MyBusinessNotifications, MyNotifications } from './my-notifications.schema.js';

@Injectable()
export class MyNotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async email(userId: string): Promise<MyNotifications> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { notifyEmail: true } });
    return { email: user.notifyEmail };
  }

  async setEmail(userId: string, email: boolean): Promise<MyNotifications> {
    await this.prisma.user.update({ where: { id: userId }, data: { notifyEmail: email } });
    return { email };
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
