import { AuthenticationRegistry, SessionCookieProvider, type SessionRecord } from '@nestjs/authentication';
import { Injectable } from '@nestjs/common';

import type { AuthUser } from './auth-types.js';

// Turns the session cookie into the signed-in user. PrismaSessionStore already read the
// user with the session (`extra`); a deleted user takes their sessions with them
// (ON DELETE CASCADE), so there is nothing else to check here.
@Injectable()
export class SessionAuth extends SessionCookieProvider<AuthUser> {
  constructor(registry: AuthenticationRegistry) {
    super();
    registry.registerProvider(this);
  }

  protected validate(session: SessionRecord): AuthUser | null {
    return session.extra ?? null;
  }
}
