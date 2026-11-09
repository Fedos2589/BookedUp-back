import { StandardSchemaValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module.js';
import type { Env } from './config/env.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  // Request bodies and params are validated by the zod schemas on their decorators.
  app.useGlobalPipes(new StandardSchemaValidationPipe());

  // The front generates its API client from /api/docs-json (Orval).
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('BookedUp API').setVersion('0.0.1').build(),
  );
  SwaggerModule.setup('api/docs', app, document);

  const config = app.get<ConfigService<Env, true>>(ConfigService);
  await app.listen(config.get('PORT', { infer: true }));
}
await bootstrap();
