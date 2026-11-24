import { ConfigService } from '@nestjs/config';

import { renderInput } from './render-input.fixture.js';
import { WhatsappChannel } from './whatsapp.channel.js';
import { WhatsappClient } from './whatsapp.client.js';

const TOKEN = 'EAAG-secret-token';
const PHONE_ID = '1234567890';

const channel = () =>
  new WhatsappChannel(
    new WhatsappClient(new ConfigService({ WHATSAPP_TOKEN: TOKEN, WHATSAPP_PHONE_NUMBER_ID: PHONE_ID })),
  );

const reply = (status: number, body: object) =>
  vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { status }));

describe('WhatsappChannel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends the template of a reminder in ru to the phone', async () => {
    const fetch = reply(200, { messages: [{ id: 'wamid.1' }] });
    vi.stubGlobal('fetch', fetch);

    const result = await channel().send(
      '+79991234567',
      renderInput({ kind: 'REMINDER', locale: 'ru', offsetMinutes: 1440 }),
    );

    expect(result).toBe('sent');
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://graph.facebook.com/v21.0/${PHONE_ID}/messages`);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      to: '+79991234567',
      type: 'template',
      template: {
        name: 'bookedup_reminder_client',
        language: { code: 'ru' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Завтра' },
              { type: 'text', text: 'пт 27 нояб., 10:00' },
              { type: 'text', text: 'Anna' },
              { type: 'text', text: 'Studio' },
            ],
          },
        ],
      },
    });
  });

  it('error 131026 (the number is not on WhatsApp) → unreachable', async () => {
    vi.stubGlobal('fetch', reply(400, { error: { code: 131026, message: 'Message undeliverable' } }));
    expect(await channel().send('+79991234567', renderInput())).toBe('unreachable');
  });

  it('another error throws, to be tried again', async () => {
    vi.stubGlobal('fetch', reply(400, { error: { code: 132000, message: 'Param count mismatch' } }));
    await expect(channel().send('+79991234567', renderInput())).rejects.toThrow(/Param count mismatch/);
    vi.stubGlobal('fetch', reply(500, { error: { code: 2, message: 'Service down' } }));
    await expect(channel().send('+79991234567', renderInput())).rejects.toThrow(/Service down/);
  });

  it('a network failure throws without the token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError(`fetch failed ${TOKEN}`)));
    const error = await channel()
      .send('+79991234567', renderInput())
      .catch((e: unknown) => e as Error);
    expect((error as Error).message).not.toContain(TOKEN);
    expect((error as Error).cause).toBeUndefined();
  });
});
