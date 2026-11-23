import { SignInService } from '@nestjs/authentication';
import { Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';

import { LocaleCookie } from './locale.js';
import type { User } from './user.schema.js';

// Signs a user in right after their account was created, and sets the language cookie with it:
// one place for both, so a new way to create an account cannot forget the cookie.
@Injectable()
export class SessionStarter {
  private readonly logger = new Logger(SessionStarter.name);

  constructor(
    private readonly signInService: SignInService,
    private readonly localeCookie: LocaleCookie,
  ) {}

  // The account is committed by now. If the session fails, a 500 would make the person retry
  // and meet "email already registered"; so the caller answers 201 without a session cookie, and
  // the front finds no session (GET /me 401) and sends them to sign in.
  async start(res: Response, user: User, failure: string): Promise<void> {
    this.localeCookie.set(res, user.locale);
    await this.signInService
      .signIn(user.id, { method: 'password' })
      .catch((error: unknown) => this.logger.warn({ err: error, userId: user.id }, failure));
  }
}
