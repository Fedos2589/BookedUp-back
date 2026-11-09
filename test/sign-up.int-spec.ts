import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { PrismaService } from '../src/prisma/prisma.service.js';
import { createTestApp } from './test-app.js';

let app: INestApplication<App>;
let prisma: PrismaService;

let seq = 0;
const unique = () => `${Date.now()}${++seq}`;

const validBody = () => {
  const id = unique();
  return {
    email: `owner-${id}@example.com`,
    password: 'correct horse battery',
    name: 'Lena',
    business: { name: 'Studio Lena', slug: `studio-lena-${id}`, timeZone: 'Europe/Moscow' },
  };
};

const signUp = (body: unknown) => request(app.getHttpServer()).post('/auth/sign-up').send(body as object);

beforeAll(async () => {
  app = await createTestApp();
  prisma = app.get(PrismaService);
});

afterAll(async () => {
  await app.close();
});

describe('POST /auth/sign-up', () => {
  it('creates the owner, their password and the business in one go', async () => {
    const body = validBody();

    const res = await signUp(body).expect(201);

    expect(res.body).toEqual({
      user: { id: expect.any(String), email: body.email, name: 'Lena' },
      business: {
        id: expect.any(String),
        name: 'Studio Lena',
        slug: body.business.slug,
        timeZone: 'Europe/Moscow',
      },
    });
    const membership = await prisma.membership.findUnique({
      where: { userId_businessId: { userId: res.body.user.id, businessId: res.body.business.id } },
    });
    expect(membership?.role).toBe('OWNER');
  });

  it('stores a scrypt hash, never the password', async () => {
    const body = validBody();
    const res = await signUp(body).expect(201);

    const login = await prisma.passwordLogin.findUnique({ where: { userId: res.body.user.id } });
    expect(login?.passwordHash).toMatch(/^\$scrypt\$/);
    expect(login?.passwordHash).not.toContain(body.password);
  });

  it('lowercases the email and the slug', async () => {
    const body = validBody();
    const res = await signUp({
      ...body,
      email: body.email.toUpperCase(),
      business: { ...body.business, slug: body.business.slug.toUpperCase() },
    }).expect(201);

    expect(res.body.user.email).toBe(body.email);
    expect(res.body.business.slug).toBe(body.business.slug);
  });

  it('answers 409 on a taken email, whatever its case', async () => {
    const first = validBody();
    await signUp(first).expect(201);

    const res = await signUp({ ...validBody(), email: first.email.toUpperCase() }).expect(409);
    expect(res.body).toMatchObject({ field: 'email' });
  });

  it('answers 409 on a taken slug and creates nothing', async () => {
    const first = validBody();
    await signUp(first).expect(201);
    const second = { ...validBody(), business: { ...validBody().business, slug: first.business.slug } };

    const res = await signUp(second).expect(409);

    expect(res.body).toMatchObject({ field: 'slug' });
    expect(await prisma.user.findUnique({ where: { email: second.email } })).toBeNull();
  });

  it.each([
    ['an unknown time zone', { business: { timeZone: 'Moscow' } }, 'business.timeZone'],
    ['a slug with a space', { business: { slug: 'studio lena' } }, 'business.slug'],
    ['a short password', { password: 'short' }, 'password'],
    ['a malformed email', { email: 'not-an-email' }, 'email'],
  ])('answers 400 on %s, naming the field', async (_case, patch, field) => {
    const body = validBody();
    const res = await signUp({
      ...body,
      ...patch,
      business: { ...body.business, ...(patch as { business?: object }).business },
    }).expect(400);

    expect(res.body.message.join('\n')).toContain(`${field}:`);
  });
});

describe('OpenAPI', () => {
  it('describes the sign-up request body, so the front gets its types from Orval', async () => {
    const { SwaggerModule, DocumentBuilder } = await import('@nestjs/swagger');
    const doc = SwaggerModule.createDocument(app, new DocumentBuilder().build());

    const body = doc.paths['/auth/sign-up']?.post?.requestBody as
      | { content: { 'application/json': { schema: { properties?: object } } } }
      | undefined;
    expect(Object.keys(body?.content['application/json'].schema.properties ?? {})).toEqual(
      expect.arrayContaining(['email', 'password', 'name', 'business']),
    );
  });
});
