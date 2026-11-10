import { BullModule } from '@nestjs/bullmq';
import { Module, StandardSchemaValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_PIPE } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';

import { AuthModule } from './auth/auth.module.js';
import { type Env, validateEnv } from './config/env.js';
import { HealthController } from './health/health.controller.js';
import { PrismaModule } from './prisma/prisma.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const env = config.get('NODE_ENV', { infer: true });
        return {
          pinoHttp:
            env === 'development'
              ? { transport: { target: 'pino-pretty' } }
              : // Tests keep warnings and errors: an unexpected 500 shows its stack, not just the status.
                { level: env === 'test' ? 'warn' : 'info' },
        };
      },
    }),
    // Shared Redis connection for queues (reminders, notifications). No queue is registered yet.
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        connection: { url: config.get('REDIS_URL', { infer: true }) },
      }),
    }),
    PrismaModule,
    AuthModule,
  ],
  controllers: [HealthController],
  providers: [
    // Request bodies and params are validated by the zod schemas on their decorators. Here,
    // not in main.ts, so every way of starting the app (tests included) gets it.
    { provide: APP_PIPE, useValue: new StandardSchemaValidationPipe() },
  ],
})
export class AppModule {}
