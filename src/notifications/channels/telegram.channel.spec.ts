import { ConfigService } from '@nestjs/config';

import { TelegramChannel } from './telegram.channel.js';
import { TelegramClient } from './telegram.client.js';

const TOKEN = '123:secret-token';

const channel = () => new TelegramChannel(new TelegramClient(new ConfigService({ TELEGRAM_BOT_TOKEN: TOKEN })));

const reply = (status: number, body: object) =>
  vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));

describe('TelegramChannel', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the text to the chat through the bot', async () => {
    const fetch = reply(200, { ok: true, result: { message_id: 1 } });
    vi.stubGlobal('fetch', fetch);

    const result = await channel().send('555', { subject: 'Booked', text: 'Booked: Fri 27 Nov' });

    expect(result).toBe('sent');
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(JSON.parse(init.body as string)).toEqual({ chat_id: '555', text: 'Booked: Fri 27 Nov' });
  });

  it('403 (the bot is blocked) → unreachable', async () => {
    vi.stubGlobal('fetch', reply(403, { ok: false, error_code: 403, description: 'Forbidden: bot was blocked' }));
    expect(await channel().send('555', { subject: 's', text: 't' })).toBe('unreachable');
  });

  it('400 «chat not found» → unreachable', async () => {
    vi.stubGlobal('fetch', reply(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' }));
    expect(await channel().send('555', { subject: 's', text: 't' })).toBe('unreachable');
  });

  it('another 400 is our bug: it throws, not switches the chat off', async () => {
    vi.stubGlobal('fetch', reply(400, { ok: false, error_code: 400, description: 'Bad Request: text is empty' }));
    await expect(channel().send('555', { subject: 's', text: '' })).rejects.toThrow(/text is empty/);
  });

  it('429 and 5xx throw, to be tried again', async () => {
    vi.stubGlobal('fetch', reply(429, { ok: false, error_code: 429, description: 'Too Many Requests' }));
    await expect(channel().send('555', { subject: 's', text: 't' })).rejects.toThrow(/Too Many Requests/);
    vi.stubGlobal('fetch', reply(500, { ok: false, error_code: 500, description: 'Internal Server Error' }));
    await expect(channel().send('555', { subject: 's', text: 't' })).rejects.toThrow(/Internal Server Error/);
  });

  it('never puts the token in an error, a network one included', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError(`fetch failed: https://api.telegram.org/bot${TOKEN}`)),
    );
    const error = await channel()
      .send('555', { subject: 's', text: 't' })
      .catch((e: unknown) => e as Error);
    expect((error as Error).message).not.toContain(TOKEN);
    expect((error as Error).cause).toBeUndefined();
  });
});
