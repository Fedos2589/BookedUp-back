import { PasswordHasher } from '@nestjs/authentication';
import { type INestApplication, StandardSchemaValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { inject } from 'vitest';

// The whole app against the integration test database, with a cheap password hasher.
// AppModule is imported only after DATABASE_URL points at the test container: the config
// module reads the environment when it is imported.
export async function createTestApp(): Promise<INestApplication> {
  process.env.DATABASE_URL = inject('databaseUrl');
  process.env.REDIS_URL ??= 'redis://localhost:6379';

  const { AppModule } = await import('../src/app.module.js');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PasswordHasher)
    .useValue(new PasswordHasher({ logN: 10 }))
    .compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(new StandardSchemaValidationPipe());
  await app.init();
  return app;
}
