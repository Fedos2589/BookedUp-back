import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { violatedUniqueConstraint } from '../prisma/unique-violation.js';
import type {
  ClientCardDto,
  ClientDto,
  ClientInput,
  ClientPatch,
  ClientsPageDto,
  ClientsQuery,
} from './clients.schema.js';

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
      throw await this.translate(error, businessId, phone);
    }
  }

  async card(businessId: string, id: string): Promise<ClientCardDto> {
    const row = await this.prisma.client.findFirst({
      where: { id, businessId },
      select: {
        ...clientSelect,
        dependents: { select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] },
      },
    });
    if (!row) throw new NotFoundException();
    const visitCount = await this.prisma.appointment.count({ where: { businessId, clientId: id, status: 'DONE' } });
    const { dependents, ...client } = row;
    return { ...toDto(client), dependents, visitCount };
  }

  // Past bookings keep what was written on them (clientName, clientPhone): only the card changes.
  async update(businessId: string, id: string, { name, phone, note }: ClientPatch): Promise<ClientDto> {
    const client = await this.prisma.client.findFirst({ where: { id, businessId }, select: { guardianId: true } });
    if (!client) throw new NotFoundException();
    if (phone && client.guardianId) throw conflict('notHolder', 'A dependent has no phone of their own');
    try {
      const updated = await this.prisma.client.update({
        // businessId again: the id alone must never reach another business's row.
        where: { businessId_id: { businessId, id } },
        data: { name, phone, note },
        select: clientSelect,
      });
      return toDto(updated);
    } catch (error) {
      throw await this.translate(error, businessId, phone);
    }
  }

  // A taken phone is 409 with the holder who has it; anything else is not ours to explain.
  private async translate(error: unknown, businessId: string, phone: string | undefined) {
    if (!phone || violatedUniqueConstraint(error) !== 'clients_business_id_phone_key') return error;
    const holder = await this.prisma.client.findFirstOrThrow({ where: { businessId, phone }, select: { id: true } });
    return conflict('phoneTaken', 'This phone already has an account', holder.id);
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
