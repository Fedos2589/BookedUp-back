// pino-http logs every request header and the response's Set-Cookie, so without this a live `__Host-*` session
// id and the Telegram webhook secret would land in `docker logs` on every request.
export const logRedaction = {
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'req.headers["x-telegram-bot-api-secret-token"]',
      'res.headers["set-cookie"]',
    ],
    censor: '[redacted]',
  },
};
