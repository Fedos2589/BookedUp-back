import { PrismaPg } from '@prisma/adapter-pg';
import { inject } from 'vitest';

import { PrismaClient } from '../src/generated/prisma/client.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: inject('databaseUrl') }),
});

const GLOBAL_TABLES = ['businesses', 'users', '_prisma_migrations'];

let seq = 0;
const unique = () => `${Date.now()}-${++seq}`;

const createBusiness = (slug = `studio-${unique()}`) =>
  prisma.business.create({ data: { name: 'Studio', slug, timeZone: 'Europe/Moscow' } });

const createUser = (email = `owner-${unique()}@example.com`) =>
  prisma.user.create({ data: { email, passwordHash: 'hash', name: 'Owner' } });

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
      data: { businessId: business.id, userId: user.id, role: 'OWNER' },
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

describe('memberships', () => {
  it('gives a user one role per business, but lets them join several businesses', async () => {
    const [first, second] = [await createBusiness(), await createBusiness()];
    const user = await createUser();

    await prisma.membership.create({ data: { businessId: first.id, userId: user.id, role: 'OWNER' } });
    await prisma.membership.create({ data: { businessId: second.id, userId: user.id, role: 'MASTER' } });

    await expect(
      prisma.membership.create({ data: { businessId: first.id, userId: user.id, role: 'ADMIN' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});
