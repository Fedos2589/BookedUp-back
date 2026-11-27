import { createServer } from 'node:http';
import { Writable } from 'node:stream';

import { pinoHttp } from 'pino-http';
import request from 'supertest';

import { loggerOptions } from './logging.js';

type Environment = Parameters<typeof loggerOptions>[0];

// The same pino-http that nestjs-pino runs, with the options the app builds for `env`, on a bare server that
// sets a cookie. Returns the log lines of one request.
async function logsOfRequest(path: string, headers: Record<string, string> = {}, env: Environment = 'production') {
  let output = '';
  const destination = new Writable({
    write(chunk: Buffer, _encoding, done) {
      output += chunk.toString();
      done();
    },
  });
  // Tests log at `warn`; the request lines are `info`.
  const logger = pinoHttp({ ...loggerOptions(env), level: 'info', transport: undefined }, destination);
  const server = createServer((req, res) => {
    logger(req, res);
    res.setHeader('Set-Cookie', '__Host-sid=new-session-id; HttpOnly');
    res.end('ok');
  });
  await request(server).get(path).set(headers).expect(200);
  return output;
}

describe('log redaction', () => {
  it.each<Environment>(['development', 'test', 'production'])(
    'keeps cookies and secret headers out in %s',
    async (env) => {
      const logs = await logsOfRequest(
        '/',
        {
          Cookie: '__Host-sid=live-session-id',
          Authorization: 'Bearer live-token',
          'X-Telegram-Bot-Api-Secret-Token': 'live-webhook-secret',
        },
        env,
      );

      for (const secret of ['live-session-id', 'new-session-id', 'live-token', 'live-webhook-secret']) {
        expect(logs).not.toContain(secret);
      }
    },
  );

  it('keeps a header nobody listed out of the log, and the ones that help debugging in', async () => {
    const logs = await logsOfRequest('/', { 'X-Some-New-Secret': 'live-new-secret', 'User-Agent': 'probe-agent' });

    expect(logs).not.toContain('live-new-secret');
    expect(logs).toContain('probe-agent');
  });

  it.each([
    ['/invitations/LIVE-INVITE-TOKEN/accept', '/invitations/[redacted]/accept'],
    ['/invitations/LIVE-INVITE-TOKEN', '/invitations/[redacted]'],
    ['/public/bookings/LIVE-MANAGE-TOKEN', '/public/bookings/[redacted]'],
    ['/public/bookings/LIVE-MANAGE-TOKEN/cancel?x=1', '/public/bookings/[redacted]/cancel?x=1'],
  ])('hides the token in %s', async (path, logged) => {
    const logs = await logsOfRequest(path);

    expect(logs).not.toMatch(/LIVE-[A-Z]+-TOKEN/);
    expect(logs).toContain(`"url":"${logged}"`);
  });

  it('keeps the id of an invitation a manager revokes: it is not a secret', async () => {
    const logs = await logsOfRequest('/businesses/b1/invitations/0198-an-invitation-id');

    expect(logs).toContain('"url":"/businesses/b1/invitations/0198-an-invitation-id"');
  });

  it('leaves the other paths as they are', async () => {
    const logs = await logsOfRequest('/public/businesses/some-slug/slots');

    expect(logs).toContain('"url":"/public/businesses/some-slug/slots"');
  });
});
