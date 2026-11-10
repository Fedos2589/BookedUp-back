import { z } from 'zod';

import { conflictErrorSchema } from '../common/api-errors.js';
import { canonicalTimeZone } from '../common/time-zone.js';
import { emailSchema, passwordSchema } from './credentials.schema.js';

// The format the database enforces too (CHECK businesses_slug_format).
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Parsed once here; the service trusts it. Email and slug arrive lowercased and the time
// zone canonical, so the database's CHECKs only ever back this up. Every string has a
// length limit: a too long one is a 400 here, not a 500 from the unique index.
export const signUpSchema = z.object({
  email: emailSchema,
  password: passwordSchema.min(8),
  name: z.string().trim().min(1).max(100),
  business: z.object({
    name: z.string().trim().min(1).max(100),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .max(63)
      .regex(SLUG_PATTERN, 'Use latin letters, digits and single hyphens'),
    timeZone: z
      .string()
      .max(64)
      .transform((zone, ctx) => {
        const canonical = canonicalTimeZone(zone);
        if (canonical) return canonical;
        ctx.addIssue({ code: 'custom', message: 'Unknown IANA time zone' });
        return z.NEVER;
      }),
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

export const signUpConflictSchema = conflictErrorSchema(['email', 'slug']);

export type SignUpConflict = z.infer<typeof signUpConflictSchema>;
