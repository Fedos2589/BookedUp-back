import { z } from 'zod';

// PasswordHasher refuses more than 4 KiB after NFKC; a character can grow there, so the
// length limit alone doesn't keep it from throwing.
const PASSWORD_MAX_BYTES = 4096;

// Trimmed and lowercased like the stored one, so sign-in is case-insensitive.
// .pipe hides z.email()'s format from the request schema; meta puts it back for Orval.
export const emailSchema = z.string().trim().max(254).toLowerCase().meta({ format: 'email' }).pipe(z.email());

// No minimum here: sign-in must still accept a password set under an older rule.
export const passwordSchema = z
  .string()
  .max(256)
  .refine((p) => Buffer.byteLength(p.normalize('NFKC'), 'utf8') <= PASSWORD_MAX_BYTES, 'Password is too long');

export const signInSchema = z.object({ email: emailSchema, password: passwordSchema });

export type SignInInput = z.infer<typeof signInSchema>;
