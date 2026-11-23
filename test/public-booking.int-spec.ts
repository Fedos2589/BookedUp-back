import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { PrismaService } from '../src/prisma/prisma.service.js';
import { createClient, signUpOwner } from './helpers.js';
import { createTestApp } from './test-app.js';

let app: INestApplication<App>;
let prisma: PrismaService;

beforeAll(async () => {
  app = await createTestApp();
  prisma = app.get(PrismaService);
});

afterAll(async () => {
  await app.close();
});

// Public routes are called the way a visitor does: no cookie.
const http = () => request(app.getHttpServer());

describe('GET /public/businesses/:slug', () => {
  it('answers the business and its live masters by name, without a session', async () => {
    const { business } = await signUpOwner(app);
    const [zoe, adam] = await Promise.all(
      ['Zoe', 'Adam'].map((name) =>
        prisma.staff.create({ data: { businessId: business.id, name }, select: { id: true } }),
      ),
    );
    await prisma.staff.create({ data: { businessId: business.id, name: 'Gone', archivedAt: new Date() } });

    const res = await http().get(`/public/businesses/${business.slug}`).expect(200);

    expect(res.body).toEqual({
      name: business.name,
      slug: business.slug,
      timeZone: business.timeZone,
      masters: [
        { id: adam!.id, name: 'Adam', scheduleMode: 'HOURS' },
        { id: zoe!.id, name: 'Zoe', scheduleMode: 'HOURS' },
      ],
    });
  });

  it("doesn't list another business's masters", async () => {
    const mine = await signUpOwner(app);
    const other = await signUpOwner(app);
    await prisma.staff.create({ data: { businessId: other.business.id, name: 'Elsewhere' } });

    const res = await http().get(`/public/businesses/${mine.business.slug}`).expect(200);

    expect(res.body.masters).toEqual([]);
  });

  it('is 404 for an unknown slug and 400 for a malformed one', async () => {
    await http().get('/public/businesses/no-such-business-at-all').expect(404);
    await http().get('/public/businesses/A_B').expect(400);
  });

  it('is in Swagger under public-booking', async () => {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    const operation = document.paths['/public/businesses/{slug}']?.get;
    expect(operation?.tags).toEqual(['public-booking']);
  });
});

// Tuesday 2030-01-08, Moscow (UTC+3): hours from 10:00 (07:00Z), a group meeting at 15:00 (12:00Z).
const tuesday = '2030-01-08';
const at = (hour: number) => new Date(`${tuesday}T${String(hour).padStart(2, '0')}:00:00.000Z`);

const withSchedules = async () => {
  const owner = await signUpOwner(app);
  const businessId = owner.business.id;
  const as = (req: request.Test) => req.set('Cookie', owner.cookie);
  const master = async (name: string, mode: 'HOURS' | 'GROUPS') => {
    const id = (await as(http().post(`/businesses/${businessId}/staff`).send({ name })).expect(201)).body.id as string;
    await as(http().put(`/businesses/${businessId}/staff/${id}/schedule-mode`).send({ mode })).expect(200);
    return { id, base: `/businesses/${businessId}/staff/${id}` };
  };
  const hours = await master('Hana', 'HOURS');
  await as(
    http()
      .put(`${hours.base}/weekly-windows`)
      .send({ windows: [{ weekday: 2, startMinute: 600, durationMinutes: 120, slotMinutes: 60, title: null }] }),
  ).expect(200);
  const groups = await master('Gus', 'GROUPS');
  const group = (
    await as(
      http()
        .post(`${groups.base}/groups`)
        .send({
          title: 'Football',
          description: null,
          weekdays: [2],
          startMinute: 900,
          durationMinutes: 60,
          capacity: 5,
        }),
    ).expect(201)
  ).body.id as string;
  const book = async (staffId: string, startsAt: Date, extra: { groupId?: string } = {}) =>
    prisma.appointment.create({
      data: {
        businessId,
        clientId: await createClient(prisma, businessId),
        staffId,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3600_000),
        clientName: 'Olga',
        clientPhone: '+79991234567',
        ...extra,
      },
    });
  return { business: owner.business, hours, groups, group, book };
};

describe('GET /public/businesses/:slug/slots', () => {
  const slotsOf = (slug: string, query: Record<string, string> = {}) =>
    http()
      .get(`/public/businesses/${slug}/slots`)
      .query({ from: tuesday, to: tuesday, ...query });

  it('answers free hours and meetings with their counts, and nothing of the clients', async () => {
    const t = await withSchedules();
    await t.book(t.hours.id, at(7));
    await t.book(t.groups.id, at(12), { groupId: t.group });

    const res = await slotsOf(t.business.slug).expect(200);

    expect(res.body).toEqual([
      expect.objectContaining({ staffId: t.hours.id, startsAt: at(8).toISOString(), capacity: 1, booked: 0 }),
      expect.objectContaining({
        staffId: t.groups.id,
        startsAt: at(12).toISOString(),
        title: 'Football',
        capacity: 5,
        booked: 1,
        full: false,
        groupId: t.group,
      }),
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/Olga|79991234567/);
  });

  it("gives an empty list for another business's master", async () => {
    const mine = await withSchedules();
    const other = await withSchedules();

    const res = await slotsOf(mine.business.slug, { staffId: other.hours.id }).expect(200);

    expect(res.body).toEqual([]);
  });

  it('is 400 for more than 31 days (31 is fine) and 404 for an unknown slug', async () => {
    const t = await withSchedules();
    await slotsOf(t.business.slug, { to: '2030-02-17' }).expect(400);
    await slotsOf(t.business.slug, { to: '2030-02-07' }).expect(200);
    await slotsOf('no-such-business-at-all').expect(404);
  });

  it('never looks back: includePast is not offered', async () => {
    const t = await withSchedules();
    const res = await http()
      .get(`/public/businesses/${t.business.slug}/slots`)
      .query({ from: '2020-01-07', to: '2020-01-07', includePast: 'true' })
      .expect(200);
    expect(res.body).toEqual([]);
  });
});
