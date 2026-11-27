import { ConfigService } from '@nestjs/config';

import { Mailer } from './mailer.js';

const KEY = 're_secret-key';
const FROM = 'BookedUp <no-reply@example.com>';

const mailer = (env: Record<string, string> = { RESEND_API_KEY: KEY, MAIL_FROM: FROM }) =>
  new Mailer(new ConfigService(env));

const mail = { to: 'anna@example.com', subject: 'Hello', text: 'Body' };

const reply = (status: number, body: object = {}) =>
  vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { status }));

describe('Mailer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('posts the subject and text to Resend, from the configured sender, with the key in the header', async () => {
    const fetch = reply(200, { id: 'email-1' });
    vi.stubGlobal('fetch', fetch);

    const result = await mailer().send(mail);

    expect(result).toBe('sent');
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(init.body as string)).toEqual({ from: FROM, ...mail });
  });

  it('422 about the recipient → unreachable', async () => {
    vi.stubGlobal('fetch', reply(422, { name: 'validation_error', message: 'Invalid `to` field.' }));
    expect(await mailer().send(mail)).toBe('unreachable');
  });

  it('422 about anything else (our sender, our body) throws: it is ours to fix, not the address to lose', async () => {
    vi.stubGlobal('fetch', reply(422, { name: 'invalid_from_address', message: 'Invalid `from` field.' }));
    await expect(mailer().send(mail)).rejects.toThrow(/422/);
    vi.stubGlobal('fetch', reply(422, 'not json' as unknown as object));
    await expect(mailer().send(mail)).rejects.toThrow(/422/);
  });

  it('429 and 5xx throw, to be tried again', async () => {
    vi.stubGlobal('fetch', reply(429, { message: 'Too many requests' }));
    await expect(mailer().send(mail)).rejects.toThrow(/429/);
    vi.stubGlobal('fetch', reply(500, { message: 'Service down' }));
    await expect(mailer().send(mail)).rejects.toThrow(/500/);
  });

  it('no answer in time → unknown: the mail may be out, and is not sent again', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError')));
    expect(await mailer().send(mail)).toBe('unknown');
  });

  it('a network failure throws without the key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError(`fetch failed ${KEY}`)));
    const error = await mailer()
      .send(mail)
      .catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(KEY);
    expect((error as Error).cause).toBeUndefined();
  });

  it('is on only with the key and the sender; send without them throws', async () => {
    expect(mailer().isOn()).toBe(true);
    expect(mailer({}).isOn()).toBe(false);
    await expect(mailer({}).send(mail)).rejects.toThrow(/not configured/);
  });
});
