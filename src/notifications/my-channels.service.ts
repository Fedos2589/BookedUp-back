import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { ChannelRegistry } from './channels/channel-registry.js';
import { channelOff } from './link-tokens.service.js';
import type { PushSubscription } from './push.schema.js';

// A member's own channels (E9, decision 6): they belong to the account, for every business it is in. Every
// query is by `userId`, the caller's, so nobody reaches another account's rows. Email is `users.email`, and
// Telegram connects through a link (M2, M3): only its removal is here.
@Injectable()
export class MyChannelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: ChannelRegistry,
  ) {}

  // One number per account: the old one goes, in the same transaction the new one comes.
  async setWhatsapp(userId: string, phone: string): Promise<void> {
    if (!this.channels.isOn('WHATSAPP')) throw channelOff();
    await this.prisma.$transaction(async (tx) => {
      await tx.userChannel.deleteMany({ where: { userId, kind: 'WHATSAPP', address: { not: phone } } });
      await tx.userChannel.upsert({
        where: { userId_kind_address: { userId, kind: 'WHATSAPP', address: phone } },
        create: { userId, kind: 'WHATSAPP', address: phone },
        update: {},
      });
    });
  }

  // Switching off works with the channel off too: someone who asked not to be told must not be told when it comes back on.
  async removeWhatsapp(userId: string): Promise<void> {
    await this.prisma.userChannel.deleteMany({ where: { userId, kind: 'WHATSAPP' } });
  }

  // The same endpoint again is the same device, with maybe a new key.
  async addPush(userId: string, { endpoint, keys }: PushSubscription): Promise<void> {
    if (!this.channels.isOn('PUSH')) throw channelOff();
    await this.prisma.userChannel.upsert({
      where: { userId_kind_address: { userId, kind: 'PUSH', address: endpoint } },
      create: { userId, kind: 'PUSH', address: endpoint, keys },
      update: { keys },
    });
  }

  // Only this account's row of that endpoint: another account's device is not found, so nothing goes.
  async removePush(userId: string, endpoint: string): Promise<void> {
    await this.prisma.userChannel.deleteMany({ where: { userId, kind: 'PUSH', address: endpoint } });
  }

  async removeTelegram(userId: string): Promise<void> {
    await this.prisma.userChannel.deleteMany({ where: { userId, kind: 'TELEGRAM' } });
  }
}
