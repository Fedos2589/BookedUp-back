import { ConfigService } from '@nestjs/config';

import { messageFor } from '../messages.js';
import { EmailChannel } from './email.channel.js';
import { renderInput } from './render-input.fixture.js';

const KEY = 're_secret-key';
const FROM = 'BookedUp <no-reply@example.com>';

const channel = () => new EmailChannel(new ConfigService({ RESEND_API_KEY: KEY, MAIL_FROM: FROM }));

const reply = (status: number, body: object = {}) =>
  vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { status }));

describe('EmailChannel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('posts the subject and text to Resend, from the configured sender, with the key in the header', async () => {
    const fetch = reply(200, { id: 'email-1' });
    vi.stubGlobal('fetch', fetch);
    const input = renderInput({ locale: 'ru' });

    const result = await channel().send('anna@example.com', input);

    expect(result).toBe('sent');
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    const { subject, text } = messageFor(input);
    expect(JSON.parse(init.body as string)).toEqual({ from: FROM, to: 'anna@example.com', subject, text });
  });

  it('422 about the recipient → unreachable', async () => {
    vi.stubGlobal('fetch', reply(422, { name: 'validation_error', message: 'Invalid `to` field.' }));
    expect(await channel().send('nobody@example.invalid', renderInput())).toBe('unreachable');
  });

  it('422 about anything else (our sender, our body) throws: it is ours to fix, not the client’s address to lose', async () => {
    vi.stubGlobal('fetch', reply(422, { name: 'invalid_from_address', message: 'Invalid `from` field.' }));
    await expect(channel().send('anna@example.com', renderInput())).rejects.toThrow(/422/);
    vi.stubGlobal('fetch', reply(422, 'not json' as unknown as object));
    await expect(channel().send('anna@example.com', renderInput())).rejects.toThrow(/422/);
  });

  it('429 and 5xx throw, to be tried again', async () => {
    vi.stubGlobal('fetch', reply(429, { message: 'Too many requests' }));
    await expect(channel().send('anna@example.com', renderInput())).rejects.toThrow(/429/);
    vi.stubGlobal('fetch', reply(500, { message: 'Service down' }));
    await expect(channel().send('anna@example.com', renderInput())).rejects.toThrow(/500/);
  });

  it('no answer in time → unknown: the mail may be out, and is not sent again', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError')));
    expect(await channel().send('anna@example.com', renderInput())).toBe('unknown');
  });

  it('a network failure throws without the key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError(`fetch failed ${KEY}`)));
    const error = await channel()
      .send('anna@example.com', renderInput())
      .catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(KEY);
    expect((error as Error).cause).toBeUndefined();
  });
});
