import { z } from 'zod';

import { isTimeZone } from '../common/time-zone.js';

// The format the database enforces too (CHECK businesses_slug_format).
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Parsed once here; the service trusts it. Email and slug arrive lowercased, so the
// database's lowercase CHECKs only ever back this up.
export const signUpSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(8).max(256),
  name: z.string().trim().min(1).max(100),
  business: z.object({
    name: z.string().trim().min(1).max(100),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .max(63)
      .regex(SLUG_PATTERN, 'Use latin letters, digits and single hyphens'),
    timeZone: z.string().refine(isTimeZone, 'Unknown IANA time zone'),
  }),
});

export type SignUpInput = z.infer<typeof signUpSchema>;

export const signUpResultSchema = z.object({
  user: z.object({ id: z.uuid(), email: z.email(), name: z.string() }),
  business: z.object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    timeZone: z.string(),
  }),
});

export type SignUpResult = z.infer<typeof signUpResultSchema>;
