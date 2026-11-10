import { emailSchema } from './credentials.schema.js';

// The address a request body names, spelled as sign-in looks it up, or '' — the key of
// the per-account rate limits. The throttler runs before validation, so the body is
// unchecked; parsing it with the sign-in schema keeps one spelling of an address.
export function accountEmail(req: { body?: { email?: unknown } }): string {
  const parsed = emailSchema.safeParse(req.body?.email);
  return parsed.success ? parsed.data : '';
}
