import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { createTestApp } from './test-app.js';

// Behind one reverse proxy (TRUST_PROXY=1), clients are told apart by X-Forwarded-For.
// Set before AppModule is first imported in this file: the config is read then.
process.env.TRUST_PROXY = '1';

let app: INestApplication<App>;
const email = () => `target-${randomUUID()}@example.com`;
const signInFrom = (ip: string, target: string) =>
  request(app.getHttpServer())
    .post('/auth/sign-in')
    .set('X-Forwarded-For', ip)
    .send({ email: target, password: 'guess' });

beforeAll(async () => {
  app = await createTestApp({ throttle: true });
});

afterAll(async () => {
  await app.close();
  delete process.env.TRUST_PROXY;
});

describe('rate limits behind a proxy', () => {
  it('gives every client its own counter: one guessing does not lock the account for others', async () => {
    const target = email();
    for (let i = 0; i < 5; i++) await signInFrom('203.0.113.1', target).expect(401);
    await signInFrom('203.0.113.1', target).expect(429);

    await signInFrom('198.51.100.7', target).expect(401);
  });

  // Guessing at one account from many addresses: each stays under its own limit, the
  // account's own limit stops them all.
  it('stops guessing at one account from many addresses after 50 an hour', async () => {
    const target = email();
    for (let i = 1; i <= 50; i++) await signInFrom(`10.0.${i}.1`, target).expect(401);

    await signInFrom('10.0.99.1', target).expect(429);
  });
});
