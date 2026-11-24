import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { createTestApp } from './test-app.js';

let app: INestApplication<App>;

beforeAll(async () => {
  app = await createTestApp({ throttle: true });
});

afterAll(async () => {
  await app.close();
});

describe('POST /public/businesses/:slug/bookings limit', () => {
  // Every attempt counts, whatever it ends in: an unknown slug is the cheapest one.
  const attempt = () =>
    request(app.getHttpServer()).post('/public/businesses/no-such-business-at-all/bookings').send({
      startsAt: '2030-01-08T07:00:00.000Z',
      endsAt: '2030-01-08T08:00:00.000Z',
      name: 'Vera',
      phone: '+79991234567',
    });

  it('lets 10 attempts an hour from one address through and stops the 11th with 429', async () => {
    for (let i = 0; i < 10; i++) await attempt().expect(404);

    await attempt().expect(429);
  });
});

describe('PUT /public/bookings/:token/push limit', () => {
  // An unknown token is the cheapest attempt; every one counts.
  const attempt = () =>
    request(app.getHttpServer())
      .put(`/public/bookings/${'A'.repeat(43)}/push`)
      .send({
        subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'p', auth: 'a' } },
        locale: 'en',
      });

  it('lets 10 attempts an hour from one address through and stops the 11th with 429', async () => {
    // Web Push is off in this app, so a token is answered 404 channelOff; the limit counts either way.
    for (let i = 0; i < 10; i++) await attempt().expect(404);

    await attempt().expect(429);
  });
});
