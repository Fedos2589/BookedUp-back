import type { INestApplication } from '@nestjs/common';

// What every way of starting the app needs beyond AppModule: main.ts and the test app
// both call it, so tests run with what production runs.
export function configureApp<T extends INestApplication>(app: T): T {
  // Refuses state-changing requests from other sites' pages (403) on every route, before
  // the handler: a cross-site sign-up would otherwise create the account before
  // SignInService refused to sign it in. The front calls the API through its dev-server
  // proxy, same origin, so no trustedOrigins.
  return app.enableCsrfProtection();
}
