import { ConfigService } from '@nestjs/config';
import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';

import type { Env } from '../config/env.js';

// The languages the front has texts for (src/locales there). The users_locale_known CHECK
// lists the same two: a new language goes into both, in a migration.
export const localeSchema = z.enum(['en', 'ru']);

export type Locale = z.infer<typeof localeSchema>;

export const localeBodySchema = z.object({ locale: localeSchema });

export type LocaleBody = z.infer<typeof localeBodySchema>;

export const LOCALE_COOKIE = 'lang';

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

// The cookie the front starts in. Not HttpOnly on purpose: the page reads it before any request
// to the API, and the language is no secret. The same Secure rule as the session cookie.
@Injectable()
export class LocaleCookie {
  constructor(private readonly config: ConfigService<Env, true>) {}

  set(res: Response, locale: Locale): void {
    res.cookie(LOCALE_COOKIE, locale, {
      path: '/',
      sameSite: 'lax',
      secure: this.config.get('SESSION_COOKIE_SECURE', { infer: true }),
      maxAge: ONE_YEAR_MS,
    });
  }
}
