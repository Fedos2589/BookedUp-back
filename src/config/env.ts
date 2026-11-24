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
    // Required in production; elsewhere it defaults to the Vite dev server (below).
    APP_URL: z.url().optional(),
    // Whether this process runs the notifications queue (reminders and sending). One process is enough;
    // tests turn it off.
    NOTIFICATIONS_WORKER: z.stringbool().default(true),
    // Telegram: the bot's token and username (for the t.me link) go together; the webhook secret is
    // checked on every update Telegram sends. Without the token the channel is off.
    TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
    TELEGRAM_BOT_USERNAME: z.string().min(1).optional(),
    TELEGRAM_WEBHOOK_SECRET: z.string().min(1).optional(),
    // Web Push: the three go together (`npx web-push generate-vapid-keys`); without them the channel is off.
    // The subject tells push services whom to contact: a mailto: or https URL.
    VAPID_PUBLIC_KEY: z.string().min(1).optional(),
    VAPID_PRIVATE_KEY: z.string().min(1).optional(),
    VAPID_SUBJECT: z
      .string()
      .regex(/^(mailto:\S+|https:\/\/\S+)$/)
      .optional(),
    // WhatsApp Cloud API: the access token and the sending number's id go together; without them the channel is off.
    WHATSAPP_TOKEN: z.string().min(1).optional(),
    WHATSAPP_PHONE_NUMBER_ID: z.string().min(1).optional(),
    // Resend (email): the key and the sender go together; without them the channel is off.
    RESEND_API_KEY: z.string().min(1).optional(),
    MAIL_FROM: z.string().min(1).max(320).optional(),
  })
  .refine((env) => env.SESSION_COOKIE_SECURE || env.NODE_ENV !== 'production', {
    path: ['SESSION_COOKIE_SECURE'],
    message: 'must stay true in production',
  })
  .refine((env) => (env.TELEGRAM_BOT_TOKEN === undefined) === (env.TELEGRAM_BOT_USERNAME === undefined), {
    path: ['TELEGRAM_BOT_TOKEN'],
    message: 'TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_USERNAME go together',
  })
  .refine(
    (env) =>
      [env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT].filter((v) => v === undefined).length % 3 === 0,
    { path: ['VAPID_PUBLIC_KEY'], message: 'VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT go together' },
  )
  .refine((env) => (env.WHATSAPP_TOKEN === undefined) === (env.WHATSAPP_PHONE_NUMBER_ID === undefined), {
    path: ['WHATSAPP_TOKEN'],
    message: 'WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID go together',
  })
  .refine((env) => (env.RESEND_API_KEY === undefined) === (env.MAIL_FROM === undefined), {
    path: ['RESEND_API_KEY'],
    message: 'RESEND_API_KEY and MAIL_FROM go together',
  })
  // Without it the webhook refuses every update: links would be handed out and no chat ever connected.
  .refine(
    (env) =>
      env.NODE_ENV !== 'production' ||
      env.TELEGRAM_BOT_TOKEN === undefined ||
      env.TELEGRAM_WEBHOOK_SECRET !== undefined,
    { path: ['TELEGRAM_WEBHOOK_SECRET'], message: 'must be set in production when TELEGRAM_BOT_TOKEN is set' },
  )
  // A deployment without it would hand out links to localhost without a word.
  .refine((env) => env.APP_URL !== undefined || env.NODE_ENV !== 'production', {
    path: ['APP_URL'],
    message: 'must be set in production',
  })
  .transform(({ APP_URL = 'http://localhost:5173', ...env }) => ({ ...env, APP_URL }));

export type Env = z.infer<typeof envSchema>;

// Parsed once at startup: a bad or missing variable stops the app instead of failing later.
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
