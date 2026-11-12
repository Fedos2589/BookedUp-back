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
    expect(violatedUniqueConstraint(error)).toBe('day_overrides_staff_id_date_key');
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
