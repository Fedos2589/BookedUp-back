import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { PrismaService } from '../src/prisma/prisma.service.js';
import { signUpOwner } from './helpers.js';
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
