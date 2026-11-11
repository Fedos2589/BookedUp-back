import { z } from 'zod';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.url(),
    REDIS_URL: z.url(),
    // How many reverse proxies stand in front of the API (nginx, a load balancer): req.ip,
    // and so every rate limit, is read that many hops back in X-Forwarded-For. A count,
    // not "true": trusting every hop lets a client pick its own IP and reset its limits.
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    // `false` only for development over plain HTTP from another host (a phone on the LAN):
    // browsers drop a Secure cookie there, and without Secure it is `sid`, not `__Host-sid`.
    SESSION_COOKIE_SECURE: z.stringbool().default(true),
    // The front's address, for the links the API hands out (an invitation: <APP_URL>/invite/<token>).
    APP_URL: z.url().default('http://localhost:5173'),
  })
  .refine((env) => env.SESSION_COOKIE_SECURE || env.NODE_ENV !== 'production', {
    path: ['SESSION_COOKIE_SECURE'],
    message: 'must stay true in production',
  });

export type Env = z.infer<typeof envSchema>;

// Parsed once at startup: a bad or missing variable stops the app instead of failing later.
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
