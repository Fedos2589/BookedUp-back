import { AuthenticationModule } from '@nestjs/authentication';
import { BullModule } from '@nestjs/bullmq';
import { Module, StandardSchemaValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { minutes, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';

import { AccountModule } from './account/account.module.js';
import { accountLimits } from './auth/account-limits.js';
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
    // Every route requires a signed-in user unless it is @Public(). Sessions live in
    // Postgres (PrismaSessionStore), behind an HttpOnly __Host-sid cookie.
    AuthenticationModule.forRoot({
      session: {
        absoluteTtl: '30d', // signed out after 30 days, however active
        idleTtl: '7d', // or after a week without a request
      },
    }),
    // Counted in process memory: fine for one instance; shared storage (Redis) comes
    // with the first deployment that runs several (E1).
    ThrottlerModule.forRoot([
      // Per IP address, on every route.
      { name: 'default', ttl: minutes(1), limit: 100 },
      // Per account, on routes marked @CountPerAccount() (sign-in).
      ...accountLimits,
    ]),
    PrismaModule,
    AuthModule,
    AccountModule,
  ],
  controllers: [HealthController],
  providers: [
    // Request bodies and params are validated by the zod schemas on their decorators. Here,
    // not in main.ts, so every way of starting the app (tests included) gets it.
    { provide: APP_PIPE, useValue: new StandardSchemaValidationPipe() },
    // In the root module, so it runs before the authentication guard: guessed cookies count too.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
