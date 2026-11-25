import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

import type { Env } from '../config/env.js';

// The value of one cookie of a `Cookie` header; the app has no cookie-parser.
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || undefined;
  }
  return undefined;
}

const LOGIN_TTL_MS = 10 * 60 * 1000;

// The client's cookies on the public pages (back-auth: `__Host-` + Secure, plain names with
// SESSION_COOKIE_SECURE=false). `cl` is the browser's half of a login: only this browser can take
// the session the Telegram confirmation opens.
@Injectable()
export class ClientCookies {
  private readonly secure: boolean;

  constructor(config: ConfigService<Env, true>) {
    this.secure = config.get('SESSION_COOKIE_SECURE', { infer: true });
  }

  get browserName(): string {
    return this.secure ? '__Host-cl' : 'cl';
  }

  browserOf(req: Request): string | undefined {
    return readCookie(req.headers.cookie, this.browserName);
  }

  setBrowser(res: Response, secret: string): void {
    res.cookie(this.browserName, secret, {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'lax',
      path: '/',
      maxAge: LOGIN_TTL_MS,
    });
  }
}

export { LOGIN_TTL_MS };
