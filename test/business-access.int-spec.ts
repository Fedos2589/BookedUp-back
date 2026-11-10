import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { BusinessService } from '../src/business/business.service.js';
import { createTestApp } from './test-app.js';

let app: INestApplication<App>;

const http = () => request(app.getHttpServer());

// `name=value` of the session cookie, as a browser would send it back.
const sessionCookie = (res: request.Response) => {
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const cookie = cookies.find((c) => c.startsWith('__Host-sid='))?.split(';')[0];
  if (!cookie) throw new Error('sign-up set no session cookie');
  return cookie;
};

// A new owner with their business, signed in. Random values: test files share one database.
const signUpOwner = async () => {
  const id = randomUUID();
  const res = await http()
    .post('/auth/sign-up')
    .send({
      email: `owner-${id}@example.com`,
      password: 'correct horse battery',
      name: 'Lena',
      business: { name: 'Studio Lena', slug: `studio-lena-${id}`, timeZone: 'Europe/Moscow' },
    })
    .expect(201);
  return { cookie: sessionCookie(res), business: res.body.business as { id: string } };
};

const getBusiness = (businessId: string, cookie?: string) => {
  const req = http().get(`/businesses/${businessId}`);
  return cookie ? req.set('Cookie', cookie) : req;
};

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

describe('access to a business', () => {
  it('lets a member in: GET /businesses/:businessId answers the business and their role', async () => {
    const owner = await signUpOwner();

    await getBusiness(owner.business.id, owner.cookie)
      .expect(200)
      .expect({ ...owner.business, role: 'OWNER' });
  });

  // Stopped by the guard, before the handler: the service's own scoping is a second line, not the check.
  it("answers 403 to someone else's business, before the handler runs", async () => {
    const owner = await signUpOwner();
    const stranger = await signUpOwner();
    const handler = vi.spyOn(app.get(BusinessService), 'describe');

    try {
      await getBusiness(owner.business.id, stranger.cookie).expect(403);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      handler.mockRestore();
    }
  });

  // The same answer as for someone else's business: the response doesn't tell which ids exist.
  it('answers 403 to a business that does not exist, and to an id that is not a UUID', async () => {
    const { cookie } = await signUpOwner();

    await getBusiness(randomUUID(), cookie).expect(403);
    await getBusiness('not-a-uuid', cookie).expect(403);
  });

  it('answers 401 without a session', async () => {
    const owner = await signUpOwner();

    await getBusiness(owner.business.id).expect(401);
  });
});
