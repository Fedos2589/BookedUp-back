import type { Options } from 'pino-http';
import { stdSerializers } from 'pino-http';

import type { Env } from './config/env.js';

// pino-http logs every request header, the URL and the response's Set-Cookie, so left alone a live `__Host-*`
// session id, the Telegram webhook secret and the bearer tokens in paths would land in `docker logs`.

// Only these request headers are logged: a new secret header added later stays out of the log by default.
const LOGGED_HEADERS = new Set([
  'host',
  'origin',
  'referer',
  'user-agent',
  'accept-language',
  'content-type',
  'content-length',
  'x-forwarded-for',
  'x-forwarded-proto',
]);

// These paths carry a token that is a key by itself (booking management link, invitation link). The database keeps
// only its hash, so the log must not keep it either.
const TOKEN_IN_PATH = /\/(invitations|public\/bookings)\/[^/?]+/;

type SerializedRequest = ReturnType<typeof stdSerializers.req>;

function serializeRequest(req: Parameters<typeof stdSerializers.req>[0]): SerializedRequest {
  const logged = stdSerializers.req(req);
  logged.url = logged.url.replace(TOKEN_IN_PATH, '/$1/[redacted]');
  logged.headers = Object.fromEntries(Object.entries(logged.headers).filter(([name]) => LOGGED_HEADERS.has(name)));
  return logged;
}

export function loggerOptions(env: Env['NODE_ENV']): Options {
  return {
    serializers: { req: serializeRequest },
    redact: { paths: ['res.headers["set-cookie"]'], censor: '[redacted]' },
    ...(env === 'development'
      ? { transport: { target: 'pino-pretty' } }
      : // Tests keep warnings and errors: an unexpected 500 shows its stack, not just the status.
        { level: env === 'test' ? 'warn' : 'info' }),
  };
}
