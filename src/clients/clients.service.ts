import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { appointmentSelect } from '../appointments/appointments.select.js';
import type { AuthUser } from '../auth/auth-types.js';
import { BusinessPolicy } from '../business/business.policy.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { violatedUniqueConstraint } from '../prisma/unique-violation.js';
import { withIsoTimes } from '../schedule/db-values.js';
import type { ClientAppointmentsPageDto } from './client-appointments.schema.js';
import type {
  ClientCardDto,
  ClientDto,
  ClientInput,
  ClientPatch,
  ClientsPageDto,
  Paging,
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

// The database or a transaction of it.
type Db = Pick<Prisma.TransactionClient, 'client'>;

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: BusinessPolicy,
  ) {}

  create(businessId: string, input: ClientInput): Promise<ClientDto> {
    return this.createIn(this.prisma, businessId, input).then(({ client }) => client);
  }

  // A person for a booking, in the booking's transaction: an existing one of this business (404
  // otherwise) or a new one. What the booking writes about them is what they are called now and the
  // phone to call: their own, or their guardian's.
  async resolveForBooking(
    tx: Db,
    businessId: string,
    who: { clientId: string } | { newClient: ClientInput },
  ): Promise<{ clientId: string; clientName: string; clientPhone: string }> {
    if ('newClient' in who) {
      const { client, phone } = await this.createIn(tx, businessId, who.newClient);
      return { clientId: client.id, clientName: client.name, clientPhone: phone };
    }
    const person = await tx.client.findFirst({
      where: { id: who.clientId, businessId },
      select: { id: true, name: true, phone: true, guardian: { select: { phone: true } } },
    });
    if (!person) throw new NotFoundException();
    return { clientId: person.id, clientName: person.name, clientPhone: (person.phone ?? person.guardian?.phone)! };
  }

  private async createIn(db: Db, businessId: string, input: ClientInput) {
    const { name, note } = input;
    const guardianId = 'guardianId' in input ? input.guardianId : undefined;
    const ownPhone = 'phone' in input ? input.phone : undefined;
    const guardianPhone = guardianId ? await this.requireHolder(db, businessId, guardianId) : undefined;
    try {
      const created = await db.client.create({
        data: { businessId, name, note, phone: ownPhone, guardianId },
        select: clientSelect,
      });
      return { client: toDto(created), phone: (ownPhone ?? guardianPhone)! };
    } catch (error) {
      throw await this.translate(error, businessId, ownPhone);
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

  // The history, newest first, cancelled too. A member who may not see every booking gets only
  // those of their own schedule, in the count as well.
  async appointments(
    actor: AuthUser,
    businessId: string,
    id: string,
    { limit, offset }: Paging,
  ): Promise<ClientAppointmentsPageDto> {
    if (!(await this.prisma.client.findFirst({ where: { id, businessId }, select: { id: true } }))) {
      throw new NotFoundException();
    }
    const seeAll = await this.policy.seeAllBookings(actor, businessId);
    const where = { businessId, clientId: id, ...(!seeAll && { staff: { userId: actor.id } }) };
    const [items, total] = await Promise.all([
      this.prisma.appointment.findMany({
        where,
        select: appointmentSelect,
        orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: offset,
      }),
      this.prisma.appointment.count({ where }),
    ]);
    return { items: items.map(withIsoTimes), total };
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
    const holder = await this.prisma.client.findFirst({ where: { businessId, phone }, select: { id: true } });
    return conflict('phoneTaken', 'This phone already has an account', holder?.id);
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
  private async requireHolder(db: Db, businessId: string, id: string) {
    const guardian = await db.client.findFirst({ where: { id, businessId }, select: { phone: true } });
    if (!guardian) throw new NotFoundException();
    if (!guardian.phone) throw conflict('notHolder', 'A guardian must have a phone of their own');
    return guardian.phone;
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
  // A Russian 8 at the start is the +7 of the stored number.
  const typed = digits.startsWith('8') && digits.length > 1 ? [digits, `7${digits.slice(1)}`] : digits ? [digits] : [];
  return {
    businessId,
    OR: [
      { name: { contains: q, mode: 'insensitive' } },
      ...typed.flatMap((part) => [{ phone: { contains: part } }, { guardian: { is: { phone: { contains: part } } } }]),
    ],
  };
};
