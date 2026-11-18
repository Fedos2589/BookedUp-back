import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { violatedUniqueConstraint } from '../prisma/unique-violation.js';
import type { ClientDto, ClientInput, ClientsPageDto, ClientsQuery } from './clients.schema.js';

const clientSelect = {
  id: true,
  name: true,
  phone: true,
  guardianId: true,
  guardian: { select: { id: true, name: true, phone: true } },
  note: true,
  _count: { select: { appointments: { where: { status: 'NO_SHOW' } } } },
} satisfies Prisma.ClientSelect;

type ClientRow = Prisma.ClientGetPayload<{ select: typeof clientSelect }>;

const toDto = ({ _count, guardian, ...client }: ClientRow): ClientDto => ({
  ...client,
  // A guardian is always a holder (a trigger in the database), so has a phone.
  guardian: guardian && { ...guardian, phone: guardian.phone! },
  noShowCount: _count.appointments,
});

const conflict = (code: 'phoneTaken' | 'notHolder', message: string, clientId?: string) =>
  new ConflictException({ statusCode: 409, error: 'Conflict', message, code, clientId });

@Injectable()
export class ClientsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(businessId: string, input: ClientInput): Promise<ClientDto> {
    const { name, note } = input;
    const guardianId = 'guardianId' in input ? input.guardianId : undefined;
    if (guardianId) await this.requireHolder(businessId, guardianId);
    const phone = 'phone' in input ? input.phone : undefined;
    try {
      const created = await this.prisma.client.create({
        data: { businessId, name, note, phone, guardianId },
        select: clientSelect,
      });
      return toDto(created);
    } catch (error) {
      if (phone && violatedUniqueConstraint(error) === 'clients_business_id_phone_key') {
        const holder = await this.prisma.client.findFirstOrThrow({
          where: { businessId, phone },
          select: { id: true },
        });
        throw conflict('phoneTaken', 'This phone already has an account', holder.id);
      }
      throw error;
    }
  }

  async list(businessId: string, { q, phone, limit, offset }: ClientsQuery): Promise<ClientsPageDto> {
    const where = phone ? byPhone(businessId, phone) : search(businessId, q);
    const [items, total] = await Promise.all([
      this.prisma.client.findMany({
        where,
        // The holder first: only a holder has a phone.
        orderBy: phone
          ? [{ phone: { sort: 'desc', nulls: 'last' } }, { name: 'asc' }, { id: 'asc' }]
          : [{ name: 'asc' }, { id: 'asc' }],
        ...(phone ? {} : { take: limit, skip: offset }),
        select: clientSelect,
      }),
      this.prisma.client.count({ where }),
    ]);
    return { items: items.map(toDto), total };
  }

  // The guardian is a holder of this business: another business's or a missing one is 404, a dependent 409.
  private async requireHolder(businessId: string, id: string) {
    const guardian = await this.prisma.client.findFirst({ where: { id, businessId }, select: { phone: true } });
    if (!guardian) throw new NotFoundException();
    if (!guardian.phone) throw conflict('notHolder', 'A guardian must have a phone of their own');
  }
}

const byPhone = (businessId: string, phone: string): Prisma.ClientWhereInput => ({
  businessId,
  OR: [{ phone }, { guardian: { is: { phone } } }],
});

// A name by any part, any case; a query that is only digits and phone punctuation also matches
// phones, and a dependent matches by the phone of their guardian (it is the one to call).
const search = (businessId: string, q: string | undefined): Prisma.ClientWhereInput => {
  if (!q) return { businessId };
  const digits = /^[\d\s()+-]+$/.test(q) ? q.replace(/\D/g, '') : '';
  return {
    businessId,
    OR: [
      { name: { contains: q, mode: 'insensitive' } },
      ...(digits ? [{ phone: { contains: digits } }, { guardian: { is: { phone: { contains: digits } } } }] : []),
    ],
  };
};
