import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { inject } from 'vitest';

import { PrismaClient } from '../src/generated/prisma/client.js';
import { violatedExclusion, violatedUniqueConstraint } from '../src/prisma/unique-violation.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: inject('databaseUrl') }),
});

// Not a business's data: tenants themselves, people, and how people sign in.
const GLOBAL_TABLES = ['businesses', 'users', 'password_logins', 'sessions', '_prisma_migrations'];

// Random, not a clock: test files run in parallel against one database.
const unique = () => randomUUID();

const createUser = (email = `user-${unique()}@example.com`) => prisma.user.create({ data: { email, name: 'User' } });

// A business always comes with its owner: the database refuses one without.
const createBusiness = (slug = `studio-${unique()}`) =>
  prisma.business.create({
    data: {
      name: 'Studio',
      slug,
      timeZone: 'Europe/Moscow',
      memberships: {
        create: { role: 'OWNER', user: { create: { email: `owner-${unique()}@example.com`, name: 'Owner' } } },
      },
    },
    include: { memberships: true },
  });

const ownerOf = (business: { memberships: { userId: string; role: string }[] }) =>
  business.memberships.find((m) => m.role === 'OWNER')!.userId;

afterAll(async () => {
  await prisma.$disconnect();
});

describe('schema rules every table follows', () => {
  it('stores every timestamp with a time zone (UTC in, business time zone out)', async () => {
    const naive = await prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type = 'timestamp without time zone'`;

    expect(naive).toEqual([]);
  });

  it('gives every tenant table a required business_id', async () => {
    const tables = await prisma.$queryRaw<{ table_name: string; has_business: boolean }[]>`
      SELECT t.table_name,
             EXISTS (SELECT 1 FROM information_schema.columns c
                     WHERE c.table_schema = 'public' AND c.table_name = t.table_name
                       AND c.column_name = 'business_id' AND c.is_nullable = 'NO') AS has_business
      FROM information_schema.tables t
      WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'`;

    const tenantTables = tables.filter((t) => !GLOBAL_TABLES.includes(t.table_name));
    expect(tenantTables.length).toBeGreaterThan(0);
    expect(tenantTables.filter((t) => !t.has_business)).toEqual([]);
  });
});

describe('defaults live in the database, so raw SQL (seeds, manual fixes) works too', () => {
  it('fills id with a UUID v7 and the timestamps when SQL leaves them out', async () => {
    const email = `raw-${unique()}@example.com`;
    await prisma.$executeRaw`INSERT INTO users (email, name) VALUES (${email}, 'Raw')`;

    const [row] = await prisma.$queryRaw<{ version: number; has_times: boolean }[]>`
      SELECT uuid_extract_version(id) AS version,
             created_at IS NOT NULL AND updated_at IS NOT NULL AS has_times
      FROM users WHERE email = ${email}`;
    expect(row).toEqual({ version: 7, has_times: true });
  });
});

describe('businesses', () => {
  it('rejects a slug that is already taken', async () => {
    const slug = `taken-${unique()}`;
    await createBusiness(slug);

    await expect(createBusiness(slug)).rejects.toMatchObject({ code: 'P2002' });
  });

  it('rejects a slug that differs from a taken one only in case', async () => {
    const slug = `studio-${unique()}`;
    await createBusiness(slug);

    await expect(createBusiness(slug.toUpperCase())).rejects.toThrow(/businesses_slug_format/);
  });

  it.each(['Studio-Lena', 'studio lena', '-studio', 'studio-', 'studio--lena', 'студия', ''])(
    'rejects the slug %j: lowercase latin letters and digits, single hyphens between',
    async (slug) => {
      await expect(createBusiness(slug)).rejects.toThrow(/businesses_slug_format/);
    },
  );

  it('accepts a slug like judo-kids-2', async () => {
    await expect(createBusiness(`judo-kids-2-${unique()}`)).resolves.toBeDefined();
  });

  it('deletes its locations and memberships with it, but not the users', async () => {
    const business = await createBusiness();
    const user = await createUser();
    await prisma.location.create({ data: { businessId: business.id, name: 'Main' } });
    await prisma.membership.create({
      data: { businessId: business.id, userId: user.id, role: 'MASTER' },
    });

    await prisma.business.delete({ where: { id: business.id } });

    expect(await prisma.location.count({ where: { businessId: business.id } })).toBe(0);
    expect(await prisma.membership.count({ where: { businessId: business.id } })).toBe(0);
    expect(await prisma.user.findUnique({ where: { id: user.id } })).not.toBeNull();
  });
});

describe('users', () => {
  it('rejects an email that is not lowercased, so uniqueness is case-insensitive', async () => {
    await expect(createUser(`Owner-${unique()}@Example.com`)).rejects.toThrow(/users_email_lowercase/);
  });

  it('rejects a second account with the same email', async () => {
    const email = `same-${unique()}@example.com`;
    await createUser(email);

    await expect(createUser(email)).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('password logins', () => {
  it('are optional: an account can exist before it has a password', async () => {
    const user = await createUser();

    expect(await prisma.passwordLogin.findUnique({ where: { userId: user.id } })).toBeNull();
  });

  it('allow one password per user and go away with the user', async () => {
    const user = await createUser();
    await prisma.passwordLogin.create({ data: { userId: user.id, passwordHash: 'hash' } });

    await expect(
      prisma.passwordLogin.create({ data: { userId: user.id, passwordHash: 'other' } }),
    ).rejects.toMatchObject({ code: 'P2002' });

    await prisma.user.delete({ where: { id: user.id } });
    expect(await prisma.passwordLogin.count({ where: { userId: user.id } })).toBe(0);
  });
});

describe('sessions', () => {
  const session = (userId: string) => {
    const now = new Date();
    return { id: `sha-${unique()}`, userId, createdAt: now, expiresAt: new Date(+now + 3_600_000), lastActiveAt: now };
  };

  it('belong to an existing user', async () => {
    await expect(prisma.session.create({ data: session('00000000-0000-7000-8000-000000000000') })).rejects.toThrow();
  });

  it('go away with the user', async () => {
    const user = await createUser();
    const { id } = await prisma.session.create({ data: session(user.id) });

    await prisma.user.delete({ where: { id: user.id } });

    expect(await prisma.session.findUnique({ where: { id } })).toBeNull();
  });
});

describe('memberships', () => {
  it('gives a user one role per business, but lets them join several businesses', async () => {
    const [first, second] = [await createBusiness(), await createBusiness()];
    const user = await createUser();

    await prisma.membership.create({ data: { businessId: first.id, userId: user.id, role: 'ADMIN' } });
    await prisma.membership.create({ data: { businessId: second.id, userId: user.id, role: 'MASTER' } });

    await expect(
      prisma.membership.create({ data: { businessId: first.id, userId: user.id, role: 'MASTER' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('memberships record changes', () => {
  it('moves updated_at when the role changes', async () => {
    const business = await createBusiness();
    const user = await createUser();
    const joined = await prisma.membership.create({
      data: { businessId: business.id, userId: user.id, role: 'ADMIN' },
    });

    const changed = await prisma.membership.update({ where: { id: joined.id }, data: { role: 'MASTER' } });

    expect(changed.updatedAt.getTime()).toBeGreaterThan(joined.updatedAt.getTime());
  });
});

describe('owners: every business has exactly one', () => {
  it('refuses a business created without an owner', async () => {
    await expect(
      prisma.business.create({ data: { name: 'Studio', slug: `studio-${unique()}`, timeZone: 'UTC' } }),
    ).rejects.toThrow(/has no owner/);
  });

  it('refuses a second owner', async () => {
    const business = await createBusiness();
    const user = await createUser();

    await expect(
      prisma.membership.create({ data: { businessId: business.id, userId: user.id, role: 'OWNER' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it("refuses to delete the owner's account while the business exists", async () => {
    const business = await createBusiness();

    await expect(prisma.user.delete({ where: { id: ownerOf(business) } })).rejects.toThrow(/has no owner/);
  });

  it('refuses to demote the only owner', async () => {
    const business = await createBusiness();

    await expect(
      prisma.membership.update({
        where: { userId_businessId: { userId: ownerOf(business), businessId: business.id } },
        data: { role: 'ADMIN' },
      }),
    ).rejects.toThrow(/has no owner/);
  });

  it('hands ownership over in one transaction: demote, then promote', async () => {
    const business = await createBusiness();
    const heir = await createUser();
    await prisma.membership.create({ data: { businessId: business.id, userId: heir.id, role: 'ADMIN' } });

    await prisma.$transaction([
      prisma.membership.update({
        where: { userId_businessId: { userId: ownerOf(business), businessId: business.id } },
        data: { role: 'ADMIN' },
      }),
      prisma.membership.update({
        where: { userId_businessId: { userId: heir.id, businessId: business.id } },
        data: { role: 'OWNER' },
      }),
    ]);

    const owners = await prisma.membership.findMany({ where: { businessId: business.id, role: 'OWNER' } });
    expect(owners.map((m) => m.userId)).toEqual([heir.id]);
  });
});

describe('the schedule in groups mode', () => {
  const staffOf = async () => {
    const business = await createBusiness();
    const staff = await prisma.staff.create({ data: { businessId: business.id, name: 'Coach' } });
    return { businessId: business.id, staffId: staff.id };
  };

  const insertGroup = (
    { businessId, staffId }: { businessId: string; staffId: string },
    weekdays: number[],
    capacity = 4,
  ) =>
    prisma.$executeRaw`
      INSERT INTO groups (business_id, staff_id, title, weekdays, start_minute, duration_minutes, capacity)
      VALUES (${businessId}::uuid, ${staffId}::uuid, 'Football', ${weekdays}::smallint[], 900, 60, ${capacity})`;

  it('refuses a group with no weekdays, a weekday outside 1–7, or capacity 0', async () => {
    const coach = await staffOf();

    await expect(insertGroup(coach, [])).rejects.toThrow(/groups_weekdays/);
    await expect(insertGroup(coach, [0, 2])).rejects.toThrow(/groups_weekdays/);
    await expect(insertGroup(coach, [8])).rejects.toThrow(/groups_weekdays/);
    await expect(insertGroup(coach, [2, 4], 0)).rejects.toThrow(/groups_capacity/);
    await expect(
      prisma.$executeRaw`
        INSERT INTO groups (business_id, staff_id, title, weekdays, start_minute, duration_minutes, capacity)
        VALUES (${coach.businessId}::uuid, ${coach.staffId}::uuid, 'Football', NULL, 900, 60, 4)`,
    ).rejects.toThrow(/weekdays/);
    await expect(insertGroup(coach, [2, 4])).resolves.toBe(1);
  });

  it('refuses two one-off sessions of one master that overlap', async () => {
    const coach = await staffOf();
    const session = (startsAt: string, endsAt: string) =>
      prisma.oneOffSession.create({
        data: { ...coach, title: 'Masterclass', startsAt: new Date(startsAt), endsAt: new Date(endsAt), capacity: 10 },
      });
    await session('2030-01-08T12:00:00Z', '2030-01-08T13:00:00Z');

    const error = await session('2030-01-08T12:30:00Z', '2030-01-08T13:30:00Z').catch((e: unknown) => e);
    expect(violatedExclusion(error)).toBe('OneOffSession');
    await expect(session('2030-01-08T13:00:00Z', '2030-01-08T14:00:00Z')).resolves.toBeDefined();
  });

  it('refuses a second day override for the same master and date', async () => {
    const coach = await staffOf();
    const override = () => prisma.dayOverride.create({ data: { ...coach, date: new Date('2030-01-08'), windows: [] } });
    await override();

    const error = await override().catch((e: unknown) => e);
    expect(violatedUniqueConstraint(error)).toBe('day_overrides_business_id_staff_id_date_key');
  });

  it('refuses a cancellation that points at a group of another business', async () => {
    const coach = await staffOf();
    const group = await prisma.group.create({
      data: { ...coach, title: 'Football', weekdays: [2], startMinute: 900, durationMinutes: 60, capacity: 4 },
    });
    const other = await createBusiness();

    await expect(
      prisma.groupCancellation.create({
        data: { businessId: other.id, groupId: group.id, date: new Date('2030-01-08') },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });
});

describe('appointments', () => {
  const staffOf = async () => {
    const business = await createBusiness();
    const staff = await prisma.staff.create({ data: { businessId: business.id, name: 'Master' } });
    return { businessId: business.id, staffId: staff.id };
  };

  const booking = (
    master: { businessId: string; staffId: string },
    startsAt: string,
    endsAt: string,
    extra: { status?: 'CANCELLED'; groupId?: string; oneOffSessionId?: string } = {},
  ) =>
    prisma.appointment.create({
      data: {
        ...master,
        startsAt: new Date(startsAt),
        endsAt: new Date(endsAt),
        clientName: 'Anna',
        clientPhone: '+66812345678',
        ...extra,
      },
    });

  it('refuses two overlapping bookings of one master, but not once the first is cancelled', async () => {
    const master = await staffOf();
    const first = await booking(master, '2030-01-08T10:00:00Z', '2030-01-08T11:00:00Z');

    const error = await booking(master, '2030-01-08T10:30:00Z', '2030-01-08T11:30:00Z').catch((e: unknown) => e);
    expect(violatedExclusion(error)).toBe('Appointment');
    await expect(booking(master, '2030-01-08T11:00:00Z', '2030-01-08T12:00:00Z')).resolves.toBeDefined();

    await prisma.appointment.update({ where: { id: first.id }, data: { status: 'CANCELLED' } });
    await expect(booking(master, '2030-01-08T10:30:00Z', '2030-01-08T10:45:00Z')).resolves.toBeDefined();
  });

  it('lets many seats share one group meeting', async () => {
    const master = await staffOf();
    const group = await prisma.group.create({
      data: { ...master, title: 'Football', weekdays: [2], startMinute: 900, durationMinutes: 60, capacity: 4 },
    });
    const seat = () => booking(master, '2030-01-08T15:00:00Z', '2030-01-08T16:00:00Z', { groupId: group.id });

    await seat();
    await expect(seat()).resolves.toBeDefined();
  });

  it('refuses an hours booking over a seat of the same master, and seats of two meetings that overlap', async () => {
    const master = await staffOf();
    const group = await prisma.group.create({
      data: { ...master, title: 'Football', weekdays: [2], startMinute: 900, durationMinutes: 60, capacity: 4 },
    });
    await booking(master, '2030-01-08T15:00:00Z', '2030-01-08T16:00:00Z', { groupId: group.id });

    const over = await booking(master, '2030-01-08T15:30:00Z', '2030-01-08T16:30:00Z').catch((e: unknown) => e);
    expect(violatedExclusion(over)).toBe('Appointment');
    const hours = await booking(master, '2030-01-08T17:00:00Z', '2030-01-08T18:00:00Z');
    const seatOver = await booking(master, '2030-01-08T17:30:00Z', '2030-01-08T18:30:00Z', {
      groupId: group.id,
    }).catch((e: unknown) => e);
    expect(violatedExclusion(seatOver)).toBe('Appointment');
    expect(hours.id).toBeDefined();
  });

  it('refuses a booking in a group and a one-off session at once, and one that runs over a day', async () => {
    const master = await staffOf();
    const group = await prisma.group.create({
      data: { ...master, title: 'Football', weekdays: [2], startMinute: 900, durationMinutes: 60, capacity: 4 },
    });
    const session = await prisma.oneOffSession.create({
      data: {
        ...master,
        title: 'Masterclass',
        startsAt: new Date('2030-01-09T12:00:00Z'),
        endsAt: new Date('2030-01-09T13:00:00Z'),
        capacity: 10,
      },
    });

    await expect(
      booking(master, '2030-01-09T12:00:00Z', '2030-01-09T13:00:00Z', {
        groupId: group.id,
        oneOffSessionId: session.id,
      }),
    ).rejects.toThrow(/appointments_one_parent/);
    await expect(booking(master, '2030-01-10T10:00:00Z', '2030-01-11T10:00:01Z')).rejects.toThrow(/appointments_span/);
    await expect(booking(master, '2030-01-10T10:00:00Z', '2030-01-10T10:00:00Z')).rejects.toThrow(/appointments_span/);
  });

  it('refuses a booking that points at a master or a group of another business', async () => {
    const master = await staffOf();
    const other = await staffOf();
    const group = await prisma.group.create({
      data: { ...other, title: 'Football', weekdays: [2], startMinute: 900, durationMinutes: 60, capacity: 4 },
    });

    await expect(
      booking(
        { businessId: master.businessId, staffId: other.staffId },
        '2030-01-08T10:00:00Z',
        '2030-01-08T11:00:00Z',
      ),
    ).rejects.toMatchObject({ code: 'P2003' });
    await expect(
      booking(master, '2030-01-08T10:00:00Z', '2030-01-08T11:00:00Z', { groupId: group.id }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('refuses a seat of one master in a group or a session of another master of the same business', async () => {
    const master = await staffOf();
    const colleague = await prisma.staff.create({ data: { businessId: master.businessId, name: 'Colleague' } });
    const group = await prisma.group.create({
      data: { ...master, title: 'Football', weekdays: [2], startMinute: 900, durationMinutes: 60, capacity: 4 },
    });
    const session = await prisma.oneOffSession.create({
      data: {
        ...master,
        title: 'Masterclass',
        startsAt: new Date('2030-01-09T12:00:00Z'),
        endsAt: new Date('2030-01-09T13:00:00Z'),
        capacity: 10,
      },
    });
    const other = { businessId: master.businessId, staffId: colleague.id };

    await expect(
      booking(other, '2030-01-08T15:00:00Z', '2030-01-08T16:00:00Z', { groupId: group.id }),
    ).rejects.toMatchObject({ code: 'P2003' });
    await expect(
      booking(other, '2030-01-09T12:00:00Z', '2030-01-09T13:00:00Z', { oneOffSessionId: session.id }),
    ).rejects.toMatchObject({ code: 'P2003' });
    await expect(
      booking(master, '2030-01-09T12:00:00Z', '2030-01-09T13:00:00Z', { oneOffSessionId: session.id }),
    ).resolves.toBeDefined();
  });

  it('refuses a session of another business', async () => {
    const master = await staffOf();
    const other = await staffOf();
    const session = await prisma.oneOffSession.create({
      data: {
        ...other,
        title: 'Masterclass',
        startsAt: new Date('2030-01-09T12:00:00Z'),
        endsAt: new Date('2030-01-09T13:00:00Z'),
        capacity: 10,
      },
    });

    await expect(
      booking(master, '2030-01-09T12:00:00Z', '2030-01-09T13:00:00Z', { oneOffSessionId: session.id }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('keeps the history: a master with bookings cannot be deleted, a business with them can', async () => {
    const master = await staffOf();
    await booking(master, '2030-01-08T10:00:00Z', '2030-01-08T11:00:00Z');

    await expect(prisma.staff.delete({ where: { id: master.staffId } })).rejects.toMatchObject({ code: 'P2003' });
    await prisma.business.delete({ where: { id: master.businessId } });
    expect(await prisma.appointment.count({ where: { businessId: master.businessId } })).toBe(0);
  });

  it('does not carry seats along when a group changes its master', async () => {
    const master = await staffOf();
    const colleague = await prisma.staff.create({ data: { businessId: master.businessId, name: 'Colleague' } });
    const group = await prisma.group.create({
      data: { ...master, title: 'Football', weekdays: [2], startMinute: 900, durationMinutes: 60, capacity: 4 },
    });
    await booking(master, '2030-01-08T15:00:00Z', '2030-01-08T16:00:00Z', { groupId: group.id });

    await expect(
      prisma.group.update({ where: { id: group.id }, data: { staffId: colleague.id } }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('refuses a phone that is not E.164 and a blank name', async () => {
    const master = await staffOf();
    const withClient = (clientName: string, clientPhone: string) =>
      prisma.appointment.create({
        data: {
          ...master,
          startsAt: new Date('2030-01-08T10:00:00Z'),
          endsAt: new Date('2030-01-08T11:00:00Z'),
          clientName,
          clientPhone,
        },
      });

    await expect(withClient('Anna', '')).rejects.toThrow(/appointments_client_phone/);
    await expect(withClient('Anna', '0812345678')).rejects.toThrow(/appointments_client_phone/);
    await expect(withClient('  ', '+66812345678')).rejects.toThrow(/appointments_client_name/);
    await expect(withClient('Anna', '+66812345678')).resolves.toBeDefined();
  });
});

describe('clients', () => {
  const phone = () => `+7${unique().replace(/\D/g, '').padEnd(10, '0').slice(0, 10)}`;
  const holder = (businessId: string, p = phone()) =>
    prisma.client.create({ data: { businessId, name: 'Mother', phone: p } });

  it('is a holder with a phone or a dependent with a guardian, never both and never neither', async () => {
    const { id: businessId } = await createBusiness();
    const mother = await holder(businessId);

    await expect(
      prisma.client.create({ data: { businessId, name: 'Kid', phone: phone(), guardianId: mother.id } }),
    ).rejects.toThrow(/clients_phone_or_guardian/);
    await expect(prisma.client.create({ data: { businessId, name: 'Nobody' } })).rejects.toThrow(
      /clients_phone_or_guardian/,
    );
    await expect(
      prisma.client.create({ data: { businessId, name: 'Kid', guardianId: mother.id } }),
    ).resolves.toBeDefined();
  });

  it('refuses a phone that is not E.164', async () => {
    const { id: businessId } = await createBusiness();

    await expect(holder(businessId, '0812345678')).rejects.toThrow(/clients_phone/);
    await expect(holder(businessId, '')).rejects.toThrow(/clients_phone/);
  });

  it('gives a phone to one holder per business, and lets two businesses share it', async () => {
    const a = await createBusiness();
    const b = await createBusiness();
    const shared = phone();
    await holder(a.id, shared);

    const second = await holder(a.id, shared).catch((e: unknown) => e);
    expect(violatedUniqueConstraint(second)).toBe('clients_business_id_phone_key');
    await expect(holder(b.id, shared)).resolves.toBeDefined();
  });

  it('lets one guardian have several dependents', async () => {
    const { id: businessId } = await createBusiness();
    const mother = await holder(businessId);
    const kid = (name: string) => prisma.client.create({ data: { businessId, name, guardianId: mother.id } });

    await kid('Kid 1');
    await kid('Kid 2');

    expect(await prisma.client.count({ where: { guardianId: mother.id } })).toBe(2);
  });

  it('refuses a guardian from another business', async () => {
    const a = await createBusiness();
    const b = await createBusiness();
    const mother = await holder(a.id);

    await expect(
      prisma.client.create({ data: { businessId: b.id, name: 'Kid', guardianId: mother.id } }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });
});
