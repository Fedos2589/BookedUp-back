import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { PrismaService } from '../src/prisma/prisma.service.js';
import { ownerInput } from './helpers.js';
import { createTestApp } from './test-app.js';

let app: INestApplication<App>;
let prisma: PrismaService;

const validBody = ownerInput;

const signUp = (body: unknown) =>
  request(app.getHttpServer())
    .post('/auth/sign-up')
    .send(body as object);

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

    const second = { ...validBody(), email: first.email.toUpperCase() };

    const res = await signUp(second).expect(409);

    expect(res.body).toMatchObject({ field: 'email' });
    expect(await prisma.business.findUnique({ where: { slug: second.business.slug } })).toBeNull();
  });

  it('answers 409 on a taken slug and creates nothing', async () => {
    const first = validBody();
    await signUp(first).expect(201);
    const second = { ...validBody(), business: { ...validBody().business, slug: first.business.slug } };

    const res = await signUp(second).expect(409);

    expect(res.body).toMatchObject({ field: 'slug' });
    expect(await prisma.user.findUnique({ where: { email: second.email } })).toBeNull();
  });

  it('stores the canonical spelling of the time zone', async () => {
    const body = validBody();
    const res = await signUp({ ...body, business: { ...body.business, timeZone: 'europe/moscow' } }).expect(201);

    expect(res.body.business.timeZone).toBe('Europe/Moscow');
  });

  it.each([
    ['an unknown time zone', { business: { timeZone: 'Moscow' } }, 'business.timeZone'],
    ['a slug with a space', { business: { slug: 'studio lena' } }, 'business.slug'],
    ['a short password', { password: 'short' }, 'password'],
    ['a malformed email', { email: 'not-an-email' }, 'email'],
    // Postgres would read it as POSIX, sign flipped.
    ['a UTC offset for a time zone', { business: { timeZone: '+03:00' } }, 'business.timeZone'],
    // Longer than the unique index can hold: a 500 from Postgres otherwise.
    ['an email over 254 characters', { email: `${'a'.repeat(64)}@${'b'.repeat(200)}.com` }, 'email'],
    // 130 characters, over 4 KiB after NFKC: PasswordHasher would throw, a 500 otherwise.
    ['a password over 4 KiB once normalized', { password: '\uFDFA'.repeat(130) }, 'password'],
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
      { content: { 'application/json': { schema: { properties?: object } } } } | undefined;
    expect(Object.keys(body?.content['application/json'].schema.properties ?? {})).toEqual(
      expect.arrayContaining(['email', 'password', 'name', 'business']),
    );
    expect(body?.content['application/json'].schema.properties).toMatchObject({
      email: { type: 'string', format: 'email' },
    });
  });

  // The front highlights the form field from `field`, so its type has to reach Orval.
  it('describes the 400 and 409 bodies', async () => {
    const { SwaggerModule, DocumentBuilder } = await import('@nestjs/swagger');
    const doc = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    type Response = { content?: Record<string, { schema: object }> };
    const schemaOf = (status: string) =>
      (doc.paths['/auth/sign-up']?.post?.responses[status] as Response | undefined)?.content?.['application/json']
        ?.schema;

    expect(schemaOf('409')).toMatchObject({
      properties: { field: { enum: ['email', 'slug'] } },
      required: expect.arrayContaining(['field', 'message']),
    });
    expect(schemaOf('400')).toMatchObject({ properties: { message: { type: 'array' } } });
  });
});
