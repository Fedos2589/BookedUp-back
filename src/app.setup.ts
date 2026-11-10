import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';

import type { Env } from './config/env.js';

// What every way of starting the app needs beyond AppModule: main.ts and the test app
// both call it, so tests run with what production runs.
export function configureApp<T extends NestExpressApplication>(app: T): T {
  // req.ip, which every rate limit counts by, is the client's address only when Express
  // knows how many proxies to skip in X-Forwarded-For; otherwise, behind nginx, every
  // client would share the proxy's counters.
  app.set('trust proxy', app.get<ConfigService<Env, true>>(ConfigService).get('TRUST_PROXY', { infer: true }));

  // Refuses state-changing requests from other sites' pages (403) on every route, before
  // the handler: a cross-site sign-up would otherwise create the account before
  // SignInService refused to sign it in. The front calls the API through its dev-server
  // proxy, same origin, so no trustedOrigins.
  return app.enableCsrfProtection();
}
