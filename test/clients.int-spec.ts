import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { PrismaService } from '../src/prisma/prisma.service.js';
import { signUpOwner } from './helpers.js';
import { createTestApp } from './test-app.js';

let app: INestApplication<App>;

const http = () => request(app.getHttpServer());

const clientsUrl = (businessId: string) => `/businesses/${businessId}/clients`;

// Random, not a clock: test files run in parallel against one database.
const phone = () => `+7${randomUUID().replace(/\D/g, '').padEnd(10, '0').slice(0, 10)}`;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

const setUp = async () => {
  const owner = await signUpOwner(app);
  const businessId = owner.business.id;
  const url = clientsUrl(businessId);
  const create = (body: object) => http().post(url).set('Cookie', owner.cookie).send(body);
  const list = (query: object = {}) => http().get(url).set('Cookie', owner.cookie).query(query);
  const holder = async (name: string, number = phone()) =>
    (await create({ name, phone: number }).expect(201)).body as { id: string; name: string; phone: string };
  return { owner, businessId, create, list, holder };
};

describe('creating a client', () => {
  it('creates a holder with a phone and a dependent with a guardian', async () => {
    const { create, holder } = await setUp();
    const mother = await holder('Olga');

    const res = await create({ name: 'Masha', guardianId: mother.id, note: '  likes drawing ' }).expect(201);

    expect(res.body).toMatchObject({
      name: 'Masha',
      phone: null,
      guardianId: mother.id,
      guardian: { id: mother.id, name: 'Olga', phone: mother.phone },
      note: 'likes drawing',
      noShowCount: 0,
    });
  });

  it('answers 409 phoneTaken with the holder of the phone', async () => {
    const { create, holder } = await setUp();
    const mother = await holder('Olga');

    const res = await create({ name: 'Someone else', phone: mother.phone }).expect(409);

    expect(res.body).toMatchObject({ statusCode: 409, code: 'phoneTaken', clientId: mother.id });
  });

  it('gives one 201 and one 409 to two requests with one phone at once', async () => {
    const { create } = await setUp();
    const number = phone();

    const statuses = (await Promise.all([create({ name: 'A', phone: number }), create({ name: 'B', phone: number })]))
      .map((res) => res.status)
      .sort((a, b) => a - b);

    expect(statuses).toEqual([201, 409]);
  });

  it('answers 409 notHolder for a dependent as a guardian', async () => {
    const { create, holder } = await setUp();
    const kid = (await create({ name: 'Masha', guardianId: (await holder('Olga')).id }).expect(201)).body as {
      id: string;
    };

    const res = await create({ name: 'Baby', guardianId: kid.id }).expect(409);

    expect(res.body).toMatchObject({ statusCode: 409, code: 'notHolder' });
  });

  it('answers 404 for a guardian of another business and creates nothing', async () => {
    const { create, list } = await setUp();
    const stranger = await setUp();
    const theirs = await stranger.holder('Their mother');

    await create({ name: 'Masha', guardianId: theirs.id }).expect(404);

    expect((await list().expect(200)).body).toMatchObject({ items: [], total: 0 });
  });

  it('refuses a body that has both or neither of phone and guardianId, or a bad value', async () => {
    const { create, holder } = await setUp();
    const mother = await holder('Olga');

    await create({ name: 'X', phone: phone(), guardianId: mother.id }).expect(400);
    await create({ name: 'X' }).expect(400);
    await create({ name: '  ', phone: phone() }).expect(400);
    await create({ name: 'X'.repeat(101), phone: phone() }).expect(400);
    await create({ name: 'X', phone: '0812345678' }).expect(400);
    await create({ name: 'X', phone: phone(), note: 'n'.repeat(2001) }).expect(400);
  });
});

describe('finding clients', () => {
  it('gives the holder of a phone and their dependents, holder first', async () => {
    const { create, list, holder } = await setUp();
    await holder('Zed, someone else');
    const mother = await holder('Olga');
    await create({ name: 'Vanya', guardianId: mother.id }).expect(201);
    await create({ name: 'Anya', guardianId: mother.id }).expect(201);

    const res = await list({ phone: mother.phone }).expect(200);

    expect(res.body.items.map((c: { name: string }) => c.name)).toEqual(['Olga', 'Anya', 'Vanya']);
    expect(res.body.total).toBe(3);
  });

  it('finds by a part of the name in any case, and by digits of a phone, dependents through their guardian', async () => {
    const { create, list, holder } = await setUp();
    const mother = await holder('Anna Petrova');
    await create({ name: 'Masha', guardianId: mother.id }).expect(201);
    await holder('Boris');
    const names = async (q: string) =>
      ((await list({ q }).expect(200)).body.items as { name: string }[]).map((c) => c.name);

    expect(await names('PETRO')).toEqual(['Anna Petrova']);
    expect(await names(mother.phone.slice(-6))).toEqual(['Anna Petrova', 'Masha']);
    expect(await names('nobody')).toEqual([]);
  });

  it('pages by limit and offset with the total of all matches', async () => {
    const { list, holder } = await setUp();
    for (const name of ['Cora', 'Anna', 'Boris']) await holder(name);

    const first = (await list({ limit: 1 }).expect(200)).body;
    const rest = (await list({ limit: 5, offset: 1 }).expect(200)).body;

    expect(first.items.map((c: { name: string }) => c.name)).toEqual(['Anna']);
    expect(first.total).toBe(3);
    expect(rest.items.map((c: { name: string }) => c.name)).toEqual(['Boris', 'Cora']);
    await list({ limit: 0 }).expect(400);
    await list({ limit: 101 }).expect(400);
    await list({ q: 'q'.repeat(101) }).expect(400);
  });

  it("does not show another business's clients, even by phone", async () => {
    const { list } = await setUp();
    const stranger = await setUp();
    const theirs = await stranger.holder('Their client');

    expect((await list({ phone: theirs.phone }).expect(200)).body).toMatchObject({ items: [], total: 0 });
    expect((await list({ q: 'Their' }).expect(200)).body).toMatchObject({ items: [], total: 0 });
  });

  it('counts the no-shows of every client', async () => {
    const { businessId, list, holder } = await setUp();
    const olga = await holder('Olga');
    const prisma = app.get(PrismaService);
    const staff = await prisma.staff.create({ data: { businessId, name: 'Anna' }, select: { id: true } });
    const visit = (day: number, status: 'NO_SHOW' | 'DONE') =>
      prisma.appointment.create({
        data: {
          businessId,
          staffId: staff.id,
          clientId: olga.id,
          startsAt: new Date(Date.UTC(2030, 0, day, 10)),
          endsAt: new Date(Date.UTC(2030, 0, day, 11)),
          status,
          clientName: 'Olga',
          clientPhone: olga.phone,
        },
      });
    await visit(1, 'NO_SHOW');
    await visit(2, 'NO_SHOW');
    await visit(3, 'DONE');

    const res = await list({ phone: olga.phone }).expect(200);

    expect(res.body.items[0]).toMatchObject({ id: olga.id, noShowCount: 2 });
  });
});
