import { createServer } from 'node:http';
import { Writable } from 'node:stream';

import { pinoHttp } from 'pino-http';
import request from 'supertest';

import { logRedaction } from './logging.js';

// The same pino-http that nestjs-pino runs, with the app's redaction, on a bare server that sets a cookie.
async function logsOfRequest(headers: Record<string, string>): Promise<string> {
  let output = '';
  const destination = new Writable({
    write(chunk: Buffer, _encoding, done) {
      output += chunk.toString();
      done();
    },
  });
  const logger = pinoHttp({ ...logRedaction }, destination);
  const server = createServer((req, res) => {
    logger(req, res);
    res.setHeader('Set-Cookie', '__Host-sid=new-session-id; HttpOnly');
    res.end('ok');
  });
  await request(server).get('/').set(headers).expect(200);
  return output;
}

describe('log redaction', () => {
  it('keeps cookies and secret headers out of the request log', async () => {
    const logs = await logsOfRequest({
      Cookie: '__Host-sid=live-session-id',
      Authorization: 'Bearer live-token',
      'X-Telegram-Bot-Api-Secret-Token': 'live-webhook-secret',
    });

    expect(logs).toContain('[redacted]');
    for (const secret of ['live-session-id', 'new-session-id', 'live-token', 'live-webhook-secret']) {
      expect(logs).not.toContain(secret);
    }
  });
});
