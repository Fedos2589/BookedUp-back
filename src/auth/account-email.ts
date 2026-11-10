// The address a request body names, as the stored one is spelled, or '' — for the
// per-account rate limit. The throttler runs before validation, so the body is unchecked.
export function accountEmail(req: { body?: { email?: unknown } }): string {
  const email = req.body?.email;
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}
