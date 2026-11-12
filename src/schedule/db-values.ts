import { BadRequestException } from '@nestjs/common';

import type { PrismaService } from '../prisma/prisma.service.js';
import { type LocalDate, todayIn } from './local-time.js';

// A DATE column comes back as midnight UTC of that day, and is written the same way.
export const localDateOf = (date: Date): LocalDate => date.toISOString().slice(0, 10);
export const dateColumn = (date: LocalDate) => new Date(`${date}T00:00:00Z`);

export const withIsoTimes = <T extends { startsAt: Date; endsAt: Date }>({ startsAt, endsAt, ...rest }: T) => ({
  ...rest,
  startsAt: startsAt.toISOString(),
  endsAt: endsAt.toISOString(),
});

// Today on the business's calendar.
export async function todayOfBusiness(prisma: PrismaService, businessId: string, now: Date): Promise<LocalDate> {
  const { timeZone } = await prisma.business.findUniqueOrThrow({
    where: { id: businessId },
    select: { timeZone: true },
  });
  return todayIn(timeZone, now);
}

// A write for a day already gone would never show up in a list (they start today), so it could
// be neither seen nor removed: refused instead, as a 400 on `date`.
export async function refusePastDate(prisma: PrismaService, businessId: string, date: LocalDate, now: Date) {
  if (date < (await todayOfBusiness(prisma, businessId, now))) throw new BadRequestException(['date: In the past']);
}
