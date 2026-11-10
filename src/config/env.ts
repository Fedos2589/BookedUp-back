import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  // How many reverse proxies stand in front of the API (nginx, a load balancer): req.ip,
  // and so every rate limit, is read that many hops back in X-Forwarded-For. A count,
  // not "true": trusting every hop lets a client pick its own IP and reset its limits.
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
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
