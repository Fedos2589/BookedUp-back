import { PasswordHasher } from '@nestjs/authentication';
import type { INestApplication, Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getStorageToken, type ThrottlerStorage } from '@nestjs/throttler';
import { inject } from 'vitest';

import { configureApp } from '../src/app.setup.js';

// Counts nothing: suites sign up many owners from one address. The rate-limit tests ask
// for the real counters with { throttle: true }.
const noLimits: ThrottlerStorage = {
  increment: async () => ({ totalHits: 1, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 }),
};

// The whole app against the integration test database, with a cheap password hasher.
// `controllers` adds test-only routes (what a route with no check gets, say).
// AppModule is imported only after DATABASE_URL points at the test container: the config
// module reads the environment when it is imported.
// `secureCookie` is set here, not left to the developer's .env: with SESSION_COOKIE_SECURE=false
// there the cookie would be `sid` and every test looking for `__Host-sid` would fail.
export async function createTestApp({
  throttle = false,
  controllers = [] as Type[],
  secureCookie = true,
} = {}): Promise<INestApplication> {
  process.env.DATABASE_URL = inject('databaseUrl');
  process.env.REDIS_URL ??= 'redis://localhost:6379';
  process.env.SESSION_COOKIE_SECURE = String(secureCookie);

  const { AppModule } = await import('../src/app.module.js');
  let builder = Test.createTestingModule({ imports: [AppModule], controllers })
    .overrideProvider(PasswordHasher)
    .useValue(new PasswordHasher({ logN: 10 }));
  if (!throttle) builder = builder.overrideProvider(getStorageToken()).useValue(noLimits);
  const moduleRef = await builder.compile();

  const app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
  await app.init();
  return app;
}
